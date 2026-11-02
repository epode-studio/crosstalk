// The relay, as a Cloudflare Worker.
//
// Why this exists: two machines behind routers can only meet somewhere they can
// both reach outbound. That is a property of NAT, not a design choice, so every
// system of this kind has a rendezvous point. What a Worker changes is who pays
// for it. Idle connections hibernate, the free tier fails closed rather than
// billing, and there is no server to run.
//
// What it can see: which fingerprints talk to each other, how big the messages
// are, when they arrive, and who is in which room. Never any content, because
// everything in `body` is already sealed with a key it does not have.
//
// One difference from the self-hosted relay in relay/: there is no custom
// encrypted link layer here. That layer exists to hide metadata from anyone
// watching a plaintext ws:// connection, and a Worker is always wss://, so TLS
// already does it.

import * as St from "./streams.ts"

export interface Env {
  MAILBOX: DurableObjectNamespace
  ROOM: DurableObjectNamespace
  INVITES: DurableObjectNamespace
  STREAM_POOL: DurableObjectNamespace
  RELAY_PUBKEY?: string
  /** Stream allowance overrides (streams.ts limits), for tests. */
  STREAM_DAY_FRAMES?: string
  STREAM_DAY_BYTES?: string
  STREAM_BURST_FRAMES?: string
  STREAM_BURST_BYTES?: string
  STREAM_BURST_MS?: string
  STREAM_POOL_FRAMES?: string
  /** "1" only under the local test (worker/test/worker.sh): a route listing an object's storage keys. */
  TEST_HOOKS?: string
}

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } })

const GUID_RE = /^[0-9a-f-]{4,64}$/i

export default {
  async fetch(req: Request, env: Env): Promise<Response> {
    const url = new URL(req.url)

    if (url.pathname === "/health") return json({ ok: true, worker: true })
    if (url.pathname === "/pubkey") return json({ pub: env.RELAY_PUBKEY ?? "" })

    // A slot is public and allocated here. Only the words are secret, which is
    // what stops anyone deriving the phrase from something the relay can see.
    if (url.pathname === "/slot" && req.method === "POST") {
      for (let attempt = 0; attempt < 8; attempt++) {
        const slot = String(Math.floor(Math.random() * 9000) + 1000)
        const taken = await env.INVITES.get(env.INVITES.idFromName(slot)).fetch(
          new Request("https://do/claim", { method: "POST" }),
        )
        if (taken.ok) return json({ slot })
      }
      return json({ error: "no free slot, try again" }, 503)
    }

    const invite = url.pathname.match(/^\/invite\/([A-Za-z0-9]{1,32})$/)
    if (invite) {
      const id = env.INVITES.idFromName(invite[1])
      return env.INVITES.get(id).fetch(req)
    }

    if (url.pathname === "/ws") {
      const fp = url.searchParams.get("fp") ?? ""
      if (!GUID_RE.test(fp.replace(/-/g, "")) || fp.length > 64) return json({ error: "bad fp" }, 400)
      const id = env.MAILBOX.idFromName(fp)
      return env.MAILBOX.get(id).fetch(req)
    }

    // Tests only: what an object has in storage, to show stream frames leave nothing there.
    if (url.pathname === "/__test/keys" && env.TEST_HOOKS === "1") {
      if (url.searchParams.get("pool")) return env.STREAM_POOL.get(env.STREAM_POOL.idFromName("global")).fetch("https://do/__keys")
      return env.MAILBOX.get(env.MAILBOX.idFromName(url.searchParams.get("fp") ?? "")).fetch("https://do/__keys")
    }

    // Anything a client sends to another fingerprint or a room is routed here.
    if (url.pathname === "/route") {
      const to = url.searchParams.get("to") ?? ""
      const kind = url.searchParams.get("kind") ?? "peer"
      const ns = kind === "room" ? env.ROOM : env.MAILBOX
      return ns.get(ns.idFromName(to)).fetch(req)
    }

    return new Response("crosstalk relay", { status: 200 })
  },
}

