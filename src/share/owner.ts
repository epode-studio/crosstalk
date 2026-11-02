// The owner's end of a share (docs/urls.md, "Sharing"): frames from a viewer
// become requests to the one local service the share was made for, and its
// answers go back as frames.
//
//   where      127.0.0.1 (then ::1) on the share's port, looked up afresh for
//              each request (a crosstalk service that moved keeps its share);
//              never a host or port a frame names: a frame names a share and a
//              stream, and its path must be origin-form
//   who        each frame is checked against the share: the sender's
//              fingerprint in its people, not an agent, not muted, the share
//              neither expired nor stopped (frames.ts refuseViewer)
//   headers    hop-by-hop ones out both ways; the viewer's Cookie and
//              Authorization pass, since the viewer's browser talks to the
//              owner's server as itself; x-crosstalk-* from the viewer out, and
//              x-crosstalk-viewer: <who> in, so the server can tell
//   limits     MAX_STREAMS open per person and share, request bodies up to
//              MAX_REQUEST_BODY, responses up to MAX_RESPONSE_BODY, websocket
//              messages up to MAX_WS_MESSAGE, and what a person sends held to
//              a budget (a Pacer at twice the daemon's own)
//
// Transport-agnostic: `send` carries a frame to the viewer, `backlog` says how
// much is waiting to go (a response is paused while it is high).

import http from "node:http"
import net from "node:net"
import * as F from "./frames.ts"

export type OwnerShare = {
  id: string
  with: { label: string; fingerprint: string }[]
  expiresAt: number
  revokedAt?: number
}

export type OwnerDeps = {
  share: (id: string) => OwnerShare | undefined
  /** The port to forward to now, or why there is none (the service is not running). */
  port: (id: string) => number | { error: string }
  /** What is known of the sender now. */
  viewer: (label: string) => { fingerprint?: string; bot?: boolean; muted?: boolean; level?: string }
  send: (label: string, f: F.ResFrame) => void
  /** Bytes waiting to go out; a response pauses while this is over BACKLOG. */
  backlog?: () => number
  log?: (s: string) => void
  now?: () => number
  /** A port never forwarded to (crosstalk's own proxy). */
  forbidden?: (port: number) => boolean
  inbound?: ConstructorParameters<typeof F.Pacer>[0]
}

const BACKLOG = 8 * 1024 * 1024
const IDLE_MS = 120_000

type Stream = {
  key: string
  share: string
  label: string
  fingerprint: string
  s: string
  q: number
  bytesIn: number
  bytesOut: number
  req?: http.ClientRequest
  res?: http.IncomingMessage
  headSent?: boolean
  ws?: WebSocket
  wsQueue?: { d: Buffer; b: boolean }[]
  /** Body and end that came while the upstream was being looked for. */
  held?: (Buffer | "end")[]
  done?: boolean
}

/** 127.0.0.1, else ::1: whichever the service listens on (a dev server on `localhost` can be ::1 alone). */
async function upstreamHost(port: number): Promise<string | null> {
  const tryHost = (host: string) =>
    new Promise<boolean>((resolve) => {
      const s = net.connect({ host, port })
      const done = (ok: boolean) => {
        s.destroy()
        resolve(ok)
      }
      s.once("connect", () => done(true))
      s.once("error", () => done(false))
      s.setTimeout(3000, () => done(false))
    })
  if (await tryHost("127.0.0.1")) return "127.0.0.1"
  if (await tryHost("::1")) return "::1"
  return null
}

function headerObject(h: F.Headers): Record<string, string> {
  const o: Record<string, string> = {}
  for (const [k0, v] of h) {
    const k = k0.toLowerCase()
    o[k] = o[k] === undefined ? v : `${o[k]}${k === "cookie" ? "; " : ", "}${v}`
  }
  return o
}

export class ShareOwner {
  private streams = new Map<string, Stream>()
  private order: F.Order
  private budgets = new Map<string, F.Pacer>()
  private now: () => number
  constructor(private d: OwnerDeps) {
    this.now = d.now ?? Date.now
    this.order = new F.Order(this.now)
  }

  /** Streams open now (tests, status). */
  open(): number {
    return this.streams.size
  }

  private out(st: Stream, f: Record<string, unknown>) {
    this.d.send(st.label, { ...f, share: st.share, s: st.s, q: st.q++ } as F.ResFrame)
  }

  /** A refusal for a stream that never opened: one error frame, q 0. */
  private refuse(label: string, share: string, s: string, status: number, message: string) {
    this.d.send(label, { op: "error", share, s, q: 0, status, message })
  }

  private end(st: Stream) {
    if (st.done) return
    st.done = true
    this.streams.delete(st.key)
    this.order.close(st.key)
    try {
      st.req?.destroy()
    } catch {}
    try {
      st.res?.destroy()
    } catch {}
    try {
      if (st.ws && st.ws.readyState < 2) st.ws.close(1001)
    } catch {}
  }

