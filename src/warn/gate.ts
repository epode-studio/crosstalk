// Rate limit with coalescing: the first heads-up for a (file, thread) goes at
// once; anything more within the window waits and goes as one at its end.
// An agent in the middle of a refactor edits a file twenty times a minute,
// and the other thread needs to hear that once, not twenty times.

export type Clock = { now: () => number; after: (ms: number, fn: () => void) => unknown }

const realClock: Clock = {
  now: () => Date.now(),
  after: (ms, fn) => {
    const t = setTimeout(fn, ms)
    ;(t as any).unref?.()
    return t
  },
}

export class Gate<T> {
  private last = new Map<string, number>()
  private queued = new Map<string, T[]>()
  private timers = new Set<string>()

  constructor(
    private windowMs: number,
    private flush: (key: string, items: T[]) => void,
    private clock: Clock = realClock,
  ) {}

  /** "sent" when it went now, "queued" when it will go with others at the window's end. */
  offer(key: string, item: T): "sent" | "queued" {
    const now = this.clock.now()
    const last = this.last.get(key)
    if (last === undefined || now - last >= this.windowMs) {
      if (!this.timers.has(key)) {
        this.last.set(key, now)
        this.flush(key, [item])
        return "sent"
      }
    }
    ;(this.queued.get(key) ?? this.queued.set(key, []).get(key)!).push(item)
    if (!this.timers.has(key)) {
      this.timers.add(key)
      this.clock.after(Math.max(0, (last ?? now) + this.windowMs - now), () => {
        this.timers.delete(key)
        const items = this.queued.get(key) ?? []
        this.queued.delete(key)
        if (!items.length) return
        this.last.set(key, this.clock.now())
        this.flush(key, items)
      })
    }
    return "queued"
  }
}
