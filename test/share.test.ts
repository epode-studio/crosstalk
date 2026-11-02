// Sharing a running server with a teammate (docs/urls.md, "Sharing"):
// frames, chunking, streaming, the shared target's allowlist, expiry,
// revocation and the people checks. The owner and viewer engines are wired
// to each other in memory; a real bun HTTP and websocket server stands in for
// the owner's dev server.

import { afterAll, beforeAll, describe, expect, test } from "bun:test"
import * as F from "../src/share/frames.ts"
import { ShareOwner, type OwnerShare } from "../src/share/owner.ts"
import { ShareViewer } from "../src/share/viewer.ts"
import { buildTable } from "../src/urls/routes.ts"
import { gate, decideOffer, label as shareLabel } from "../src/share/rules.ts"

// --- the stand-in dev server, and a second one that is not shared ---------------------------------

let big: Buffer
let srv: ReturnType<typeof Bun.serve>
let other: ReturnType<typeof Bun.serve>
beforeAll(() => {
  big = Buffer.alloc(3 * 1024 * 1024 + 123)
  for (let i = 0; i < big.length; i++) big[i] = (i * 7) % 251
  srv = Bun.serve({
    port: 0,
    hostname: "127.0.0.1",
    async fetch(req, s) {
      const u = new URL(req.url)
      if (u.pathname === "/ws" && s.upgrade(req, { data: {}, headers: req.headers.get("sec-websocket-protocol") ? { "Sec-WebSocket-Protocol": "vite-hmr" } : undefined })) return undefined as any
      if (u.pathname === "/big") return new Response(big)
      if (u.pathname === "/echo") return new Response(await req.arrayBuffer(), { headers: { "x-len": String(req.headers.get("content-length") ?? "") } })
      if (u.pathname === "/headers") return Response.json(Object.fromEntries(req.headers))
      if (u.pathname === "/cookie") return new Response("ok", { headers: [["set-cookie", "a=1; Path=/"], ["set-cookie", "b=2; Path=/"], ["connection", "x-secret"], ["x-secret", "hop"]] })
      if (u.pathname === "/slow") {
        let n = 0
        return new Response(new ReadableStream({ async pull(c) { await Bun.sleep(20); if (n++ >= 3) return c.close(); c.enqueue(new TextEncoder().encode(`tick${n} `)) } }))
      }
      return new Response(`shared page ${u.pathname}${u.search} host=${req.headers.get("host")}`)
    },
    websocket: { message(ws, m) { ws.send(typeof m === "string" ? `echo ${m}` : m) } },
  })
  other = Bun.serve({ port: 0, hostname: "127.0.0.1", fetch: () => new Response("THE OTHER SERVER") })
})
afterAll(() => {
  srv.stop(true)
  other.stop(true)
})

// --- the pure rules ------------------------------------------------------------------------------