  private fail(st: Stream, status: number, message: string) {
    if (st.done) return
    this.out(st, { op: "error", status, message })
    this.end(st)
  }

  /** One frame from `label`. */
  onFrame(label: string, f: F.ReqFrame): void {
    if (!f || typeof f !== "object" || !F.isId(f.share) || typeof f.s !== "string" || !/^[A-Za-z0-9_-]{8,64}$/.test(f.s)) return
    const viewer = this.d.viewer(label)
    const key = `${viewer.fingerprint ?? label}:${f.s}`
    const opening = f.op === "req"
    const seq = this.order.take(key, f.q, opening)
    if (seq !== "ok") {
      const st = this.streams.get(key)
      if (st && seq === "gap") this.fail(st, 400, "frames out of order")
      if (seq === "replay") this.d.log?.(`share: dropped a replayed frame from ${label}`)
      return
    }
    const why = F.refuseViewer(this.d.share(f.share), viewer, this.now())
    if (why) {
      const st = this.streams.get(key)
      if (st) return this.fail(st, why.status, why.message)
      this.order.close(key)
      if (opening) {
        this.d.log?.(`share: refused ${label} on ${f.share}: ${why.message}`)
        this.refuse(label, f.share, f.s, why.status, why.message)
      }
      return
    }
    // What this person sends is held to a budget.
    const bkey = `${f.share}:${viewer.fingerprint}`
    let budget = this.budgets.get(bkey)
    if (!budget) this.budgets.set(bkey, (budget = new F.Pacer(this.d.inbound ?? { fps: 160, bps: 6 * 1024 * 1024, burstFrames: 800, burstBytes: 24 * 1024 * 1024 }, this.now)))
    const size = (f as { d?: string }).d?.length ?? 0
    if (!budget.allow(size)) {
      const st = this.streams.get(key)
      if (st) return this.fail(st, 429, "too much, too fast")
      this.order.close(key)
      if (opening) this.refuse(label, f.share, f.s, 429, "too much, too fast")
      return
    }
    if (opening) return void this.start(label, viewer.fingerprint!, key, f as Extract<F.ReqFrame, { op: "req" }>)
    const st = this.streams.get(key)
    if (!st || st.share !== f.share) return
    switch (f.op) {
      case "body": {
        const b = F.dec(f.d)
        st.bytesIn += b.length
        if (st.bytesIn > F.MAX_REQUEST_BODY) return this.fail(st, 413, "request body too large")
        if (st.req) st.req.write(b)
        else st.held?.push(b)
        return
      }
      case "end":
        if (st.req) st.req.end()
        else st.held?.push("end")
        return
      case "abort":
        return this.end(st)
      case "wsmsg": {
        const b = F.dec(f.d)
        if (b.length > F.MAX_WS_MESSAGE) return this.fail(st, 413, "websocket message too large")
        if (st.ws && st.ws.readyState === 1) st.ws.send(f.b ? b : b.toString("utf8"))
        else if (st.wsQueue && st.wsQueue.length < 256) st.wsQueue.push({ d: b, b: !!f.b })
        return
      }
      case "wsclose": {
        try {
          const code = typeof f.code === "number" && f.code >= 1000 && f.code < 5000 && f.code !== 1005 && f.code !== 1006 ? f.code : 1000
          st.ws?.close(code, typeof f.reason === "string" ? f.reason.slice(0, 120) : undefined)
        } catch {}
        return this.end(st)
      }
    }
  }

