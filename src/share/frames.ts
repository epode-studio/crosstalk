// Sharing a running server with a teammate (docs/urls.md, "Sharing"): the wire
// format and the rules both ends hold it to. Pure; owner.ts, viewer.ts and
// daemon.ts use it, and test/share.test.ts tests it on its own.
//
// HTTP goes over crosstalk's sealed peer channel as frames, one stream per
// request (or websocket):
//
//   viewer → owner   req {method, path, headers, ws?, protocols?}, body, end,
//                    abort, wsmsg, wsclose
//   owner → viewer   res {status, headers}, body, end, error {status, message},
//                    wsopen {protocol}, wsmsg, wsclose
//
// A frame names its share and its stream, never a host or a port: the owner
// forwards only to the one service the share was made for, whatever a frame
// says. Bodies are cut into CHUNK-sized pieces, each its own frame, so a large
// response streams instead of waiting to be whole, and no frame comes near
// the relay's 1 MB limit.

import crypto from "node:crypto"

/** Raw bytes per body frame: base64 and sealing put it near 90 KB on the wire. */
export const CHUNK = 48 * 1024
/** A request body larger than this is refused (413). */
export const MAX_REQUEST_BODY = 32 * 1024 * 1024
/** A response larger than this is cut off. */
export const MAX_RESPONSE_BODY = 256 * 1024 * 1024
/** One websocket message at most. */
export const MAX_WS_MESSAGE = 16 * 1024 * 1024
/** Streams open at once, per person and share. */
export const MAX_STREAMS = 64
export const MAX_HEADERS = 100
export const MAX_HEADER_BYTES = 64 * 1024
export const MAX_PATH = 8 * 1024
/** A data frame older (or newer) than this is dropped: the relay cannot hold one back and play it later. */
export const FRAME_SKEW_MS = 2 * 60_000
/** An offer or a revocation older than this is dropped. */
export const OFFER_SKEW_MS = 10 * 60_000

export const HOUR = 60 * 60_000
/** A share lasts eight hours unless asked otherwise. */
export const DEFAULT_MS = 8 * HOUR
/** And never more than a week. */
export const MAX_MS = 7 * 24 * HOUR
/** A public link lasts an hour unless asked otherwise, and never more than eight. */
export const PUBLIC_DEFAULT_MS = HOUR
export const PUBLIC_MAX_MS = 8 * HOUR

export type Headers = [string, string][]

/** viewer → owner */
export type ReqFrame =
  | { op: "req"; share: string; s: string; q: number; method: string; path: string; headers: Headers; ws?: boolean; protocols?: string[] }
  | { op: "body"; share: string; s: string; q: number; d: string }
  | { op: "end"; share: string; s: string; q: number }
  | { op: "abort"; share: string; s: string; q: number }
  | { op: "wsmsg"; share: string; s: string; q: number; d: string; b?: boolean }
  | { op: "wsclose"; share: string; s: string; q: number; code?: number; reason?: string }

/** owner → viewer */
export type ResFrame =
  | { op: "res"; share: string; s: string; q: number; status: number; statusText?: string; headers: Headers }
  | { op: "body"; share: string; s: string; q: number; d: string }
  | { op: "end"; share: string; s: string; q: number }
  | { op: "error"; share: string; s: string; q: number; status: number; message: string }
  | { op: "wsopen"; share: string; s: string; q: number; protocol?: string }
  | { op: "wsmsg"; share: string; s: string; q: number; d: string; b?: boolean }
  | { op: "wsclose"; share: string; s: string; q: number; code?: number; reason?: string }

export type DataFrame = ReqFrame | ResFrame

/** Control messages, sent reliably (queued while the relay is down). */
export type Control =
  | { op: "offer"; id: string; label: string; name: string; thread?: string; expiresAt: number }
  | { op: "revoke"; id: string; why?: "revoked" | "expired" | "removed" }
  | { op: "decline"; id: string }

export const newId = () => crypto.randomBytes(12).toString("hex")
export const isId = (s: unknown): s is string => typeof s === "string" && /^[a-f0-9]{16,48}$/.test(s)

// --- bodies -------------------------------------------------------------------------

/** A buffer cut into CHUNK-sized pieces, in order. */
export function chunks(b: Uint8Array, size = CHUNK): Buffer[] {
  const buf = Buffer.from(b.buffer, b.byteOffset, b.byteLength)
  const out: Buffer[] = []
  for (let i = 0; i < buf.length; i += size) out.push(buf.subarray(i, Math.min(buf.length, i + size)))
  return out
}

export const enc = (b: Uint8Array) => Buffer.from(b.buffer, b.byteOffset, b.byteLength).toString("base64")
export const dec = (s: unknown) => (typeof s === "string" ? Buffer.from(s, "base64") : Buffer.alloc(0))