describe("frames", () => {
  test("a body is cut into CHUNK pieces and put back the same", () => {
    const b = Buffer.alloc(F.CHUNK * 2 + 5, 7)
    const cs = F.chunks(b)
    expect(cs.map((c) => c.length)).toEqual([F.CHUNK, F.CHUNK, 5])
    expect(Buffer.concat(cs.map((c) => F.dec(F.enc(c)))).equals(b)).toBe(true)
    expect(F.chunks(Buffer.alloc(0))).toEqual([])
  })
  test("a chunk, sealed, stays well under the relay's 1 MB", () => {
    expect(F.enc(Buffer.alloc(F.CHUNK)).length * 1.4).toBeLessThan(1 << 20)
  })
  test("hop-by-hop headers go, and any the Connection header names", () => {
    const h = F.cleanHeaders([["Connection", "keep-alive, X-Secret"], ["Keep-Alive", "5"], ["X-Secret", "1"], ["Transfer-Encoding", "chunked"], ["Upgrade", "h2"], ["Cookie", "s=1"], ["Authorization", "Bearer t"], ["Sec-WebSocket-Key", "k"], ["Bad Name", "x"], ["X-Ok", "a\r\nb"], ["Accept", "*/*"]])
    expect(h).toEqual([["Cookie", "s=1"], ["Authorization", "Bearer t"], ["Accept", "*/*"]])
    expect(F.cleanHeaders([["x-crosstalk-viewer", "me"], ["host", "h"], ["a", "b"]], { drop: ["host", "x-crosstalk-*"] })).toEqual([["a", "b"]])
  })
  test("only origin-form paths: never another host or port", () => {
    expect(F.refuseRequest({ method: "GET", path: "/a?b=1" })).toBeNull()
    expect(F.refuseRequest({ method: "GET", path: "http://127.0.0.1:22/" })).toMatch(/never another host/)
    expect(F.refuseRequest({ method: "GET", path: "//evil.example/" })).toMatch(/never another host/)
    expect(F.refuseRequest({ method: "CONNECT", path: "127.0.0.1:22" })).toMatch(/not passed on/)
    expect(F.refuseRequest({ method: "GET", path: "/a b" })).toMatch(/cannot carry/)
    expect(F.refuseRequest({ method: "GET", path: "/a\r\nHost: x" })).toMatch(/cannot carry/)
    expect(F.refuseRequest({ method: "get x", path: "/" })).toMatch(/method/)
  })
  test("the owner's server sees the viewer's *.localhost name, else localhost:<port>", () => {
    expect(F.hostFor("auth.paul.localhost:1355", 5173)).toBe("auth.paul.localhost:1355")
    expect(F.hostFor("evil.example", 5173)).toBe("localhost:5173")
    expect(F.hostFor(undefined, 5173)).toBe("localhost:5173")
  })
  test("listeners answer loopback names only", () => {
    expect(F.loopbackHost("auth.paul.localhost:1355")).toBe(true)
    expect(F.loopbackHost("127.0.0.1:4000")).toBe(true)
    expect(F.loopbackHost("[::1]:4000")).toBe(true)
    expect(F.loopbackHost("evil.example")).toBe(false)
    expect(F.loopbackHost("localhost.evil.example")).toBe(false)
    expect(F.loopbackHost(null)).toBe(false)
  })
  test("each stream's frames come in order, once", () => {
    let t = 1000
    const o = new F.Order(() => t)
    expect(o.take("a", 0, true)).toBe("ok")
    expect(o.take("a", 1, false)).toBe("ok")
    expect(o.take("a", 1, false)).toBe("replay")
    expect(o.take("a", 3, false)).toBe("gap")
    o.close("a")
    // An old opening frame played again opens nothing.
    expect(o.take("a", 0, true)).toBe("replay")
    expect(o.take("b", 1, true)).toBe("gap")
    expect(o.take("c", 0, false)).toBe("gap")
  })
  test("frames older than two minutes are dropped", () => {
    expect(F.fresh(1000, 1000 + 60_000)).toBe(true)
    expect(F.fresh(1000, 1000 + 3 * 60_000)).toBe(false)
    expect(F.fresh("x", 1000)).toBe(false)
  })
  test("a pacer holds a sender to frames and bytes per second", () => {
    let t = 0
    const p = new F.Pacer({ fps: 10, bps: 1000, burstFrames: 2, burstBytes: 1000 }, () => t)
    expect(p.delay(10)).toBe(0)
    expect(p.delay(10)).toBe(0)
    expect(p.delay(10)).toBe(100)
    t = 1000
    expect(p.delay(2000)).toBe(1000)
    const q = new F.Pacer({ fps: 1, bps: 100, burstFrames: 1, burstBytes: 100 }, () => t)
    expect(q.allow(50)).toBe(true)
    expect(q.allow(10)).toBe(false)
  })
})

describe("how long", () => {
  const now = new Date(2026, 10, 2, 10, 0).getTime()
  test("eight hours by default, an hour for a public link", () => {
    expect(F.expiry(undefined, { now })).toEqual({ ms: 8 * F.HOUR })
    expect(F.expiry(undefined, { now, public: true })).toEqual({ ms: F.HOUR })
  })
  test("plain words, minutes, until a time", () => {
    expect(F.expiry("2h", { now })).toEqual({ ms: 2 * F.HOUR })
    expect(F.expiry("30m", { now })).toEqual({ ms: 30 * 60_000 })
    expect(F.expiry(45, { now })).toEqual({ ms: 45 * 60_000 })
    expect(F.expiry("a day", { now })).toEqual({ ms: 24 * F.HOUR })
    expect(F.expiry("until 18:00", { now })).toEqual({ ms: 8 * F.HOUR })
    expect(F.expiry("until 6pm", { now })).toEqual({ ms: 8 * F.HOUR })
  })
  test("capped: a week, eight hours public; never forever", () => {
    expect(F.expiry("3 weeks", { now })).toEqual({ ms: F.MAX_MS })
    expect(F.expiry("2 days", { now, public: true })).toEqual({ ms: F.PUBLIC_MAX_MS })
    expect("error" in F.expiry("forever", { now })).toBe(true)
    expect("error" in F.expiry("whenever", { now })).toBe(true)
    expect("error" in F.expiry(0, { now })).toBe(true)
  })
  test("until 18:00 today, a weekday another day", () => {
    expect(F.untilText(new Date(2026, 10, 2, 18, 0).getTime(), now)).toBe("until 18:00")
    expect(F.untilText(new Date(2026, 10, 3, 9, 5).getTime(), now)).toBe("until Tue 09:05")
  })
})