  private async start(label: string, fingerprint: string, key: string, f: Extract<F.ReqFrame, { op: "req" }>) {
    const st: Stream = { key, share: f.share, label, fingerprint, s: f.s, q: 0, bytesIn: 0, bytesOut: 0, held: [] }
    const open = [...this.streams.values()].filter((x) => x.share === f.share && x.fingerprint === fingerprint).length
    if (open >= F.MAX_STREAMS) {
      this.order.close(key)
      return this.refuse(label, f.share, f.s, 429, "too many requests open at once")
    }
    const bad = F.refuseRequest(f)
    if (bad) {
      this.order.close(key)
      this.d.log?.(`share: refused a request from ${label}: ${bad}`)
      return this.refuse(label, f.share, f.s, 400, bad)
    }
    this.streams.set(key, st)
    const port = this.d.port(f.share)
    if (typeof port !== "number") return this.fail(st, 502, port.error)
    if (!(port > 0 && port < 65536) || this.d.forbidden?.(port)) return this.fail(st, 403, "that port is not shared")
    const host = await upstreamHost(port)
    if (st.done) return
    if (!host) return this.fail(st, 502, "the shared server is not answering")
    const headers = F.cleanHeaders(f.headers, { drop: ["host", "x-crosstalk-*"] })
    const viewerHost = (Array.isArray(f.headers) ? f.headers : []).find((h) => Array.isArray(h) && String(h[0]).toLowerCase() === "host")?.[1]
    headers.push(["host", F.hostFor(typeof viewerHost === "string" ? viewerHost : undefined, port)])
    headers.push(["x-crosstalk-viewer", label.replace(/[^\w.@-]/g, "-").slice(0, 64)])
    if (f.ws) return this.websocket(st, host, port, f.path, headers, Array.isArray(f.protocols) ? f.protocols.filter((p) => typeof p === "string" && /^[!#$%&'*+.^_`|~0-9A-Za-z-]{1,64}$/.test(p)).slice(0, 8) : [])
    const req = http.request({ host, port, method: f.method, path: f.path, headers: headerObject(headers), setHost: false, agent: false } as http.RequestOptions)
    st.req = req
    for (const h of st.held ?? []) h === "end" ? req.end() : req.write(h)
    st.held = undefined
    req.setTimeout(IDLE_MS, () => this.fail(st, 504, "the shared server took too long"))
    req.on("error", (e) => this.fail(st, 502, `the shared server did not answer: ${(e as NodeJS.ErrnoException).code ?? e.message}`))
    req.on("response", (res) => {
      if (st.done) return res.destroy()
      st.res = res
      st.headSent = true
      this.out(st, { op: "res", status: res.statusCode ?? 502, statusText: (res.statusMessage ?? "").slice(0, 120), headers: F.cleanHeaders(F.pairsOf(res.rawHeaders)) })
      res.on("data", (b: Buffer) => {
        if (st.done) return
        st.bytesOut += b.length
        if (st.bytesOut > F.MAX_RESPONSE_BODY) return this.fail(st, 502, "response too large to share")
        for (const c of F.chunks(b)) this.out(st, { op: "body", d: F.enc(c) })
        if ((this.d.backlog?.() ?? 0) > BACKLOG) {
          res.pause()
          const wait = () => {
            if (st.done) return
            if ((this.d.backlog?.() ?? 0) > BACKLOG / 2) return void setTimeout(wait, 25)
            res.resume()
          }
          setTimeout(wait, 25)
        }
      })
      res.on("end", () => {
        if (st.done) return
        this.out(st, { op: "end" })
        this.end(st)
      })
      res.on("error", () => this.fail(st, 502, "the shared server broke off"))
    })
  }

  private websocket(st: Stream, host: string, port: number, path: string, headers: F.Headers, protocols: string[]) {
    const h = headerObject(headers.filter(([k]) => !/^(content-length|origin)$/i.test(k)))
    const origin = headers.find(([k]) => k.toLowerCase() === "origin")?.[1]
    let ws: WebSocket
    try {
      ws = new WebSocket(`ws://${host.includes(":") ? `[${host}]` : host}:${port}${path}`, { headers: { ...h, ...(origin ? { origin } : {}) }, protocols } as any)
    } catch (e) {
      return this.fail(st, 502, `could not open the websocket: ${(e as Error).message}`)
    }
    ws.binaryType = "arraybuffer"
    st.ws = ws
    st.wsQueue = []
    let opened = false
    const timer = setTimeout(() => {
      if (!opened) this.fail(st, 504, "the shared server did not open the websocket")
    }, 15_000)
    ws.onopen = () => {
      opened = true
      clearTimeout(timer)
      if (st.done) return ws.close(1001)
      st.headSent = true
      this.out(st, { op: "wsopen", ...(ws.protocol ? { protocol: ws.protocol } : {}) })
      for (const m of st.wsQueue ?? []) ws.send(m.b ? m.d : m.d.toString("utf8"))
      st.wsQueue = undefined
    }
    ws.onmessage = (e) => {
      if (st.done) return
      const binary = typeof e.data !== "string"
      const b = binary ? Buffer.from(e.data as ArrayBuffer) : Buffer.from(e.data as string, "utf8")
      if (b.length > F.MAX_WS_MESSAGE) return this.fail(st, 502, "websocket message too large to share")
      st.bytesOut += b.length
      this.out(st, { op: "wsmsg", d: F.enc(b), ...(binary ? { b: true } : {}) })
    }
    ws.onclose = (e) => {
      clearTimeout(timer)
      if (st.done) return
      if (!opened) return this.fail(st, 502, "the shared server refused the websocket")
      this.out(st, { op: "wsclose", code: e.code, reason: String(e.reason ?? "").slice(0, 120) })
      this.end(st)
    }
    ws.onerror = () => {}
  }

  /** Stop every stream of a share (stopped, expired), or only one person's. */
  stop(shareId: string, o: { fingerprint?: string; status?: number; message?: string } = {}): number {
    let n = 0
    for (const st of [...this.streams.values()])
      if (st.share === shareId && (!o.fingerprint || st.fingerprint === o.fingerprint)) {
        n++
        if (st.ws && !st.headSent) this.fail(st, o.status ?? 410, o.message ?? "the share was stopped")
        else if (st.ws) {
          this.out(st, { op: "wsclose", code: 1008, reason: o.message ?? "the share was stopped" })
          this.end(st)
        } else this.fail(st, o.status ?? 410, o.message ?? "the share was stopped")
      }
    return n
  }

  close() {
    for (const st of [...this.streams.values()]) this.end(st)
  }
}
