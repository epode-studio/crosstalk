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
const Mg = await import("../src/urls/merge.ts")

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
  test("a run well past its usual length says so, instead of an ETA that has passed", () => {
    const history = { "acme/app": [10 * MIN, 12 * MIN, 11 * MIN] }
    expect(CI.etaLine("acme/app", NOW - 5 * MIN, NOW, history)).toBe("about 6 min left")
    expect(CI.etaLine("acme/app", NOW - 15 * MIN, NOW, history)).toBe("about 1 min left") // late, but not clearly
    expect(CI.etaLine("acme/app", NOW - 17 * MIN, NOW, history)).toBe("taking longer than usual") // > 1.5 × 11 min
    expect(CI.etaLine("acme/other", NOW - 50 * MIN, NOW, history)).toBe("") // no history: no guess
    expect(CI.etaLine("acme/app", undefined, NOW, history)).toBe("")
  })
  test("review and mergeability from gh, when it says", () => {
    const v = CI.summarize({ state: "OPEN", statusCheckRollup: [{ name: "ci", status: "COMPLETED", conclusion: "SUCCESS" }], reviewDecision: "APPROVED", mergeable: "MERGEABLE", mergeStateStatus: "CLEAN" })
    expect([v.review, v.mergeable, v.mergeState]).toEqual(["APPROVED", "MERGEABLE", "CLEAN"])
    expect(CI.summarize({ state: "OPEN", reviewDecision: "" }).review).toBe("") // no review required
    expect("review" in CI.summarize({ state: "OPEN" })).toBe(false)
    expect(L.PR_FIELDS.split(",")).toEqual(expect.arrayContaining(["reviewDecision", "mergeable", "mergeStateStatus"]))
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

  test("gh answers later, never holding the daemon up: hooks may return a promise, and the view is handed on", async () => {
    const store = new UrlStore({ file: path.join(process.env.CROSSTALK_HOME!, "ci-async.json") })
    const url = "https://github.com/acme/app/pull/8"
    store.add({ id: `pr:${url}`, url, kind: "pr", source: "manual", label: "auth · PR #8", thread: "auth" })
    let view: import("../src/urls/ci.ts").PrView = { state: "OPEN", draft: false, checks: "running", failed: [], author: "Ana" }
    const seen: [string, string | undefined][] = []
    const slow = <T>(x: T) => new Promise<T>((r) => setTimeout(() => r(x), 5))
    const opts = (now: number, me: string) => ({ liveRoots: new Set<string>(), now, prView: () => slow(view), me: () => slow(me), onPr: (_u: any, c: any, v: any) => seen.push([c.kind, v?.review]) })
    await L.tick(store, opts(NOW, "ana"))
    view = { ...view, checks: "passed", review: "APPROVED" }
    await L.tick(store, opts(NOW + 2 * MIN, "ana"))
    expect(seen).toEqual([["passed", "APPROVED"]])
    // Someone else's PR: never handed on.
    view = { ...view, checks: "running" }
    await L.tick(store, opts(NOW + 4 * MIN, "ben"))
    view = { ...view, checks: "failed", failed: ["e2e"] }
    await L.tick(store, opts(NOW + 6 * MIN, "ben"))
    expect(seen.length).toBe(1)
    // A state alone, answered later, and a hook that throws: the record is just looked at again later.
    const s2 = new UrlStore({ file: path.join(process.env.CROSSTALK_HOME!, "ci-async2.json") })
    s2.add({ id: "pr:x", url: "https://github.com/a/b/pull/1", kind: "pr", source: "pr", label: "x" })
    await L.tick(s2, { liveRoots: new Set(), now: NOW, prState: () => slow("MERGED") })
    expect(s2.get("pr:x")!.state).toBe("MERGED")
    const s3 = new UrlStore({ file: path.join(process.env.CROSSTALK_HOME!, "ci-async3.json") })
    s3.add({ id: "pr:y", url: "https://github.com/a/b/pull/2", kind: "pr", source: "pr", label: "y" })
    await L.tick(s3, { liveRoots: new Set(), now: NOW, prView: async () => Promise.reject(new Error("gh died")) })
    expect(s3.get("pr:y")!.lastCheck).toBe(NOW)
  })
})