describe("people", () => {
  const peers: Record<string, F.PersonCheck> = {
    marie: { label: "marie", fingerprint: "fp-m" },
    joe: { label: "joe", fingerprint: "fp-j", muted: true },
    bot: { label: "bot", fingerprint: "fp-b", bot: true },
    sam: { label: "sam", fingerprint: "fp-s", level: "mute" },
    mariella: { label: "mariella", fingerprint: "fp-x" },
  }
  test("exact names of people with a direct channel", () => {
    expect(F.resolvePeople(["marie"], peers)).toEqual({ ok: [peers.marie] })
    expect(F.resolvePeople(["@Marie"], peers)).toEqual({ ok: [peers.marie] })
    expect(F.resolvePeople("marie, mariella", peers)).toEqual({ ok: [peers.marie, peers.mariella] })
  })
  test("never a prefix, a stranger, an agent, a muted person, or yourself", () => {
    expect((F.resolvePeople(["mar"], peers) as any).error).toMatch(/nobody called "mar"/)
    expect((F.resolvePeople(["eve"], peers) as any).error).toMatch(/nobody called "eve"/)
    expect((F.resolvePeople(["bot"], peers) as any).error).toMatch(/agent/)
    expect((F.resolvePeople(["joe"], peers) as any).error).toMatch(/muted/)
    expect((F.resolvePeople(["sam"], peers) as any).error).toMatch(/muted/)
    expect((F.resolvePeople(["paul"], peers, "paul") as any).error).toMatch(/you/)
    expect((F.resolvePeople([], peers) as any).error).toMatch(/say who/)
  })
  test("a frame is let through only for the share's people, while it lasts", () => {
    const share = { with: [{ fingerprint: "fp-m" }], expiresAt: 2000 }
    expect(F.refuseViewer(share, { fingerprint: "fp-m" }, 1000)).toBeNull()
    expect(F.refuseViewer(share, { fingerprint: "fp-x" }, 1000)?.status).toBe(403)
    expect(F.refuseViewer(share, { fingerprint: "fp-m", bot: true }, 1000)?.status).toBe(403)
    expect(F.refuseViewer(share, { fingerprint: "fp-m", muted: true }, 1000)?.status).toBe(403)
    expect(F.refuseViewer(share, { fingerprint: "fp-m" }, 2000)?.status).toBe(410)
    expect(F.refuseViewer({ ...share, revokedAt: 1 }, { fingerprint: "fp-m" }, 1000)?.status).toBe(410)
    expect(F.refuseViewer(undefined, { fingerprint: "fp-m" }, 1000)?.status).toBe(404)
  })
})

