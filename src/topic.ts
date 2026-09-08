// A room is a topic on a public pub/sub service, and that is the whole
// transport. Nobody runs a relay, nothing needs a public address, and NAT stops
// mattering, because both sides make outbound connections to the same place.
//
// What the service can see: that a topic exists, how big the messages are and
// when they arrive. Never what they say, because everything published here is
// already sealed with the room key. A topic id is 128 random bits so nobody
// stumbles onto yours, and anything that arrives which does not open with the
// room key is dropped.
//
// Two limits shape this. A single message caps at about 4 KB, so anything
// larger is split and reassembled. And the service keeps recent messages, which
// is how someone who was offline catches up.

import crypto from "node:crypto"

export type TopicOptions = {
  /** Base URL of the pub/sub service. */
  base?: string
  onFrame: (frame: unknown) => void
  onStatus?: (up: boolean) => void
}

const DEFAULT_BASE = process.env.CROSSTALK_TOPIC_BASE ?? "https://ntfy.sh"

/** Room ids are random, not derived from anything, so they leak nothing. */
export const newTopicId = () => "ct1" + crypto.randomBytes(16).toString("hex")

// Base64 inflates by a third, and the envelope around a chunk costs a little
// more, so keep each piece well under the ceiling.
const CHUNK_BYTES = 2600
const CACHE_WINDOW = "12h"

type Piece = { v: 1; m: string; i: number; n: number; d: string }

export class Topic {
  private ws: WebSocket | null = null
  private closed = false
  private backoff = 1000
  private partial = new Map<string, { pieces: (string | undefined)[]; at: number }>()
  private seen = new Set<string>()
  private base: string

  constructor(
    readonly id: string,
    private opts: TopicOptions,
  ) {
    this.base = opts.base ?? DEFAULT_BASE
    setInterval(() => this.sweep(), 60_000).unref?.()
  }

  private sweep() {
    const cutoff = Date.now() - 10 * 60_000
    for (const [k, v] of this.partial) if (v.at < cutoff) this.partial.delete(k)
    if (this.seen.size > 5000) this.seen.clear()
  }

  /** Anything published to this topic since we were last listening. */
  async catchUp(since = CACHE_WINDOW) {
    try {
      const r = await fetch(`${this.base}/${this.id}/json?poll=1&since=${since}`, {
        signal: AbortSignal.timeout(15_000),
      })
      if (!r.ok) return
      for (const line of (await r.text()).split("\n")) {
        if (!line.trim()) continue
        try {
          const m = JSON.parse(line)
          if (m.event === "message" && typeof m.message === "string") this.take(m.message)
        } catch {}
      }
    } catch {}
  }

  connect() {
    if (this.closed) return
    const ws = new WebSocket(`${this.base.replace(/^http/, "ws")}/${this.id}/ws`)
    this.ws = ws
    ws.onopen = () => {
      this.backoff = 1000
      this.opts.onStatus?.(true)
      this.catchUp()
    }
    ws.onmessage = (e) => {
      try {
        const m = JSON.parse(String(e.data))
        if (m.event === "message" && typeof m.message === "string") this.take(m.message)
      } catch {}
    }
    ws.onclose = () => {
      this.ws = null
      this.opts.onStatus?.(false)
      if (this.closed) return
      this.backoff = Math.min(this.backoff * 2, 30_000)
      setTimeout(() => this.connect(), this.backoff)
    }
    ws.onerror = () => {}
  }

  close() {
    this.closed = true
    try {
      this.ws?.close()
    } catch {}
  }

  get connected() {
    return this.ws?.readyState === 1
  }

  /** Split, publish, and let the far side put it back together. */
  async publish(frame: unknown): Promise<boolean> {
    const body = Buffer.from(JSON.stringify(frame), "utf8").toString("base64")
    const id = crypto.randomBytes(8).toString("hex")
    const total = Math.max(1, Math.ceil(body.length / CHUNK_BYTES))
    for (let i = 0; i < total; i++) {
      const piece: Piece = {
        v: 1,
        m: id,
        i,
        n: total,
        d: body.slice(i * CHUNK_BYTES, (i + 1) * CHUNK_BYTES),
      }
      let sent = false
      for (let attempt = 0; attempt < 3 && !sent; attempt++) {
        try {
          const r = await fetch(`${this.base}/${this.id}`, {
            method: "POST",
            body: JSON.stringify(piece),
            signal: AbortSignal.timeout(15_000),
          })
          sent = r.ok
        } catch {}
        if (!sent) await new Promise((r) => setTimeout(r, 500 * (attempt + 1)))
      }
      if (!sent) return false
    }
    return true
  }

  private take(raw: string) {
    let p: Piece
    try {
      p = JSON.parse(raw)
    } catch {
      return
    }
    if (p?.v !== 1 || typeof p.m !== "string" || typeof p.d !== "string") return

    if (p.n === 1) return this.deliver(p.m, p.d)

    const entry = this.partial.get(p.m) ?? { pieces: new Array(p.n), at: Date.now() }
    entry.pieces[p.i] = p.d
    entry.at = Date.now()
    this.partial.set(p.m, entry)
    if (entry.pieces.filter(Boolean).length !== p.n) return
    this.partial.delete(p.m)
    this.deliver(p.m, entry.pieces.join(""))
  }

  private deliver(id: string, b64: string) {
    // Catching up replays what we already had, so drop anything seen before.
    if (this.seen.has(id)) return
    this.seen.add(id)
    try {
      this.opts.onFrame(JSON.parse(Buffer.from(b64, "base64").toString("utf8")))
    } catch {}
  }
}
