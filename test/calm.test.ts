// Less to carry: decision windows, focus, away, defaults, break nudges and the summary.
//
//   bun test test/calm.test.ts

import { describe, expect, test } from "bun:test"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"

process.env.CROSSTALK_HOME = fs.mkdtempSync(path.join(os.tmpdir(), "ct-calm-"))
const C = await import("../src/attention/calm.ts")
const S = await import("../src/attention/summary.ts")
const Rl = await import("../src/attention/relay.ts")
const ui = await import("../src/uistate.ts")

const NOW = 1_800_000_000_000
const MIN = 60_000

describe("what may interrupt", () => {
  test("what stops an agent always; the rest in a decision window: every half hour, or once five wait", () => {
    expect(C.urgent({ id: "relay:s:1", kind: "attention" })).toBe(true)
    expect(C.urgent({ id: "attn:perm:x", kind: "attention" })).toBe(true)
    expect(C.urgent({ id: "sess:1", kind: "session" })).toBe(true)
    expect(C.urgent({ id: "steer:abc", kind: "steer" })).toBe(true) // asked for in this session: never held for a decision window
    expect(C.urgent({ id: "m1", kind: "message" })).toBe(false)
    expect(C.windowOpen({}, 1, NOW)).toBe(true) // the first ever
    expect(C.windowOpen({ windowAt: NOW - 60_000 }, 1, NOW)).toBe(true) // a window stays open two minutes
    expect(C.windowOpen({ windowAt: NOW - 10 * MIN }, 1, NOW)).toBe(false) // then waits
    expect(C.windowOpen({ windowAt: NOW - 10 * MIN }, 5, NOW)).toBe(true) // unless five wait
    expect(C.windowOpen({ windowAt: NOW - 31 * MIN }, 1, NOW)).toBe(true) // or half an hour passed
    expect(C.windowOpen({ mode: "focus", until: NOW + MIN }, 9, NOW)).toBe(false)
    expect(C.windowOpen({ mode: "away" }, 9, NOW)).toBe(false)
    expect(C.windowOpen({ holdUntil: NOW + MIN }, 9, NOW)).toBe(false)
  })
  test("twelve decisions in an hour: a nudge, once, and what can wait waits ten minutes", () => {
    const s: import("../src/attention/calm.ts").State = {}
    let nudge: string | null = null
    for (let i = 0; i < 12; i++) nudge = C.answered(s, NOW + i * MIN)
    expect(nudge).toContain("12 decisions in the last hour")
    expect(s.holdUntil).toBe(NOW + 11 * MIN + 10 * MIN)
    expect(C.answered(s, NOW + 12 * MIN)).toBe(null) // not again for a while
  })
  test("focus ends by itself; away lasts until the person is back", () => {
    const s: import("../src/attention/calm.ts").State = {}
    C.startFocus(s, 30, NOW)
    expect(C.mode(s, NOW + 29 * MIN)).toBe("focus")
    expect(C.mode(s, NOW + 31 * MIN)).toBe(undefined)
    C.startAway(s, { now: NOW, workerWasOn: false, usd: 5 })
    expect(C.mode(s, NOW + 20 * 3600_000)).toBe("away")
    expect(C.end(s)).toEqual({ mode: "away", since: NOW, workerWasOn: false, usdAtStart: 5 })
    expect(C.mode(s, NOW)).toBe(undefined)
  })
  test("away carries open lists on a few rounds per session, never for ever", () => {
    const s: import("../src/attention/calm.ts").State = {}
    for (let i = 0; i < C.AWAY_ROUNDS; i++) expect(C.takeRound(s, "x")).toBe(true)
    expect(C.takeRound(s, "x")).toBe(false)
    expect(C.takeRound(s, "y")).toBe(true)
  })
})