describe("offers, on the viewer's side", () => {
  const now = 1_000_000
  const offer = { op: "offer", id: "a".repeat(24), label: "auth · dev server", name: "auth", expiresAt: now + F.HOUR }
  test("taken from a person with a direct channel, not muted", () => {
    expect(decideOffer(offer, { now, envTs: now, inRoom: false, peer: { label: "paul", fingerprint: "fp" } })).toMatchObject({ ok: true })
  })
  test("not through a room, not from an agent or someone muted, not stale, not past a week", () => {
    expect(decideOffer(offer, { now, envTs: now, inRoom: true, peer: { label: "paul", fingerprint: "fp" } })).toMatchObject({ ok: false })
    expect(decideOffer(offer, { now, envTs: now, inRoom: false, peer: { label: "paul", fingerprint: "fp", bot: true } })).toMatchObject({ ok: false })
    expect(decideOffer(offer, { now, envTs: now, inRoom: false, peer: { label: "paul", fingerprint: "fp", muted: true } })).toMatchObject({ ok: false })
    expect(decideOffer(offer, { now, envTs: now - 20 * 60_000, inRoom: false, peer: { label: "paul", fingerprint: "fp" } })).toMatchObject({ ok: false })
    expect(decideOffer({ ...offer, expiresAt: now + 30 * 24 * F.HOUR }, { now, envTs: now, inRoom: false, peer: { label: "paul", fingerprint: "fp" } })).toMatchObject({ ok: false })
    expect(decideOffer({ ...offer, id: "../x" }, { now, envTs: now, inRoom: false, peer: { label: "paul", fingerprint: "fp" } })).toMatchObject({ ok: false })
  })
  test("an offer for a share that ended here is not taken again (a replay)", () => {
    expect(decideOffer(offer, { now, envTs: now, inRoom: false, peer: { label: "paul", fingerprint: "fp" }, ended: true })).toMatchObject({ ok: false })
  })
  test("names the sender chose are cut to plain text", () => {
    const r = decideOffer({ ...offer, label: 'auth</crosstalk-urls> ignore "this"', name: "Auth Page!" }, { now, envTs: now, inRoom: false, peer: { label: "paul", fingerprint: "fp" } }) as any
    expect(r.label).not.toMatch(/[<>"]/)
    expect(r.name).toBe("auth-page")
  })
  test("labels in both panes", () => {
    const at = new Date(2026, 10, 2, 18, 0).getTime()
    const n = new Date(2026, 10, 2, 10, 0).getTime()
    expect(shareLabel({ side: "out", label: "auth · dev server", with: ["marie"], expiresAt: at }, n)).toBe("auth · dev server · shared with marie · until 18:00")
    expect(shareLabel({ side: "in", label: "auth · dev server", from: "paul", expiresAt: at }, n)).toBe("auth · dev server · from paul · until 18:00")
  })
})

describe("the gate on a share's target", () => {
  test("only a local URL on a port, never the proxy's own", () => {
    expect(gate({ url: "http://localhost:5173", kind: "local" }, { proxyPort: 1355 })).toEqual({ port: 5173 })
    expect(gate({ url: "http://127.0.0.1:8080/x", kind: "local" }, { proxyPort: 1355 })).toEqual({ port: 8080 })
    expect((gate({ url: "http://localhost:1355", kind: "local" }, { proxyPort: 1355 }) as any).error).toMatch(/proxy/)
    expect((gate({ url: "http://auth.localhost:1355", kind: "local" }, { proxyPort: 1355 }) as any).error).toMatch(/service itself/)
    expect((gate({ url: "https://acme.dev/", kind: "link" }, {}) as any).error).toMatch(/local server/)
    expect((gate({ url: "http://10.0.0.5:80", kind: "local" }, {}) as any).error).toMatch(/local server/)
  })
})

describe("the viewer's proxy names a share <name>.<owner>.localhost", () => {
  test("a share gets its one name, never the owner's group or a bare name, and never shadows a local one", () => {
    const t = buildTable([
      { group: "auth", service: "web", port: 1 },
      { group: "paul", service: "auth", port: 2, shared: true },
      { group: "paul", service: "billing", port: 3, shared: true },
    ])
    expect(t.byHost.get("auth.paul")?.port).toBe(2)
    expect(t.byHost.get("billing.paul")?.port).toBe(3)
    expect(t.byHost.get("paul")).toBeUndefined()
    expect(t.byHost.get("billing")).toBeUndefined()
    expect(t.byHost.get("auth")?.port).toBe(1)
    const clash = buildTable([
      { group: "paul", service: "auth", port: 9, shared: true },
      { group: "paul", service: "auth", port: 1 },
    ])
    expect(clash.byHost.get("auth.paul")?.port).toBe(1)
  })
})

// --- the two ends, wired in memory ---------------------------------------------------------------

function pair(o: { share?: Partial<OwnerShare>; port?: () => number | { error: string }; viewerFp?: string; viewer?: Partial<{ bot: boolean; muted: boolean }> } = {}) {
  const share: OwnerShare = { id: "f".repeat(24), with: [{ label: "marie", fingerprint: "fp-m" }], expiresAt: Date.now() + F.HOUR, ...o.share }
  const sent = { toOwner: 0, toViewer: 0, bytes: 0 }
  let viewer!: ShareViewer
  const owner = new ShareOwner({
    share: (id) => (id === share.id ? share : undefined),
    port: o.port ?? (() => srv.port!),
    viewer: (label) => ({ fingerprint: label === "marie" ? (o.viewerFp ?? "fp-m") : "fp-other", ...o.viewer }),
    send: (label, f) => {
      sent.toViewer++
      // Through JSON, as on the wire.
      queueMicrotask(() => viewer.onFrame("paul", JSON.parse(JSON.stringify(f))))
    },
    forbidden: (p) => p === 1,
  })
  viewer = new ShareViewer({
    send: (_o, f) => {
      sent.toOwner++
      sent.bytes += JSON.stringify(f).length
      queueMicrotask(() => owner.onFrame("marie", JSON.parse(JSON.stringify(f))))
    },
    timeoutMs: 5000,
  })
  return { share, owner, viewer, sent }
}

describe("over the wire", () => {
  test("a page through a listener, the Host as the viewer sent it", async () => {
    const { viewer, share } = pair()
    const l = viewer.listen({ id: share.id, owner: "paul" })
    const r = await fetch(`http://127.0.0.1:${l.port}/auth?x=1`, { headers: { host: "auth.paul.localhost:1355" } })
    expect(r.status).toBe(200)
    expect(await r.text()).toBe("shared page /auth?x=1 host=auth.paul.localhost:1355")
    l.stop()
  })
  test("a large response streams back in chunks, byte for byte", async () => {
    const { viewer, share, sent } = pair()
    const l = viewer.listen({ id: share.id, owner: "paul" })
    const r = await fetch(`http://127.0.0.1:${l.port}/big`)
    const b = Buffer.from(await r.arrayBuffer())
    expect(b.length).toBe(big.length)
    expect(b.equals(big)).toBe(true)
    expect(sent.toViewer).toBeGreaterThanOrEqual(Math.ceil(big.length / F.CHUNK) + 2)
    l.stop()
  })
  test("a large request body goes in chunks and arrives whole", async () => {
    const { viewer, share, sent } = pair()
    const l = viewer.listen({ id: share.id, owner: "paul" })
    const body = big.subarray(0, 1024 * 1024 + 9)
    const r = await fetch(`http://127.0.0.1:${l.port}/echo`, { method: "POST", body })
    expect(Buffer.from(await r.arrayBuffer()).equals(body)).toBe(true)
    expect(sent.toOwner).toBeGreaterThanOrEqual(Math.ceil(body.length / F.CHUNK) + 2)
    l.stop()
  })
  test("a slow response arrives as it is written", async () => {
    const { viewer, share } = pair()
    const l = viewer.listen({ id: share.id, owner: "paul" })
    const r = await fetch(`http://127.0.0.1:${l.port}/slow`)
    const reader = r.body!.getReader()
    const first = new TextDecoder().decode((await reader.read()).value)
    expect(first).toBe("tick1 ")
    let rest = ""
    for (;;) {
      const { value, done } = await reader.read()
      if (done) break
      rest += new TextDecoder().decode(value)
    }
    expect(rest).toBe("tick2 tick3 ")
    l.stop()
  })
  test("hop-by-hop headers are taken out; cookies pass, both ways; the server can tell who it is", async () => {
    const { viewer, share } = pair()
    const l = viewer.listen({ id: share.id, owner: "paul" })
    const h = (await (await fetch(`http://127.0.0.1:${l.port}/headers`, { headers: { cookie: "s=1", authorization: "Bearer t", "x-crosstalk-viewer": "forged", connection: "x-drop", "x-drop": "1" } })).json()) as Record<string, string>
    expect(h.cookie).toBe("s=1")
    expect(h.authorization).toBe("Bearer t")
    expect(h["x-crosstalk-viewer"]).toBe("marie")
    expect(h["x-drop"]).toBeUndefined()
    const c = await fetch(`http://127.0.0.1:${l.port}/cookie`)
    expect(c.headers.getSetCookie()).toEqual(["a=1; Path=/", "b=2; Path=/"])
    expect(c.headers.get("x-secret")).toBeNull()
    l.stop()
  })
  test("a websocket echoes, text and binary, with the subprotocol the server chose", async () => {
    const { viewer, share } = pair()
    const l = viewer.listen({ id: share.id, owner: "paul" })
    const ws = new WebSocket(`ws://127.0.0.1:${l.port}/ws`, ["vite-hmr"])
    ws.binaryType = "arraybuffer"
    const got: unknown[] = []
    await new Promise<void>((resolve, reject) => {
      ws.onopen = () => {
        ws.send("hello")
        ws.send(new Uint8Array([1, 2, 3]))
      }
      ws.onmessage = (e) => {
        got.push(typeof e.data === "string" ? e.data : [...new Uint8Array(e.data as ArrayBuffer)])
        if (got.length === 2) resolve()
      }
      ws.onerror = () => reject(new Error("ws error"))
      setTimeout(() => reject(new Error("timeout")), 4000)
    })
    expect(ws.protocol).toBe("vite-hmr")
    expect(got).toEqual(["echo hello", [1, 2, 3]])
    ws.close()
    l.stop()
  })
  test("a frame naming another port, or an absolute URL, still reaches only the shared server", async () => {
    const { viewer, share } = pair()
    // A hand-made opening frame with a port and host of its own: ignored.
    const sent: F.ResFrame[] = []
    const owner = new ShareOwner({ share: () => share, port: () => srv.port!, viewer: () => ({ fingerprint: "fp-m" }), send: (_l, f) => void sent.push(f) })
    owner.onFrame("marie", { op: "req", share: share.id, s: "stream-aaaa", q: 0, method: "GET", path: "/", headers: [], port: other.port, host: "127.0.0.1" } as any)
    owner.onFrame("marie", { op: "end", share: share.id, s: "stream-aaaa", q: 1 })
    for (let i = 0; i < 50 && !sent.some((f) => f.op === "end"); i++) await Bun.sleep(20)
    const body = Buffer.concat(sent.filter((f) => f.op === "body").map((f) => F.dec((f as any).d))).toString()
    expect(body).toContain("shared page /")
    expect(body).not.toContain("OTHER")
    // An absolute URL as the path: refused before anything is forwarded.
    const r = await viewer.request("paul", share.id, { path: `http://127.0.0.1:${other.port}/` })
    expect(r.status).toBe(400)
    expect(r.message).toMatch(/never another host or port/)
    // And through the listener, an absolute-form request target is the shared server's path.
    const l = viewer.listen({ id: share.id, owner: "paul" })
    const raw = await new Promise<string>((resolve) => {
      const s = require("node:net").connect(l.port, "127.0.0.1", () => s.write(`GET http://127.0.0.1:${other.port}/ HTTP/1.1\r\nHost: auth.paul.localhost\r\nConnection: close\r\n\r\n`))
      let out = ""
      s.on("data", (d: Buffer) => (out += d))
      s.on("close", () => resolve(out))
    })
    expect(raw).not.toContain("OTHER")
    l.stop()
  })
  test("the owner never forwards to a forbidden port (its own proxy)", async () => {
    const { viewer, share } = pair({ port: () => 1 })
    const r = await viewer.request("paul", share.id, { path: "/" })
    expect(r.status).toBe(403)
  })
  test("a service that is not running answers 502, not something else", async () => {
    const { viewer, share } = pair({ port: () => ({ error: "auth · web is not running" }) })
    const r = await viewer.request("paul", share.id, { path: "/" })
    expect(r.status).toBe(502)
    expect(r.message).toMatch(/not running/)
  })
  test("someone the share does not name gets 403, and nothing is forwarded", async () => {
    const { viewer, share, owner } = pair({ viewerFp: "fp-stranger" })
    const r = await viewer.request("paul", share.id, { path: "/" })
    expect(r.status).toBe(403)
    expect(owner.open()).toBe(0)
  })
  test("an agent, or a muted person, gets 403 too", async () => {
    expect((await pair({ viewer: { bot: true } }).viewer.request("paul", "f".repeat(24), { path: "/" })).status).toBe(403)
    expect((await pair({ viewer: { muted: true } }).viewer.request("paul", "f".repeat(24), { path: "/" })).status).toBe(403)
  })
  test("an unknown share id gets 404", async () => {
    const { viewer } = pair()
    expect((await viewer.request("paul", "e".repeat(24), { path: "/" })).status).toBe(404)
  })
  test("expiry cuts it off", async () => {
    const { viewer, share } = pair({ share: { expiresAt: Date.now() + 300 } })
    expect((await viewer.request("paul", share.id, { path: "/" })).status).toBe(200)
    await Bun.sleep(350)
    expect((await viewer.request("paul", share.id, { path: "/" })).status).toBe(410)
  })
  test("revoking stops what is open (a websocket), and what comes after", async () => {
    const { viewer, share, owner } = pair()
    const l = viewer.listen({ id: share.id, owner: "paul" })
    const ws = new WebSocket(`ws://127.0.0.1:${l.port}/ws`)
    await new Promise((r) => (ws.onopen = r))
    const closed = new Promise<number>((r) => (ws.onclose = (e) => r(e.code)))
    share.revokedAt = Date.now()
    expect(owner.stop(share.id)).toBe(1)
    expect(await closed).toBe(1008)
    expect((await viewer.request("paul", share.id, { path: "/" })).status).toBe(410)
    l.stop()
  })
  test("the viewer's listener refuses a page that reached it by DNS rebinding", async () => {
    const { viewer, share } = pair()
    const l = viewer.listen({ id: share.id, owner: "paul" })
    const r = await fetch(`http://127.0.0.1:${l.port}/`, { headers: { host: "evil.example" } })
    expect(r.status).toBe(421)
    l.stop()
  })
  test("too much, too fast from one person is refused (429)", async () => {
    const share: OwnerShare = { id: "f".repeat(24), with: [{ label: "marie", fingerprint: "fp-m" }], expiresAt: Date.now() + F.HOUR }
    const sent: F.ResFrame[] = []
    const owner = new ShareOwner({ share: () => share, port: () => srv.port!, viewer: () => ({ fingerprint: "fp-m" }), send: (_l, f) => void sent.push(f), inbound: { fps: 1, bps: 1000, burstFrames: 2, burstBytes: 1000 } })
    for (let i = 0; i < 4; i++) owner.onFrame("marie", { op: "req", share: share.id, s: `stream-${i}xxxx`, q: 0, method: "GET", path: "/", headers: [] })
    expect(sent.filter((f) => f.op === "error" && (f as any).status === 429).length).toBe(2)
  })
  test("a replayed opening frame opens nothing", async () => {
    const share: OwnerShare = { id: "f".repeat(24), with: [{ label: "marie", fingerprint: "fp-m" }], expiresAt: Date.now() + F.HOUR }
    let opened = 0
    const owner = new ShareOwner({ share: () => share, port: () => { opened++; return srv.port! }, viewer: () => ({ fingerprint: "fp-m" }), send: () => {} })
    const f = { op: "req", share: share.id, s: "stream-replay", q: 0, method: "POST", path: "/echo", headers: [] } as const
    owner.onFrame("marie", f)
    owner.onFrame("marie", { op: "abort", share: share.id, s: "stream-replay", q: 1 })
    owner.onFrame("marie", f)
    expect(opened).toBe(1)
  })
})

describe("both people's panes", () => {
  test("Running has a Shown to people group: who yours is open to and for how long, whose a teammate's is, and an ended one reads as ended", async () => {
    const { runningGroups, runningLine } = await import("../src/ui-extra/pure.ts")
    const { project } = await import("../src/threads/running.ts")
    const now = Date.parse("2026-11-02T10:00:00Z")
    const items = project("auth", {
      now,
      servers: [{ name: "web", ports: [4100], url: "http://localhost:4100" }],
      out: [{ id: "sh1", urlId: "svc:x", label: "auth · web", name: "auth", thread: "auth", target: { svc: "web" }, with: [{ label: "marie", fingerprint: "fp-m" }], createdAt: now - 3600_000, expiresAt: now + 7 * 3600_000 }],
      in: [{ id: "sh2", owner: "paul", fingerprint: "fp-p", label: "auth · web", name: "auth", thread: "auth", expiresAt: now - 1, at: now - 9 * 3600_000, ended: "expired" }],
      urls: [{ id: "shared:1", url: "http://auth.paul.localhost:1355", kind: "shared", source: "share", label: "auth · web", thread: "auth", name: "auth.paul.localhost", firstSeen: 0, lastSeen: 0, lastCheck: 0, alive: false }],
    })
    const g = runningGroups(items)
    expect(g.map((x) => x.title)).toEqual(["Servers", "Shown to people"])
    const shares = g[1]!.items
    expect(shares.map((r) => runningLine(r, now))).toEqual(["● auth · web · with marie · 7h left", "○ auth · web · from paul · ended"])
    expect(shares[1]!.owner).toBe("paul")
  })
})