describe("telling teammates", () => {
  test("a merge or a failure, once per PR and kind, only to a thread's other people", () => {
    const u = { id: "pr:https://github.com/acme/app/pull/12", label: "auth · PR #12" }
    const sent: [string, string][] = []
    const send = (l: string, t: string) => void sent.push([l, t])
    const team = (ids: string[]) => (ids[0] === "t-auth" ? ["ben", "marie"] : [])
    const tell = (c: import("../src/urls/ci.ts").Change, threadId?: string) => CI.tellTeam({ u, c, threadId, me: "paul", teammates: team, send })
    // A pass is not news to them; a thread only here, or none, tells nobody.
    expect(tell({ kind: "passed" }, "t-auth")).toEqual([])
    expect(tell({ kind: "merged" }, "t-solo")).toEqual([])
    expect(tell({ kind: "merged" })).toEqual([])
    expect(sent).toEqual([])
    expect(tell({ kind: "failed", failed: ["e2e"] }, "t-auth")).toEqual(["ben", "marie"])
    expect(tell({ kind: "failed", failed: ["e2e"] }, "t-auth")).toEqual([]) // once
    expect(tell({ kind: "merged" }, "t-auth")).toEqual(["ben", "marie"])
    expect(tell({ kind: "merged" }, "t-auth")).toEqual([])
    expect(sent).toEqual([
      ["ben", "auth · PR #12: checks failed (paul)"],
      ["marie", "auth · PR #12: checks failed (paul)"],
      ["ben", "auth · PR #12 merged (paul)"],
      ["marie", "auth · PR #12 merged (paul)"],
    ])
    // Kept across restarts.
    expect(CI.firstTime(`${u.id}:merged`)).toBe(false)
    expect(CI.firstTime("pr:other:merged")).toBe(true)
  })
})

describe("merging green PRs", () => {
  const green = (o: Partial<import("../src/urls/ci.ts").PrView> = {}): import("../src/urls/ci.ts").PrView => ({ state: "OPEN", draft: false, checks: "passed", failed: [], review: "APPROVED", mergeable: "MERGEABLE", mergeState: "CLEAN", ...o })
  test("asked only when it just turned green and nothing is in the way", () => {
    const passed = { kind: "passed" as const }
    expect(Mg.decide({ change: passed, view: green(), env: {} })).toBe("ask")
    expect(Mg.decide({ change: passed, view: green({ review: "" }), env: {} })).toBe("ask") // no review required
    expect(Mg.decide({ change: passed, view: green({ mergeable: "UNKNOWN", mergeState: "UNKNOWN" }), env: {} })).toBe("ask") // --auto waits for GitHub
    expect(Mg.decide({ change: passed, view: green(), always: true, env: {} })).toBe("merge")
    expect(Mg.decide({ change: { kind: "failed" }, view: green(), env: {} })).toBe("none")
    expect(Mg.decide({ change: { kind: "merged" }, view: green(), always: true, env: {} })).toBe("none")
    expect(Mg.decide({ change: passed, view: green({ draft: true }), env: {} })).toBe("none")
    expect(Mg.decide({ change: passed, view: green({ review: "REVIEW_REQUIRED" }), env: {} })).toBe("none")
    expect(Mg.decide({ change: passed, view: green({ review: "CHANGES_REQUESTED" }), env: {} })).toBe("none")
    expect(Mg.decide({ change: passed, view: green({ mergeable: "CONFLICTING" }), env: {} })).toBe("none")
    expect(Mg.decide({ change: passed, view: green({ mergeState: "DIRTY" }), env: {} })).toBe("none")
    expect(Mg.decide({ change: passed, view: green(), mine: false, env: {} })).toBe("none")
    expect(Mg.decide({ change: passed, view: green(), always: true, env: { CROSSTALK_NO_MERGE: "1" } })).toBe("none")
  })
  test("the question, and the method the repository allows, squash first", () => {
    expect(Mg.question("auth · PR #12", { review: "APPROVED" })).toBe("auth · PR #12 is green and approved. Merge it?")
    expect(Mg.question("auth · PR #12", { review: "" })).toBe("auth · PR #12 is green. Merge it?")
    expect(Mg.methodFlag({ squashMergeAllowed: true, mergeCommitAllowed: true })).toBe("--squash")
    expect(Mg.methodFlag({ squashMergeAllowed: false, mergeCommitAllowed: true, rebaseMergeAllowed: true })).toBe("--merge")
    expect(Mg.methodFlag({ rebaseMergeAllowed: true })).toBe("--rebase")
    expect(Mg.methodFlag(undefined)).toBe(undefined)
  })
})

