// How a shared server's frames go over the relay, and when the hosted relay
// pauses them (src/streamgate.ts, worker/README.md "Stream frames").

import { describe, expect, test } from "bun:test"
import { createStreamGate, PAUSED_TEXT, NO_STREAMS_TEXT } from "../src/streamgate.ts"

function gate() {
  let t = Date.UTC(2026, 10, 2, 12)
  const notes: string[] = []
  const told: [string, string][] = []
  const logs: string[] = []
  const g = createStreamGate({ note: (_id, text) => notes.push(text), tell: (l, text) => told.push([l, text]), log: (s) => logs.push(s), now: () => t })
  return { g, notes, told, logs, at: (ms: number) => (t += ms), now: () => t }
}

describe("stream gate", () => {
  test("self-hosted: stream frames when advertised, ordinary sends from a relay that predates them", () => {
    const { g } = gate()
    g.connected({ hosted: false })
    g.ready({})
    expect(g.route("ben")).toBe("send")
    expect(g.mode()).toBe("send")
    g.connected({ hosted: false })
    g.ready({ streams: 1 })
    expect(g.route("ben")).toBe("stream")
    expect(g.mode()).toBe("stream")
  })

  test("hosted: stream frames only, never stored sends", () => {
    const { g, notes, at } = gate()
    g.connected({ hosted: true })
    // Before its ready: nothing, and no complaint yet.
    expect(g.route("ben")).toBe(null)
    expect(notes).toEqual([])
    g.ready({ streams: 1, streamAllowance: { day: { frames: 4000 } } })
    expect(g.route("ben")).toBe("stream")
    expect(g.mode()).toBe("worker")
    // A hosted relay that never says streams: nothing goes, said once.
    g.connected({ hosted: true })
    at(6000)
    expect(g.route("ben")).toBe(null)
    expect(g.route("ben")).toBe(null)
    expect(notes).toEqual([`◢ crosstalk: ${NO_STREAMS_TEXT}`])
  })

  test("paused: both people told once in plain words, streaming stops, back after the time given", () => {
    const { g, notes, told, now, at } = gate()
    g.connected({ hosted: true })
    g.ready({ streams: 1 })
    expect(g.route("ben")).toBe("stream")
    expect(g.route("cat")).toBe("stream")
    const until = Date.UTC(2026, 10, 3)
    const f = { t: "error", code: "stream_paused", scope: "sender", until, message: "relay text" }
    expect(g.onError(f, "ana")).toBe(true)
    expect(g.onError(f, "ana")).toBe(true) // once
    expect(notes.length).toBe(1)
    expect(notes[0]).toContain(PAUSED_TEXT)
    expect(notes[0]).toContain("paused until tomorrow")
    expect(notes[0]).toContain("`--host` or `worker/`")
    expect(told.map(([l]) => l).sort()).toEqual(["ben", "cat"])
    expect(told[0][1]).toBe(`◢ crosstalk: ana's ${PAUSED_TEXT}`)
    expect(g.paused()).toBe(true)
    expect(g.route("ben")).toBe(null)
    // A reconnect does not lift it: the relay would only refuse again.
    g.connected({ hosted: true })
    g.ready({ streams: 1 })
    expect(g.route("ben")).toBe(null)
    at(until - now())
    expect(g.route("ben")).toBe("stream")
  })

  test("a pause never lasts past a day, whatever the relay says", () => {
    const { g, now } = gate()
    g.connected({ hosted: true })
    g.ready({ streams: 1 })
    g.onError({ code: "stream_paused", until: now() + 365 * 86_400_000 })
    expect(g.paused()).toBe(true)
    const { g: g2 } = gate()
    g2.onError({ code: "stream_paused", until: "soon" })
    expect(g2.paused()).toBe(true)
  })

  test("offline and burst are logged, other errors are not its business", () => {
    const { g, logs, notes } = gate()
    expect(g.onError({ code: "stream_offline", message: "not connected now" })).toBe(true)
    expect(g.onError({ code: "stream_burst", message: "too fast" })).toBe(true)
    expect(g.onError({ message: "rate limited" })).toBe(false)
    expect(logs.length).toBe(2)
    expect(notes).toEqual([])
  })
})