// --- one mailbox per identity --------------------------------------------------

export class Mailbox {
  constructor(
    private state: DurableObjectState,
    private env: Env,
  ) {}

  async fetch(req: Request): Promise<Response> {
    const url = new URL(req.url)

    if (url.pathname === "/route") {
      const frame = await req.json()
      const sent = this.broadcast(frame)
      if (!sent) await this.hold(frame)
      return json({ delivered: sent })
    }

    // A stream frame from another mailbox: to whoever is connected now, or to
    // nobody. Never held, never written.
    if (url.pathname === "/stream") {
      const sent = this.broadcast(await req.json())
      return new Response(sent ? "1" : "0")
    }

    if (url.pathname === "/__keys" && this.env.TEST_HOOKS === "1")
      return json({ keys: [...(await this.state.storage.list()).keys()] })

    if (req.headers.get("upgrade") !== "websocket") return json({ error: "expected a websocket" }, 400)

    const pair = new WebSocketPair()
    const [client, server] = Object.values(pair) as [WebSocket, WebSocket]
    // Hibernation: the object can be evicted between messages and the socket
    // survives, which is what makes an idle connection almost free.
    this.state.acceptWebSocket(server)
    const fp = url.searchParams.get("fp") ?? ""
    server.serializeAttachment({ fp })
    // As relay/relay.ts does, so the client streams a shared server's frames
    // live (and knows the terms) rather than as stored sends. No signature:
    // TLS is what authenticates a Worker.
    server.send(JSON.stringify({ t: "ready", fingerprint: fp, streams: 1, streamAllowance: St.advertised(St.limits(this.env as any)) }))
    await this.drain(server)
    return new Response(null, { status: 101, webSocket: client })
  }

  async webSocketMessage(ws: WebSocket, raw: string | ArrayBuffer) {
    let f: any
    try {
      f = JSON.parse(typeof raw === "string" ? raw : new TextDecoder().decode(raw))
    } catch {
      return
    }

    if (f?.t === "ping") return ws.send(JSON.stringify({ t: "pong" }))

    if (f?.t === "stream") return this.stream(ws, f)

    if (f?.t === "send" && typeof f.to === "string" && typeof f.body === "string") {
      if (f.body.length > 1 << 20) return ws.send(JSON.stringify({ t: "error", message: "too large" }))
      const from = (ws.deserializeAttachment() as any)?.fp ?? ""
      const ns = this.env.MAILBOX
      await ns
        .get(ns.idFromName(f.to))
        .fetch("https://do/route", {
          method: "POST",
          body: JSON.stringify({ t: "deliver", from, body: f.body, id: f.id }),
        })
      return ws.send(JSON.stringify({ t: "ack", id: f.id }))
    }

    if (typeof f?.t === "string" && f.t.startsWith("room_")) {
      const ns = this.env.ROOM
      const from = (ws.deserializeAttachment() as any)?.fp ?? ""
      const res = await ns
        .get(ns.idFromName(String(f.roomId ?? f.id ?? "")))
        .fetch("https://do/room", { method: "POST", body: JSON.stringify({ ...f, from }) })
      const out = await res.text()
      if (out) ws.send(out)
    }
  }

  async webSocketClose(ws: WebSocket) {
    try {
      ws.close()
    } catch {}
    // The last socket going takes the snapshot with it, so this is when the
    // day so far goes to storage: once per connection that streamed at all.
    if (this.allowance?.unsaved && !this.state.getWebSockets().some((s) => s !== ws)) await this.saveAllowance()
  }

  // --- live stream frames (streams.ts) --------------------------------------------
  //
  // Per frame this costs one incoming WebSocket message here (billed 1:20) and
  // one request to the recipient's mailbox. Nothing is written: the count is
  // in memory, mirrored onto the sender's socket attachment (which survives
  // hibernation and is not storage), and saved now and then.