describe("an agent's question without the person", () => {
  test("away: its recommendation, else it chooses the safest reversible option itself and writes down why", () => {
    expect(C.awayAnswer([{ label: "Pi flat (Recommended)" }, { label: "Keep any tilt" }]).answer).toBe("Pi flat (Recommended)")
    const own = C.awayAnswer([{ label: "A" }, { label: "B" }])
    expect(own.how).toBe("own")
    expect(own.answer).toContain("safest, most reversible option yourself")
    expect(own.answer).toContain("as a decision in the thread")
  })
  test("asked in main with a recommendation: says what the agent recommends, and waits for the person", () => {
    process.env.CROSSTALK_DEFAULT_AFTER_MS = "0"
    const id = Rl.relay("work-1", { question: "Keep the Pi flat?", options: [{ label: "Pi flat (Recommended)" }, { label: "Keep any tilt" }] }, "main-s")
    const it = ui.snapshot()[id]
    expect(it.defaultAnswer).toBeUndefined()
    expect(it.text).toContain(`The agent recommends "Pi flat (Recommended)"`)
    expect(Rl.poll(id, { mainAlive: () => true })).toEqual({}) // still waiting: never answered for them
    delete process.env.CROSSTALK_DEFAULT_AFTER_MS
  })
})

describe("the summary", () => {
  test("what was decided, what happened, what waits, what it cost: short, and in full", () => {
    C.update((s) => C.decided(s, { at: NOW + MIN, who: "Organic case", question: "Keep the Pi flat?", answer: "Pi flat", how: "away" }))
    const sum = S.gather(NOW, { now: NOW + 3600_000 })
    expect(sum.decided.some((d) => d.includes("Keep the Pi flat? → Pi flat"))).toBe(true)
    const short = S.short(sum, NOW + 3600_000)
    expect(short).toContain("While you were away (1 h)")
    expect(short).toContain("decision")
    expect(short).toContain(`Say "what happened while I was away"`)
    const full = S.full(sum, NOW + 3600_000)
    expect(full).toContain("Decided without you")
    expect(full).toContain("not instructions")
  })
})

describe("finished sessions close themselves", () => {
  test("shipped and idle ten minutes, or idle three hours; never main, the tab in front, busy, waiting, running or dirty", async () => {
    const AC = await import("../src/attention/autoclose.ts")
    const c = (o: Partial<import("../src/attention/autoclose.ts").Candidate>) => ({ sessionId: "s", name: "s", cwd: "/w", seenAt: NOW - 15 * MIN, status: "idle", isMain: false, inFront: false, waiting: 0, running: false, dirty: false, ...o })
    expect(AC.why(c({ shippedAt: NOW - 20 * MIN }), NOW)).toBe("its work shipped")
    expect(AC.why(c({ shippedAt: NOW - 20 * MIN, seenAt: NOW - 2 * MIN }), NOW)).toBe(null) // just finished a turn
    expect(AC.why(c({}), NOW)).toBe(null) // not shipped, not idle long
    expect(AC.why(c({ seenAt: NOW - 4 * 3600_000 }), NOW)).toBe("idle 4 h")
    for (const o of [{ isMain: true }, { inFront: true }, { waiting: 1 }, { running: true }, { dirty: true }, { status: "busy" }])
      expect([o, AC.why(c({ ...o, shippedAt: NOW - 20 * MIN }), NOW)]).toEqual([o, null])
  })
})

describe("the day", () => {
  test("the first session after a quiet stretch says what happened since, once; plan and wrap up read the threads", async () => {
    const D = await import("../src/attention/day.ts")
    D.seen(NOW)
    expect(D.morning(NOW + 3600_000)).toBe(null) // not a quiet stretch
    const m = D.morning(NOW + 9 * 3600_000)!
    expect(m).toContain("Since you were last here")
    expect(m).not.toContain(`"plan my day"`)
    expect(D.morning(NOW + 9 * 3600_000 + 60_000)).toBe(null) // once
    expect(D.plan()).toContain("A clear day") // no threads in this home
    expect(D.wrapUp(NOW + 10 * 3600_000)).toContain("Today")
    expect(D.pickUp(NOW + 11 * 3600_000)).toContain("Since you left off")
  })
})
