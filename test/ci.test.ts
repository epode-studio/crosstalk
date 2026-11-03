// Pull requests' checks: state, ETA, what changed, and who hears about it.
//
//   bun test test/ci.test.ts

import { describe, expect, test } from "bun:test"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"

process.env.CROSSTALK_HOME = fs.mkdtempSync(path.join(os.tmpdir(), "ct-ci-"))
const CI = await import("../src/urls/ci.ts")
const L = await import("../src/urls/liveness.ts")
const { UrlStore } = await import("../src/urls/store.ts")
const pure = await import("../src/ui-extra/pure.ts")

const NOW = 1_800_000_000_000
const MIN = 60_000

describe("checks", () => {
  test("gh's rollup summed up: running, failed with names, passed, none", () => {
    expect(CI.summarize({ state: "OPEN", isDraft: true, statusCheckRollup: [{ name: "lint", status: "COMPLETED", conclusion: "SUCCESS" }, { name: "e2e", status: "IN_PROGRESS", startedAt: new Date(NOW).toISOString() }] })).toEqual({
      state: "OPEN",
      draft: true,
      checks: "running",
      failed: [],
      startedAt: NOW,
    })
    expect(CI.summarize({ state: "OPEN", statusCheckRollup: [{ name: "e2e", status: "COMPLETED", conclusion: "FAILURE" }, { context: "ci/legacy", state: "ERROR" }] }).failed).toEqual(["e2e", "ci/legacy"])
    expect(CI.summarize({ state: "OPEN", statusCheckRollup: [{ name: "lint", status: "COMPLETED", conclusion: "SKIPPED" }] }).checks).toBe("passed")
    expect(CI.summarize({ state: "MERGED", statusCheckRollup: [] }).checks).toBe("none")
  })
  test("what changed between two looks", () => {
    const v = (o: Partial<import("../src/urls/ci.ts").PrView>) => ({ state: "OPEN", draft: false, checks: "running" as const, failed: [], ...o })
    expect(CI.change({ state: "OPEN", checks: "running" }, v({ checks: "passed" }))).toEqual({ kind: "passed" })
    expect(CI.change({ state: "OPEN", checks: "running" }, v({ checks: "failed", failed: ["e2e"] }))).toEqual({ kind: "failed", failed: ["e2e"] })
    expect(CI.change({ state: "OPEN", checks: "passed" }, v({ state: "MERGED", checks: "passed" }))).toEqual({ kind: "merged" })
    expect(CI.change({ state: "OPEN", checks: "running" }, v({}))).toBe(null)
    expect(CI.change(undefined, v({ checks: "failed" }))).toBe(null) // the first look is not news
  })
  test("an ETA from this repository's usual run, so nobody has to ask", () => {
    const history = { "acme/app": [10 * MIN, 12 * MIN, 11 * MIN] }
    expect(CI.etaText(CI.etaMs("acme/app", NOW - 5 * MIN, NOW, history))).toBe("about 6 min left")
    expect(CI.etaText(CI.etaMs("acme/app", NOW - 30 * MIN, NOW, history))).toBe("about 1 min left") // overdue: never "0"
    expect(CI.etaMs("acme/other", NOW - 5 * MIN, NOW, history)).toBe(undefined) // no history yet: no guess
    expect(CI.repoOf("https://github.com/Acme/App/pull/12")).toBe("acme/app")
  })
  test("a failure becomes an investigation", () => {
    expect(CI.investigation("auth · PR #12", "https://github.com/a/b/pull/12", ["e2e"])).toBe(
      "Investigate why e2e failed on auth · PR #12 (https://github.com/a/b/pull/12): read the logs, find the cause, fix it or say what blocks it",
    )
  })
})

describe("watching a PR", () => {
  test("checks running are looked at every minute; a change is handed on; a finished run teaches the ETA", async () => {
    const store = new UrlStore({ file: path.join(process.env.CROSSTALK_HOME!, "ci-urls.json") })
    const url = "https://github.com/acme/app/pull/7"
    store.add({ id: `pr:${url}`, url, kind: "pr", source: "pr", label: "auth · PR #7", thread: "auth" })
    let view: import("../src/urls/ci.ts").PrView = { state: "OPEN", draft: false, checks: "running", failed: [], startedAt: NOW - 8 * MIN }
    const changes: string[] = []
    const opts = (now: number) => ({ liveRoots: new Set<string>(), now, prView: () => view, onPr: (_u: any, c: any) => changes.push(c.kind) })
    await L.tick(store, opts(NOW))
    const u = store.read()[0]
    expect(u.checks).toBe("running")
    expect(u.checksSince).toBe(NOW - 8 * MIN)
    expect(L.nextDue(u, false) - u.lastCheck).toBe(L.PR_RUNNING_MS())
    expect(changes).toEqual([])
    view = { ...view, checks: "failed", failed: ["e2e"] }
    await L.tick(store, opts(NOW + 2 * MIN))
    expect(changes).toEqual(["failed"])
    expect(JSON.parse(fs.readFileSync(path.join(process.env.CROSSTALK_HOME!, "ci-durations.json"), "utf8"))["acme/app"]).toEqual([10 * MIN])
    expect(pure.prState({ alive: true, state: "OPEN", checks: "failed", failed: ["e2e"] })).toBe(" · checks failed: e2e")
    expect(pure.prState({ alive: true, state: "OPEN", checks: "running", eta: "about 6 min left", draft: true })).toBe(" · draft · checks running · about 6 min left")
    expect(pure.prState({ alive: false, state: "MERGED" })).toBe(" · merged")
  })
})