  private allowance?: St.Allowance
  private loading?: Promise<St.Allowance>
  /** One after another, so frames leave in the order they came (the share layer numbers them). */
  private chain: Promise<unknown> = Promise.resolve()
  /** One stub per recipient: requests through one stub arrive in the order sent. */
  private stubs = new Map<string, DurableObjectStub>()
  /** A recipient found offline is not asked again for a few seconds; frames for them are dropped here. */
  private offline = new Map<string, number>()
  private toldOffline = new Set<string>()
  /** Error frames already sent, so a refused stream hears it once (per socket, reason and day or window). */
  private told = new WeakMap<WebSocket, Set<string>>()
  private poolBackoff = 0

  private tellOnce(ws: WebSocket, key: string, frame: unknown) {
    let s = this.told.get(ws)
    if (!s) this.told.set(ws, (s = new Set()))
    if (s.has(key)) return
    s.add(key)
    try {
      ws.send(JSON.stringify(frame))
    } catch {}
  }

  private limits() {
    return St.limits(this.env as any)
  }

  private async loadAllowance(): Promise<St.Allowance> {
    if (this.allowance) return this.allowance
    this.loading ??= (async () => {
      const saved = await this.state.storage.get<St.Snapshot>("stream")
      const onSockets = this.state.getWebSockets().map((s) => (s.deserializeAttachment() as any)?.stream as St.Snapshot | undefined)
      return (this.allowance = new St.Allowance(this.limits(), Date.now(), [saved, ...onSockets]))
    })()
    return this.loading
  }

  private async saveAllowance() {
    const a = this.allowance
    if (!a) return
    a.saved()
    await this.state.storage.put("stream", a.s)
  }

  private stream(ws: WebSocket, f: any) {
    if (typeof f.to !== "string" || typeof f.body !== "string" || f.body.length > 1 << 20) return
    const step = this.chain.then(() => this.decide(ws, f))
    this.chain = step.catch(() => {})
    return step.then(async (sent) => {
      if (!sent) return
      let delivered = false
      try {
        delivered = (await (await sent.res).text()) === "1"
      } catch {}
      if (delivered) {
        this.toldOffline.delete(f.to)
        return
      }
      this.offline.set(f.to, Date.now() + 5_000)
      if (this.toldOffline.has(f.to)) return
      this.toldOffline.add(f.to)
      try {
        ws.send(JSON.stringify({ t: "error", code: "stream_offline", to: f.to, message: "not connected now; live frames for them are dropped, never kept" }))
      } catch {}
    })
  }

  /** Whether this frame goes, and if it does, the forward (started here, in order, not awaited). */
  private async decide(ws: WebSocket, f: any): Promise<{ res: Promise<Response> } | null> {
    const now = Date.now()
    if ((this.offline.get(f.to) ?? 0) > now) return null
    const l = this.limits()
    const a = await this.loadAllowance()
    if (a.spent(now)) {
      this.tellOnce(ws, `day:${a.s.day}`, St.pausedFrame("day", l, now))
      return null
    }
    const want = a.need(now)
    if (want) {
      if (now < this.poolBackoff) return null
      try {
        const res = await this.env.STREAM_POOL.get(this.env.STREAM_POOL.idFromName("global")).fetch(`https://do/take?n=${want}`, { method: "POST" })
        const g = (await res.json()) as { grant: number }
        a.granted(g.grant)
        if (!g.grant) this.poolBackoff = St.nextUtcMidnight(now)
      } catch {
        this.poolBackoff = now + 10_000
        return null
      }
    }
    const v = a.take(f.body.length, now)
    if (v === "pool") {
      this.tellOnce(ws, `pool:${a.s.day}`, St.pausedFrame("pool", l, now))
      return null
    }
    if (v === "day") {
      this.tellOnce(ws, `day:${a.s.day}`, St.pausedFrame("day", l, now))
      if (a.unsaved) await this.saveAllowance()
      return null
    }
    if (v === "burst") {
      this.tellOnce(ws, `burst:${Math.floor(now / l.burstMs)}`, { t: "error", code: "stream_burst", message: `live frames over ${l.burstFrames} or ${l.burstBytes} bytes in ${l.burstMs / 1000} s are dropped` })
      return null
    }
    const att = (ws.deserializeAttachment() as any) ?? {}
    ws.serializeAttachment({ ...att, stream: a.s })
    if (a.shouldSave(now)) await this.saveAllowance()
    let stub = this.stubs.get(f.to)
    if (!stub) this.stubs.set(f.to, (stub = this.env.MAILBOX.get(this.env.MAILBOX.idFromName(f.to))))
    const from = att.fp ?? ""
    return { res: stub.fetch("https://do/stream", { method: "POST", body: JSON.stringify({ t: "deliver", from, body: f.body, id: f.id }) }) }
  }

