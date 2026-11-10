// After an update, main moves onto the new version by itself, at a quiet moment.
//
//   bun test test/handover.test.ts

import { describe, expect, test } from "bun:test"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"

process.env.CROSSTALK_HOME = fs.mkdtempSync(path.join(os.tmpdir(), "ct-handover-"))
const HO = await import("../src/attention/handover.ts")
const AD = await import("../src/attention/daemon.ts")

const NOW = 1_800_000_000_000
const MIN = 60_000
const main = (o: Partial<import("../src/attention/handover.ts").Main> = {}) => ({ sessionId: "m", startedAt: NOW - 60 * MIN, seenAt: NOW - 5 * MIN, status: "idle", inFront: false, ...o })

describe("moving main onto the new version", () => {
  test("a main from before the update, quiet for a few minutes: now; once per version", () => {
    const at = NOW - 30 * MIN
    expect(HO.due({ main: main(), installedAt: at, version: "0.3.0", now: NOW })).toBe(true)
    expect(HO.due({ main: main(), installedAt: at, version: "0.3.0", done: "m@0.3.0", now: NOW })).toBe(false)
    expect(HO.due({ main: main(), installedAt: at, version: "0.3.1", done: "m@0.3.0", now: NOW })).toBe(true)
  })
  test("never one already on it, a busy one, one just used, or the tab in front before ten quiet minutes", () => {
    const at = NOW - 30 * MIN
    expect(HO.due({ main: main({ startedAt: NOW - 10 * MIN }), installedAt: at, version: "0.3.0", now: NOW })).toBe(false)
    expect(HO.due({ main: main({ status: "busy" }), installedAt: at, version: "0.3.0", now: NOW })).toBe(false)
    expect(HO.due({ main: main({ seenAt: NOW - MIN }), installedAt: at, version: "0.3.0", now: NOW })).toBe(false)
    expect(HO.due({ main: main({ inFront: true }), installedAt: at, version: "0.3.0", now: NOW })).toBe(false)
    expect(HO.due({ main: main({ inFront: true, seenAt: NOW - 11 * MIN }), installedAt: at, version: "0.3.0", now: NOW })).toBe(true)
    expect(HO.due({ main: null, installedAt: at, version: "0.3.0", now: NOW })).toBe(false)
    expect(HO.due({ main: main(), installedAt: at, version: "0.3.0", now: NOW, env: { CROSSTALK_NO_HANDOVER: "1" } })).toBe(false)
  })
  test("when a version first ran here is kept, with a minute's grace for the session that started it", () => {
    expect(AD.firstRun("0.3.0", NOW)).toBe(NOW - MIN)
    expect(AD.firstRun("0.3.0", NOW + 60 * MIN)).toBe(NOW - MIN)
    expect(AD.firstRun("", NOW)).toBe(undefined)
  })
})
