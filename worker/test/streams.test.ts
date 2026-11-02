// The hosted relay's stream allowance, as pure bookkeeping (worker/src/streams.ts).
// worker.test.ts runs the same rules inside a local Worker.

import { describe, expect, test } from "bun:test"
import * as St from "../src/streams.ts"

const L: St.Limits = { dayFrames: 20, dayBytes: 1000, burstFrames: 5, burstBytes: 400, burstMs: 10_000, poolFrames: 30 }
const T0 = Date.UTC(2026, 10, 2, 12, 0, 0)

function fed(a: St.Allowance, now: number) {
  const n = a.need(now)
  if (n) a.granted(n)
}

describe("allowance", () => {
  test("defaults and overrides", () => {
    expect(St.limits({})).toEqual(St.DEFAULTS)
    expect(St.limits({ STREAM_DAY_FRAMES: "7", STREAM_POOL_FRAMES: "" }).dayFrames).toBe(7)
    expect(St.limits({ STREAM_POOL_FRAMES: "" }).poolFrames).toBe(St.DEFAULTS.poolFrames)
    expect(St.limits({ STREAM_DAY_FRAMES: "-3" }).dayFrames).toBe(St.DEFAULTS.dayFrames)
  })

  test("burst: five a window, then refused uncounted; the next window takes more", () => {
    const a = new St.Allowance(L, T0)
    const got: St.Verdict[] = []
    for (let i = 0; i < 7; i++) {
      fed(a, T0)
      got.push(a.take(10, T0))
    }
    expect(got).toEqual(["ok", "ok", "ok", "ok", "ok", "burst", "burst"])
    expect(a.s.frames).toBe(5)
    fed(a, T0 + 10_000)
    expect(a.take(10, T0 + 10_000)).toBe("ok")
    // Bytes count as well as frames.
    const b = new St.Allowance(L, T0)
    fed(b, T0)
    expect(b.take(399, T0)).toBe("ok")
    expect(b.take(2, T0)).toBe("burst")
  })

  test("day: spent at dayFrames, and back at 00:00 UTC", () => {
    const a = new St.Allowance(L, T0)
    let t = T0
    let ok = 0
    for (let i = 0; i < 40; i++, t += 2_001) {
      fed(a, t)
      if (a.take(1, t) === "ok") ok++
    }
    expect(ok).toBe(20)
    expect(a.spent(t)).toBe("day")
    expect(a.take(1, t)).toBe("day")
    expect(a.shouldSave(t)).toBe(true)
    const tomorrow = St.nextUtcMidnight(t)
    expect(a.spent(tomorrow)).toBe(null)
    fed(a, tomorrow)
    expect(a.take(1, tomorrow)).toBe("ok")
  })

  test("nothing goes without frames reserved from the pool", () => {
    const a = new St.Allowance(L, T0)
    expect(a.take(1, T0)).toBe("pool")
    expect(a.need(T0)).toBe(20) // the first chunk, at most what is left of the day
    a.granted(3)
    expect([a.take(1, T0), a.take(1, T0), a.take(1, T0), a.take(1, T0)]).toEqual(["ok", "ok", "ok", "pool"])
  })

  test("the pool hands out its day once, across everyone", () => {
    let state: { day: string; used: number } | undefined
    const grants: number[] = []
    for (let i = 0; i < 4; i++) {
      const g = St.grant(state, 12, L, T0)
      state = g.state
      grants.push(g.grant)
    }
    expect(grants).toEqual([12, 12, 6, 0])
    expect(St.grant(state, 12, L, St.nextUtcMidnight(T0)).grant).toBe(12)
    expect(St.grant(undefined, 5000, { ...L, poolFrames: 5000 }, T0).grant).toBe(1000)
  })

  test("a snapshot from the socket or storage carries the day over hibernation", () => {
    const a = new St.Allowance(L, T0)
    for (let i = 0; i < 4; i++) {
      fed(a, T0)
      a.take(5, T0)
    }
    const old = { day: "2026-11-01", frames: 19, bytes: 1, pool: 9 }
    const b = new St.Allowance(L, T0 + 1000, [old, { ...a.s }, { ...a.s, frames: 2 }, undefined])
    expect(b.s.frames).toBe(4)
    expect(b.s.bytes).toBe(20)
    expect(b.s.pool).toBe(a.s.pool)
    // Yesterday's does not count today.
    expect(new St.Allowance(L, T0, [old]).s.frames).toBe(0)
  })

  test("the paused frame says what the client shows, and until when", () => {
    const f = St.pausedFrame("day", L, T0)
    expect(f.code).toBe("stream_paused")
    expect(f.scope).toBe("sender")
    expect(f.until).toBe(Date.UTC(2026, 10, 3))
    expect(f.message).toContain("paused until tomorrow")
    expect(f.message).toContain("--host")
    expect(St.pausedFrame("pool", L, T0).scope).toBe("relay")
  })
})