  private broadcast(frame: unknown): boolean {
    const sockets = this.state.getWebSockets()
    if (!sockets.length) return false
    const line = JSON.stringify(frame)
    let sent = false
    for (const s of sockets) {
      try {
        s.send(line)
        sent = true
      } catch {}
    }
    return sent
  }

  /** Kept for a day, so someone asleep still gets it. */
  private async hold(frame: any) {
    const key = `q:${Date.now()}:${Math.random().toString(36).slice(2, 8)}`
    await this.state.storage.put(key, { frame, at: Date.now() })
  }

  private async drain(ws: WebSocket) {
    const held = await this.state.storage.list<{ frame: unknown; at: number }>({ prefix: "q:" })
    const cutoff = Date.now() - 24 * 60 * 60_000
    const stale: string[] = []
    for (const [k, v] of held) {
      if (v.at < cutoff) {
        stale.push(k)
        continue
      }
      try {
        ws.send(JSON.stringify(v.frame))
        stale.push(k)
      } catch {}
    }
    if (stale.length) await this.state.storage.delete(stale)
  }
}

// --- one object per room -------------------------------------------------------

type Member = { fingerprint: string; label: string; addedBy: string; state: "invited" | "joined" }

export class Room {
  constructor(
    private state: DurableObjectState,
    private env: Env,
  ) {}

  async fetch(req: Request): Promise<Response> {
    const f = (await req.json()) as any
    const me: string = f.from ?? ""
    const members = ((await this.state.storage.get<Record<string, Member>>("members")) ?? {}) as Record<
      string,
      Member
    >
    const name = (await this.state.storage.get<string>("name")) ?? "room"
    const joined = (fp: string) => members[fp]?.state === "joined"
    const save = async (m: Record<string, Member>, n = name) => {
      await this.state.storage.put("members", m)
      await this.state.storage.put("name", n)
    }
    const roster = (m: Record<string, Member>, n: string) => ({
      t: "room",
      room: { id: f.roomId ?? f.id, name: n, members: Object.values(m) },
    })

    switch (f.t) {
      case "room_create": {
        if (Object.keys(members).length) return new Response("")
        members[me] = { fingerprint: me, label: f.label ?? "?", addedBy: me, state: "joined" }
        await save(members, String(f.name ?? "room").slice(0, 64))
        await this.tell(members, roster(members, String(f.name ?? "room")))
        return new Response("")
      }
      case "room_invite": {
        if (!joined(me) || !f.fingerprint || members[f.fingerprint]) return new Response("")
        members[f.fingerprint] = {
          fingerprint: f.fingerprint,
          label: String(f.label ?? "?").slice(0, 64),
          addedBy: me,
          state: "invited",
        }
        await save(members)
        await this.tell(members, roster(members, name))
        return new Response("")
      }
      case "room_accept": {
        if (!members[me]) return new Response("")
        members[me].state = "joined"
        await save(members)
        await this.tell(members, roster(members, name))
        return new Response("")
      }
      case "room_decline":
      case "room_leave":
      case "room_kick": {
        const target = f.t === "room_kick" ? f.fingerprint : me
        if (f.t === "room_kick" && !joined(me)) return new Response("")
        delete members[target]
        await save(members)
        await this.tell(members, roster(members, name))
        return new Response("")
      }
      case "room_send": {
        if (!joined(me) || typeof f.body !== "string") return new Response("")
        for (const m of Object.values(members)) {
          if (m.fingerprint === me || m.state !== "joined") continue
          await this.toMailbox(m.fingerprint, {
            t: "room_deliver",
            roomId: f.roomId,
            from: me,
            body: f.body,
            id: f.id,
          })
        }
        return new Response(JSON.stringify({ t: "ack", id: f.id }))
      }
    }
    return new Response("")
  }