const Q = await import("../src/urls/queue.ts")
describe("the merge queue", () => {
  test("GitHub's answer is read: in line, where, about when, and why it last left", () => {
    const j = { data: { repository: { pullRequest: { isInMergeQueue: true, mergeQueueEntry: { position: 2, estimatedTimeToMerge: 600, enqueuedAt: "2027-01-15T08:00:00Z" }, timelineItems: { nodes: [{ createdAt: "2027-01-15T07:00:00Z", reason: "FAILED_CHECKS" }] } } } } }
    expect(Q.parse(j)).toEqual({ queued: true, position: 2, eta: 600, enqueuedAt: Date.parse("2027-01-15T08:00:00Z"), removed: { at: Date.parse("2027-01-15T07:00:00Z"), reason: "FAILED_CHECKS" } })
    expect(Q.parse({})).toBe(undefined)
  })
  test("why it left, in GitHub's words", () => {
    expect(Q.why("MERGE_CONFLICT")).toBe("conflict")
    expect(Q.why("Failed checks")).toBe("failed")
    expect(Q.why("MANUAL")).toBe("manual")
    expect(Q.why("QUEUE_CLEARED")).toBe("other")
  })
  test("in line; out on a flaky check: back once; out again: fixed; a conflict: fixed; by hand: left alone; each removal once", () => {
    let k: import("../src/urls/queue.ts").Kept = {}
    let r = Q.step(k, { queued: true, position: 3, eta: 900 }, NOW)
    expect(r.step).toEqual({ kind: "queued", position: 3, eta: 900 })
    expect(Q.text("auth · PR #7", r.step!)).toBe("auth · PR #7 is in the merge queue, 3rd in line, merging in about 15 min.")
    k = r.keep
    expect(Q.step(k, { queued: true, position: 2 }, NOW + MIN).step).toBe(null)
    r = Q.step(k, { queued: false, removed: { at: NOW + 2 * MIN, reason: "FAILED_CHECKS" } }, NOW + 2 * MIN)
    expect(r.step).toMatchObject({ kind: "dequeued", why: "failed", action: "requeue" })
    k = r.keep
    expect(Q.step(k, { queued: false, removed: { at: NOW + 2 * MIN, reason: "FAILED_CHECKS" } }, NOW + 3 * MIN).step).toBe(null) // the same removal, once
    k = Q.step(k, { queued: true }, NOW + 4 * MIN).keep
    r = Q.step(k, { queued: false, removed: { at: NOW + 5 * MIN, reason: "FAILED_CHECKS" } }, NOW + 5 * MIN)
    expect(r.step).toMatchObject({ kind: "dequeued", action: "fix" }) // twice: not a flake
    k = Q.step(r.keep, { queued: true }, NOW + 6 * MIN).keep
    r = Q.step(k, { queued: false, removed: { at: NOW + 7 * MIN, reason: "MERGE_CONFLICT" } }, NOW + 7 * MIN)
    expect(r.step).toMatchObject({ kind: "dequeued", why: "conflict", action: "leave", again: true }) // fixed once today already
    k = Q.step(r.keep, { queued: true }, NOW + 8 * MIN).keep
    r = Q.step(k, { queued: false, removed: { at: NOW + 9 * MIN, reason: "MANUAL" } }, NOW + 9 * MIN)
    expect(r.step).toMatchObject({ action: "leave" })
    expect(Q.text("auth · PR #7", r.step!)).toContain("taken out of the merge queue by hand")
  })
  test("first in line far longer than usual is said once", () => {
    const k = Q.step({}, { queued: true, position: 1, enqueuedAt: NOW }, NOW).keep
    expect(Q.step(k, { queued: true, position: 1 }, NOW + 30 * MIN).step).toBe(null)
    const r = Q.step(k, { queued: true, position: 1 }, NOW + 61 * MIN)
    expect(r.step).toEqual({ kind: "stuck", minutes: 61 })
    expect(Q.step(r.keep, { queued: true, position: 1 }, NOW + 90 * MIN).step).toBe(null)
  })
  test("the agent that unblocks it fixes the cause, never skips a test, and puts it back", () => {
    const p = Q.fixPrompt("auth · PR #7", "https://github.com/acme/app/pull/7", { kind: "dequeued", why: "failed", reason: "FAILED_CHECKS", action: "fix" })
    expect(p).toContain("rather than skipping or disabling a test")
    expect(p).toContain("gh pr merge https://github.com/acme/app/pull/7 --auto")
  })
  test("watched while set to merge by itself; looked at every minute while in line; shown in the pane", async () => {
    const store = new UrlStore({ file: path.join(process.env.CROSSTALK_HOME!, "ci-queue.json") })
    const url = "https://github.com/acme/app/pull/9"
    store.add({ id: `pr:${url}`, url, kind: "pr", source: "pr", label: "auth · PR #9", thread: "auth" })
    const view = { state: "OPEN", draft: false, checks: "passed" as const, failed: [], autoMerge: true }
    let q: import("../src/urls/queue.ts").QueueView = { queued: true, position: 1 }
    const steps: string[] = []
    const opts = (now: number) => ({ liveRoots: new Set<string>(), now, prView: () => view, queueOf: () => q, onQueue: (_u: any, s: any) => steps.push(s.kind + (s.action ? `:${s.action}` : "")) })
    await L.tick(store, opts(NOW))
    expect(steps).toEqual(["queued"])
    const u = store.read()[0]
    expect(u.queued).toBe(true)
    expect(L.nextDue(u, false) - u.lastCheck).toBe(L.PR_RUNNING_MS())
    expect(pure.prState({ alive: true, state: "OPEN", checks: "passed", queued: true })).toBe(" · checks passed · in the merge queue")
    q = { queued: false, removed: { at: NOW + MIN, reason: "MERGE_CONFLICT" } }
    await L.tick(store, opts(NOW + 2 * MIN))
    expect(steps).toEqual(["queued", "dequeued:fix"])
  })
})

describe("the merge queue, kept in bounds", () => {
  test("out again after a fix the same day: left to the person, not fixed again", () => {
    let k = Q.step({}, { queued: true }, NOW).keep
    let r = Q.step(k, { queued: false, removed: { at: NOW + MIN, reason: "MERGE_CONFLICT" } }, NOW + MIN)
    expect(r.step).toMatchObject({ action: "fix" })
    k = Q.step(r.keep, { queued: true }, NOW + 30 * MIN).keep
    r = Q.step(k, { queued: false, removed: { at: NOW + 60 * MIN, reason: "MERGE_CONFLICT" } }, NOW + 60 * MIN)
    expect(r.step).toMatchObject({ action: "leave", again: true })
    expect(Q.text("auth · PR #7", r.step!)).toContain("needs your look")
  })
  test("watching can be turned off in words", () => {
    Q.setQueueOff(true)
    expect(Q.disabled({})).toBe(true)
    Q.setQueueOff(false)
    expect(Q.disabled({})).toBe(false)
  })
})