// --- headers ------------------------------------------------------------------------

/** Hop-by-hop headers (RFC 9110 7.6.1), and the ones a proxy must not pass on. */
export const HOP = new Set(["connection", "keep-alive", "proxy-connection", "proxy-authenticate", "proxy-authorization", "te", "trailer", "trailers", "transfer-encoding", "upgrade", "http2-settings"])
/** Set by the websocket handshake on each hop, never passed through. */
const WS_HOP = new Set(["sec-websocket-key", "sec-websocket-version", "sec-websocket-extensions", "sec-websocket-accept", "sec-websocket-protocol"])

const TOKEN = /^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/
const VALUE_BAD = /[\r\n\0]/

/**
 * Headers fit to pass on: hop-by-hop ones out (and any the Connection header
 * names), the websocket handshake's own out, names that are not tokens and
 * values with line breaks out, at most MAX_HEADERS and MAX_HEADER_BYTES.
 * `drop` takes out more (a prefix ending in `*` matches by prefix).
 */
export function cleanHeaders(h: unknown, o: { drop?: string[] } = {}): Headers {
  if (!Array.isArray(h)) return []
  const pairs = h.filter((p): p is [string, string] => Array.isArray(p) && typeof p[0] === "string" && typeof p[1] === "string")
  const named = new Set<string>()
  for (const [k, v] of pairs) if (k.toLowerCase() === "connection") for (const n of v.split(",")) named.add(n.trim().toLowerCase())
  const drop = (o.drop ?? []).map((d) => d.toLowerCase())
  const dropped = (k: string) => drop.some((d) => (d.endsWith("*") ? k.startsWith(d.slice(0, -1)) : k === d))
  const out: Headers = []
  let bytes = 0
  for (const [k0, v] of pairs) {
    const k = k0.toLowerCase()
    if (!TOKEN.test(k0) || VALUE_BAD.test(v)) continue
    if (HOP.has(k) || WS_HOP.has(k) || named.has(k) || dropped(k)) continue
    bytes += k.length + v.length + 4
    if (out.length >= MAX_HEADERS || bytes > MAX_HEADER_BYTES) break
    out.push([k0, v])
  }
  return out
}

/** A Headers object (or node's rawHeaders) as pairs. */
export function pairsOf(h: globalThis.Headers | string[]): Headers {
  if (Array.isArray(h)) {
    const out: Headers = []
    for (let i = 0; i + 1 < h.length; i += 2) out.push([h[i], h[i + 1]])
    return out
  }
  const out: Headers = []
  h.forEach((v, k) => {
    if (k === "set-cookie") return
    out.push([k, v])
  })
  for (const c of (h as any).getSetCookie?.() ?? []) out.push(["set-cookie", c])
  return out
}

// --- what a request may be ---------------------------------------------------------------

const METHOD = /^[A-Z][A-Z0-9-]{0,23}$/

/**
 * Why a request is refused, or null when it may go to the shared service. The
 * path must be origin-form (`/…`): an absolute URL (`http://other:port/`) or an
 * authority (`host:port`, CONNECT's) never is, and CONNECT and TRACE are not
 * taken at all.
 */
export function refuseRequest(f: { method?: unknown; path?: unknown }): string | null {
  const m = typeof f.method === "string" ? f.method : ""
  if (!METHOD.test(m)) return "not an HTTP method"
  if (m === "CONNECT" || m === "TRACE") return `${m} is not passed on`
  const p = typeof f.path === "string" ? f.path : ""
  if (!p.startsWith("/") || p.startsWith("//")) return "only a path on the shared server, never another host or port"
  if (p.length > MAX_PATH) return "path too long"
  if (/[\s\0\x7f]/.test(p) || /[\u0080-￿]/.test(p)) return "path has characters a request line cannot carry"
  return null
}

/** The Host the owner's server is sent: the viewer's, when it is a `*.localhost` name or loopback; else `localhost:<port>`. */
export function hostFor(viewerHost: string | undefined, port: number): string {
  const h = (viewerHost ?? "").trim().toLowerCase()
  const bare = h.replace(/:\d+$/, "")
  if (h && h.length < 256 && /^[a-z0-9.:[\]-]+$/.test(h) && (bare === "localhost" || bare.endsWith(".localhost") || bare === "127.0.0.1" || bare === "[::1]")) return h
  return `localhost:${port}`
}

/** A Host header a local listener answers: loopback names only, so a page that reached the port by DNS rebinding gets nothing. */
export function loopbackHost(hostHeader: string | null | undefined): boolean {
  if (!hostHeader) return false
  const h = hostHeader.trim().toLowerCase()
  const bare = h.startsWith("[") ? h.replace(/:\d+$/, "") : h.replace(/:\d+$/, "")
  return bare === "localhost" || bare.endsWith(".localhost") || bare === "127.0.0.1" || bare === "[::1]"
}

