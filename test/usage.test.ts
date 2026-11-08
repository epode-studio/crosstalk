// Credit usage in the main session's pane: the plan's windows, today's spend,
// each agent's cost, and crossing 80% and 90% said once.
//
//   bun test test/usage.test.ts

import { describe, expect, test } from "bun:test"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"

process.env.CROSSTALK_HOME = fs.mkdtempSync(path.join(os.tmpdir(), "ct-usage-"))
const U = await import("../src/ui-extra/usage.ts")
const CI = await import("../src/urls/ci.ts")
const pure = await import("../src/ui-extra/pure.ts")

const NOW = Date.parse("2026-11-03T13:00:00")
const at = (h: number) => new Date(Date.parse("2026-11-03T00:00:00") + h * 3600_000).toISOString()

describe("usage", () => {
  test("the windows from the newest report, today's spend summed, hot at 80%", () => {
    const reports = new Map([
      ["a", { usd: 1.5, limits: [{ kind: "five_hour", percentUsed: 41.6, resetsAt: at(15.25) }], at: NOW - 60_000 }],
      ["b", { usd: 2.25, limits: [{ kind: "five_hour", percentUsed: 42, resetsAt: at(15.25) }, { kind: "seven_day", percentUsed: 18, resetsAt: "2026-11-07T09:00:00Z" }], at: NOW }],
      ["old", { usd: 9, limits: [], at: NOW - 3 * 86_400_000 }],
    ])
    const l = U.line({ reports, now: NOW })!
    expect(l.text).toBe("5-hour 42% (resets 3:15 PM) · week 18% (resets Sat) · $3.75 across 2 sessions today")
    expect(l.hot).toBe(false)
    reports.set("b", { ...reports.get("b")!, limits: [{ kind: "five_hour", percentUsed: 86, resetsAt: at(15.25) }] })
    expect(U.line({ reports, now: NOW })!.hot).toBe(true)
  })
  test("crossing 80% and 90% goes to Lately once each; a reset starts again", () => {
    const r = (pct: number, resetsAt = at(15)) => ({ limits: [{ kind: "five_hour", percentUsed: pct, resetsAt }], at: NOW })
    U.write("s1", r(70), NOW)
    U.write("s1", r(82), NOW)
    U.write("s1", r(85), NOW)
    U.write("s1", r(91), NOW)
    U.write("s1", r(95), NOW)
    expect(CI.recentEvents(10, NOW).map((e) => e.text)).toEqual(["5-hour limit at 91%, resets 3:00 PM", "5-hour limit at 82%, resets 3:00 PM"])
    U.write("s1", r(83, at(20)), NOW) // a new window
    expect(CI.recentEvents(10, NOW)[0].text).toBe("5-hour limit at 83%, resets 8:00 PM")
  })
  test("an agent's line carries what it has cost", () => {
    expect(U.usdText(1.234)).toBe("$1.23")
    expect(U.usdText(14.6)).toBe("$15")
    expect(U.usdText(0)).toBe("")
    expect(pure.agentLine({ name: "auth", state: "working", cost: "$1.23" })).toBe("⏳ auth · working · $1.23")
  })
})