  private async toMailbox(fp: string, frame: unknown) {
    const ns = this.env.MAILBOX
    await ns
      .get(ns.idFromName(fp))
      .fetch("https://do/route", { method: "POST", body: JSON.stringify(frame) })
  }

  private async tell(members: Record<string, Member>, frame: unknown) {
    for (const m of Object.values(members)) await this.toMailbox(m.fingerprint, frame)
  }
}

// --- invites, fifteen minutes -------------------------------------------------

export class Invites {
  constructor(private state: DurableObjectState) {}

  async fetch(req: Request): Promise<Response> {
    const url = new URL(req.url)

    // Allocation: succeeds once, so two people never share a slot.
    if (url.pathname === "/claim") {
      if (await this.state.storage.get("claimed")) return json({ error: "taken" }, 409)
      await this.state.storage.put("claimed", Date.now())
      await this.state.storage.setAlarm(Date.now() + 15 * 60_000)
      return json({ ok: true })
    }

    // Three parts: each side's blinded point, then each side's sealed identity.
    const part = url.searchParams.get("part") ?? "a"
    if (!/^[abc]$/.test(part)) return json({ error: "bad part" }, 400)

    if (req.method === "POST") {
      const { blob } = (await req.json()) as { blob?: string }
      if (typeof blob !== "string" || blob.length > 8192) return json({ error: "bad blob" }, 400)
      // Write once, so nobody holding the slot can replace what is there.
      if (await this.state.storage.get(part)) return json({ error: "part already filled" }, 409)
      await this.state.storage.put(part, blob)
      await this.state.storage.setAlarm(Date.now() + 15 * 60_000)
      return json({ ok: true })
    }

    const blob = await this.state.storage.get<string>(part)
    return blob ? json({ blob }) : json({ error: "not ready" }, 404)
  }

  async alarm() {
    await this.state.storage.deleteAll()
  }
}

// --- one object for everyone's streaming, per UTC day ---------------------------

/**
 * The shared relay's daily allowance for live frames, across every sender, so
 * that sharing as a whole stays a modest part of the free plan however many
 * people share (README.md has the numbers). Mailboxes reserve frames from it
 * in chunks (50, doubling to 400), so it is asked once per hundreds of frames,
 * not per frame.
 */
export class StreamPool {
  constructor(
    private state: DurableObjectState,
    private env: Env,
  ) {}

  async fetch(req: Request): Promise<Response> {
    const url = new URL(req.url)
    if (url.pathname === "/__keys" && this.env.TEST_HOOKS === "1")
      return json({ keys: [...(await this.state.storage.list()).keys()], pool: await this.state.storage.get("pool") })
    if (url.pathname !== "/take") return json({ error: "no such route" }, 404)
    const l = St.limits(this.env as any)
    const g = St.grant(await this.state.storage.get("pool"), Number(url.searchParams.get("n") ?? 0), l, Date.now())
    if (g.grant) await this.state.storage.put("pool", g.state)
    return json({ grant: g.grant, left: g.left })
  }
}