// --- order and replays -------------------------------------------------------------------

/**
 * Each stream's frames carry 0, 1, 2…; a frame that is not the next one is a
 * replay, a reorder or a gap, and ends the stream. A stream id is taken once
 * (for FRAME_SKEW_MS and more), so an old `req` played again opens nothing.
 */
export class Order {
  private next = new Map<string, number>()
  private used = new Map<string, number>()
  constructor(private now: () => number = Date.now) {}
  /** "ok", or why the frame is dropped. */
  take(key: string, q: unknown, opening: boolean): "ok" | "replay" | "gap" {
    if (typeof q !== "number" || !Number.isInteger(q) || q < 0) return "gap"
    if (opening) {
      if (q !== 0) return "gap"
      if (this.used.has(key)) return "replay"
      this.sweep()
      this.used.set(key, this.now())
      this.next.set(key, 1)
      return "ok"
    }
    const want = this.next.get(key)
    if (want === undefined) return "gap"
    if (q < want) return "replay"
    if (q > want) return "gap"
    this.next.set(key, want + 1)
    return "ok"
  }
  close(key: string) {
    this.next.delete(key)
  }
  open(key: string) {
    return this.next.has(key)
  }
  private sweep() {
    const cutoff = this.now() - 2 * FRAME_SKEW_MS - 60_000
    if (this.used.size < 1024) return
    for (const [k, t] of this.used) if (t < cutoff) this.used.delete(k)
  }
}

/** A frame's envelope time is within FRAME_SKEW_MS of ours. */
export const fresh = (ts: unknown, now = Date.now(), skew = FRAME_SKEW_MS) => typeof ts === "number" && Math.abs(now - ts) <= skew

// --- pacing -------------------------------------------------------------------------------

/**
 * A token bucket on frames and bytes: how long to wait before sending one of
 * `bytes`. Both ends pace what they send so the relay's own limit is never
 * reached, and the owner holds a person to the same budget on what arrives.
 */
export class Pacer {
  private frames: number
  private bytes: number
  private at: number
  constructor(
    private o: { fps: number; bps: number; burstFrames: number; burstBytes: number },
    private now: () => number = Date.now,
  ) {
    this.frames = o.burstFrames
    this.bytes = o.burstBytes
    this.at = now()
  }
  private refill() {
    const t = this.now()
    const dt = Math.max(0, t - this.at) / 1000
    this.at = t
    this.frames = Math.min(this.o.burstFrames, this.frames + dt * this.o.fps)
    this.bytes = Math.min(this.o.burstBytes, this.bytes + dt * this.o.bps)
  }
  /** Take a frame of `bytes` now and say how many ms to wait before it goes (0: at once). */
  delay(bytes: number): number {
    this.refill()
    this.frames -= 1
    this.bytes -= bytes
    const f = this.frames < 0 ? (-this.frames / this.o.fps) * 1000 : 0
    const b = this.bytes < 0 ? (-this.bytes / this.o.bps) * 1000 : 0
    return Math.ceil(Math.max(f, b))
  }
  /** Within budget, or over it (nothing taken when over). */
  allow(bytes: number): boolean {
    this.refill()
    if (this.frames < 1 || this.bytes < bytes) return false
    this.frames -= 1
    this.bytes -= bytes
    return true
  }
}

/** What the daemon sends at, by how the relay carries frames. */
export function pacing(mode: "stream" | "send" | "worker") {
  // The self-hosted relay's `send` allows 60 a minute per sender; its `stream` far more (relay/relay.ts).
  if (mode === "send") return { fps: 0.9, bps: 512 * 1024, burstFrames: 20, burstBytes: 2 * 1024 * 1024 }
  return { fps: 80, bps: 3 * 1024 * 1024, burstFrames: 400, burstBytes: 12 * 1024 * 1024 }
}

// --- how long ------------------------------------------------------------------------------

/**
 * How long a share lasts: `for` in plain words (`2h`, `30m`, `a day`, a number
 * of minutes) or `until 18:00`; eight hours by default (one for a public link),
 * a week at most (eight hours for a public link). An error for what cannot be
 * read, or for "forever".
 */
