// Live `stream` frames on the hosted relay: what they may cost, and the
// bookkeeping that keeps them to it. Pure, so it is tested without a Worker
// (worker/test/streams.test.ts); index.ts holds the sockets and the storage.
//
// Sharing a running server (src/share/) sends many small frames. On the
// self-hosted relay that is the host's own machine; here it is a free plan
// shared by everyone, which fails closed at 100,000 Durable Object requests a
// day. So a stream frame is relayed live and nothing else: never stored, never
// acked, never held for someone offline. And it is counted, in memory, against
// three budgets: a burst (as relay/relay.ts), a day per sender, and a day for
// every sender at once (the StreamPool object). README.md has the arithmetic.

export type Limits = {
  /** Frames and bytes one sender may stream per UTC day. */
  dayFrames: number
  dayBytes: number
  /** Frames and bytes one sender may stream per burst window (relay/relay.ts's numbers). */
  burstFrames: number
  burstBytes: number
  burstMs: number
  /** Frames every sender together may stream per UTC day. */
  poolFrames: number
}

export const DEFAULTS: Limits = {
  dayFrames: 4000,
  dayBytes: 256 * 1024 * 1024,
  burstFrames: 1500,
  burstBytes: 48 * 1024 * 1024,
  burstMs: 10_000,
  poolFrames: 15_000,
}

const num = (v: unknown, d: number) => {
  const n = Number(v)
  return v !== undefined && v !== "" && Number.isFinite(n) && n >= 0 ? n : d
}

/** The limits, with wrangler vars (tests set them small) over the defaults. */
export function limits(env: Record<string, unknown> = {}): Limits {
  return {
    dayFrames: num(env.STREAM_DAY_FRAMES, DEFAULTS.dayFrames),
    dayBytes: num(env.STREAM_DAY_BYTES, DEFAULTS.dayBytes),
    burstFrames: num(env.STREAM_BURST_FRAMES, DEFAULTS.burstFrames),
    burstBytes: num(env.STREAM_BURST_BYTES, DEFAULTS.burstBytes),
    burstMs: num(env.STREAM_BURST_MS, DEFAULTS.burstMs),
    poolFrames: num(env.STREAM_POOL_FRAMES, DEFAULTS.poolFrames),
  }
}

export const DAY_MS = 24 * 60 * 60_000
/** The free plan's limits reset at 00:00 UTC, so the allowance does too. */
export const utcDay = (t: number) => new Date(t).toISOString().slice(0, 10)
export const nextUtcMidnight = (t: number) => (Math.floor(t / DAY_MS) + 1) * DAY_MS

/** What `ready` says, so a client knows the terms before it starts. */
export const advertised = (l: Limits) => ({
  day: { frames: l.dayFrames, bytes: l.dayBytes },
  burst: { frames: l.burstFrames, bytes: l.burstBytes, ms: l.burstMs },
  pool: { frames: l.poolFrames },
})

/** One sender's day so far, and what it holds from the shared pool. */
export type Snapshot = { day: string; frames: number; bytes: number; pool: number }

export type Verdict = "ok" | "burst" | "day" | "pool"

/**
 * One sender's allowance. Lives in the sender's Mailbox object; a snapshot of
 * it rides on the sender's socket (serializeAttachment, which survives
 * hibernation and is not storage) and goes to storage only now and then.
 */
export class Allowance {
  s: Snapshot
  private win = { at: 0, frames: 0, bytes: 0 }
  /** Frames counted since the snapshot last went to storage. */
  unsaved = 0
  /** How many frames the next reservation from the pool asks for. */
  chunk = 50

  constructor(
    private l: Limits,
    now: number,
    saved: (Snapshot | undefined | null)[] = [],
  ) {
    this.s = { day: utcDay(now), frames: 0, bytes: 0, pool: 0 }
    for (const x of saved) this.merge(x)
  }

  /** The furthest along of what was saved and what is here: frames only ever go up within a day. */
  merge(x: Snapshot | undefined | null) {
    if (!x || typeof x.day !== "string") return
    if (x.day > this.s.day) this.s = { day: x.day, frames: x.frames | 0, bytes: x.bytes | 0, pool: x.pool | 0 }
    else if (x.day === this.s.day && (x.frames | 0) > this.s.frames) this.s = { ...this.s, frames: x.frames | 0, bytes: Math.max(this.s.bytes, x.bytes | 0), pool: x.pool | 0 }
  }

  private roll(now: number) {
    const day = utcDay(now)
    if (day !== this.s.day) {
      this.s = { day, frames: 0, bytes: 0, pool: 0 }
      this.chunk = 50
    }
    if (now - this.win.at >= this.l.burstMs) this.win = { at: now, frames: 0, bytes: 0 }
  }

  /** Over the day (the sender's, or everyone's), whatever the frame: nothing more today. */
  spent(now: number): "day" | null {
    this.roll(now)
    return this.s.frames >= this.l.dayFrames || this.s.bytes >= this.l.dayBytes ? "day" : null
  }

  /** How many frames to ask the pool for, or 0 when what is held covers the next one. */
  need(now: number): number {
    this.roll(now)
    if (this.s.pool > 0) return 0
    return Math.max(1, Math.min(this.chunk, this.l.dayFrames - this.s.frames))
  }

  /** What the pool granted. Asking for more next time, as this sender evidently streams. */
  granted(n: number) {
    this.s.pool += Math.max(0, n | 0)
    this.chunk = Math.min(400, this.chunk * 2)
  }

  /**
   * Take one frame of `bytes`, or say which budget refuses it. A refused frame
   * is not counted: it costs only its incoming message, never a forward.
   */
  take(bytes: number, now: number): Verdict {
    this.roll(now)
    if (this.s.frames >= this.l.dayFrames || this.s.bytes + bytes > this.l.dayBytes) return "day"
    if (this.win.frames >= this.l.burstFrames || this.win.bytes + bytes > this.l.burstBytes) return "burst"
    if (this.s.pool < 1) return "pool"
    this.s.pool--
    this.s.frames++
    this.s.bytes += bytes
    this.win.frames++
    this.win.bytes += bytes
    this.unsaved++
    return "ok"
  }

  /** Worth a storage write: every 1000 frames, or the moment the day is spent so that survives anything. */
  shouldSave(now: number): boolean {
    return this.unsaved >= 1000 || (this.unsaved > 0 && this.spent(now) === "day")
  }

  saved() {
    this.unsaved = 0
  }
}

/** The pool's day: how much every sender together has taken. */
export function grant(state: { day: string; used: number } | undefined, want: number, l: Limits, now: number) {
  const day = utcDay(now)
  const s = state && state.day === day ? { ...state } : { day, used: 0 }
  const n = Math.max(0, Math.min(Math.floor(want), 1000, l.poolFrames - s.used))
  s.used += n
  return { state: s, grant: n, left: l.poolFrames - s.used }
}

export const PAUSED =
  "sharing through the shared relay is paused until tomorrow (00:00 UTC); ordinary messages still work. To keep sharing now, run your own relay with `--host` or deploy `worker/`"

/** The error frame a refused stream gets: once per reason and day on each socket. */
export function pausedFrame(why: "day" | "pool", l: Limits, now: number) {
  return {
    t: "error",
    code: "stream_paused",
    scope: why === "day" ? "sender" : "relay",
    until: nextUtcMidnight(now),
    allowance: advertised(l),
    message:
      why === "day"
        ? `${PAUSED}. You have streamed today's allowance (${l.dayFrames} frames).`
        : `${PAUSED}. Everyone's sharing together has used the shared relay's daily allowance (${l.poolFrames} frames).`,
  }
}