export function expiry(v: unknown, o: { now?: number; public?: boolean } = {}): { ms: number } | { error: string } {
  const now = o.now ?? Date.now()
  const max = o.public ? PUBLIC_MAX_MS : MAX_MS
  const def = o.public ? PUBLIC_DEFAULT_MS : DEFAULT_MS
  if (v === undefined || v === null || v === "") return { ms: def }
  if (typeof v === "number") return v > 0 ? { ms: Math.min(max, Math.round(v * 60_000)) } : { error: "a share needs a time to last" }
  const s = String(v).trim().toLowerCase()
  if (/^(forever|always|for good|indefinitely)/.test(s)) return { error: `a share lasts ${o.public ? "eight hours" : "a week"} at most; say how long` }
  const at = /^(?:until|till|til)\s+(\d{1,2})(?::(\d{2}))?\s*(am|pm)?$/.exec(s)
  if (at) {
    let h = Number(at[1])
    const m = Number(at[2] ?? 0)
    if (at[3] === "pm" && h < 12) h += 12
    if (at[3] === "am" && h === 12) h = 0
    if (h > 23 || m > 59) return { error: `"${v}" is not a time` }
    const d = new Date(now)
    d.setHours(h, m, 0, 0)
    if (d.getTime() <= now) d.setDate(d.getDate() + 1)
    return { ms: Math.min(max, d.getTime() - now) }
  }
  if (/tomorrow/.test(s)) {
    const d = new Date(now)
    d.setDate(d.getDate() + 1)
    d.setHours(9, 0, 0, 0)
    return { ms: Math.min(max, d.getTime() - now) }
  }
  const m = /^(?:for\s+)?(an?|\d+(?:\.\d+)?)\s*(m|min|mins|minutes?|h|hr|hrs|hours?|d|days?|w|weeks?)?$/.exec(s)
  if (!m) return { error: `"${v}" is not a length of time: say 2h, 30m, a day or until 18:00` }
  const n = m[1] === "a" || m[1] === "an" ? 1 : Number(m[1])
  const unit = m[2] ?? "m"
  const per = /^m/.test(unit) ? 60_000 : /^h/.test(unit) ? HOUR : /^d/.test(unit) ? 24 * HOUR : 7 * 24 * HOUR
  const ms = Math.round(n * per)
  if (!(ms > 0)) return { error: "a share needs a time to last" }
  return { ms: Math.min(max, ms) }
}

const pad = (n: number) => String(n).padStart(2, "0")
const DAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"]

/** `until 18:00` today, `until Tue 09:00` another day: in this machine's time. */
export function untilText(at: number, now = Date.now()): string {
  const d = new Date(at)
  const hm = `${pad(d.getHours())}:${pad(d.getMinutes())}`
  return new Date(now).toDateString() === d.toDateString() ? `until ${hm}` : `until ${DAYS[d.getDay()]} ${hm}`
}

// --- who ------------------------------------------------------------------------------------

export type PersonCheck = { label: string; fingerprint?: string; bot?: boolean; muted?: boolean; level?: string }

/**
 * Who a share may go to, from the names given: each must be exactly a person
 * this machine has a direct channel with (case aside, `@` aside), and not an
 * agent, not muted, not at `mute`. Never a prefix, never a guess.
 */
export function resolvePeople(names: unknown, peers: Record<string, PersonCheck>, me?: string): { ok: PersonCheck[] } | { error: string } {
  const list = (Array.isArray(names) ? names : typeof names === "string" ? names.split(/[,\s]+/) : []).map((n) => String(n).trim().replace(/^@/, "")).filter(Boolean)
  if (!list.length) return { error: "say who to share it with: with: [\"marie\"]" }
  const byLower = new Map(Object.values(peers).map((p) => [p.label.toLowerCase(), p]))
  const out: PersonCheck[] = []
  for (const n of list) {
    if (me && n.toLowerCase() === me.toLowerCase()) return { error: "that is you" }
    const p = byLower.get(n.toLowerCase())
    if (!p || !p.fingerprint) {
      const known = Object.values(peers).filter((x) => !x.bot).map((x) => x.label)
      return { error: `nobody called "${n}" has a direct channel with you${known.length ? `; people: ${known.join(", ")}` : ""}` }
    }
    if (p.bot) return { error: `${p.label} is an agent: a running server is shared with people only` }
    if (p.muted || p.level === "mute") return { error: `${p.label} is muted here: unmute them first if you mean to share with them` }
    if (!out.some((x) => x.fingerprint === p.fingerprint)) out.push(p)
  }
  return { ok: out }
}

/** Whether a frame from `fingerprint` may use the share now; null when it may. */
export function refuseViewer(
  share: { with: { fingerprint: string }[]; expiresAt: number; revokedAt?: number } | undefined,
  viewer: { fingerprint?: string; bot?: boolean; muted?: boolean; level?: string },
  now = Date.now(),
): { status: number; message: string } | null {
  if (!share) return { status: 404, message: "no such share" }
  if (share.revokedAt) return { status: 410, message: "the share was stopped" }
  if (share.expiresAt <= now) return { status: 410, message: "the share has expired" }
  if (!viewer.fingerprint || !share.with.some((w) => w.fingerprint === viewer.fingerprint)) return { status: 403, message: "not shared with you" }
  if (viewer.bot) return { status: 403, message: "not shared with agents" }
  if (viewer.muted || viewer.level === "mute") return { status: 403, message: "not shared with you now" }
  return null
}
