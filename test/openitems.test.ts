// "Tackle all open": a reply's Open list kept as tasks, asked once, or gone on with.
//
//   bun test test/openitems.test.ts

import { describe, expect, test } from "bun:test"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"

process.env.CROSSTALK_HOME = fs.mkdtempSync(path.join(os.tmpdir(), "ct-open-"))
const O = await import("../src/attention/openitems.ts")

const REPLY = `Two of the three reviews are live.

**Proved by**
- **A:** 85 tests pass.

**Open**
- B is not live until its local checks pass and it ships.
- C's before and after screenshots were never handed over, so nobody has
  looked at the rendered card yet.
- In B, a turn still records billing under whichever chat is selected (\`controller.ts:1892\`).
`

describe("the Open list", () => {
  test("found under its heading at the end, wrapped lines joined, markdown dropped", () => {
    expect(O.parseOpen(REPLY)).toEqual([
      "B is not live until its local checks pass and it ships.",
      "C's before and after screenshots were never handed over, so nobody has looked at the rendered card yet.",
      "In B, a turn still records billing under whichever chat is selected (controller.ts:1892).",
    ])
  })
  test("other headings count too; a reply without one has nothing", () => {
    expect(O.parseOpen("Done.\n\n## Next steps\n1. ship it\n2. tell marie")).toEqual(["ship it", "tell marie"])
    expect(O.parseOpen("All done, nothing left.")).toEqual([])
    expect(O.parseOpen("Open\n\nnot a list")).toEqual([])
  })
})

describe("waiting is not work", () => {
  test("items that only wait on something are told apart from things to do", () => {
    for (const w of [
      "B is not live until its local checks pass and it ships.",
      "When B is live: Marie plugs the buzzer back into Suede and says \"make a melody game\".",
      "Waiting for the merge train to land.",
      "CI is still running on #2841.",
      "Once #2840 merges, rebase B.",
      "Blocked on Apple's review.",
      "PR #2841 is in the merge queue.",
    ])
      expect([w, O.isWaiting(w)]).toEqual([w, true])
    for (const t of [
      "C's before and after screenshots were never handed over, so nobody has looked at the rendered card yet.",
      "In B, a turn still records billing under whichever chat is selected (controller.ts:1892).",
      "Write the migration for device ids.",
      "Fix the flaky reconnect test.",
    ])
      expect([t, O.isWaiting(t)]).toEqual([t, false])
  })
  test("a list that only waits asks nothing", () => {
    const r = O.atStop({ reply: "Done.\n\nOpen\n- CI is still running.\n- Waiting for marie's review.", sessionId: "w1", continuing: false })!
    expect([r.items, r.persons, r.auto, r.fresh]).toEqual([[], [], false, false]) // nothing to do, nothing to ask: only remembered, to chase
  })
  test("the question shows what is left alone", () => {
    expect(O.context(["ship B"], ["CI is still running"])).toBe("· ship B\nWaiting on (left alone): CI is still running")
  })
})

describe("at the end of a turn", () => {
  test("crosstalk carries on by itself once, then waits for the person: never a spiral", () => {
    const first = O.atStop({ reply: REPLY, sessionId: "s1", continuing: false })!
    expect(first.items).toHaveLength(2)
    expect(first.auto).toBe(true) // nobody has to say Always
    const again = O.atStop({ reply: REPLY.replace("**Open**", "**Still open**").replace("whichever chat is selected", "whichever chat is currently selected"), sessionId: "s1", continuing: false })!
    expect(again.items).toEqual([]) // the same items, reworded: nothing new
    expect(again.auto).toBe(false)
    const cont = O.atStop({ reply: REPLY.trimEnd() + "\n- Write the release notes for B.\n", sessionId: "s1", continuing: true })!
    expect(cont.auto).toBe(false) // a Stop-hook continuation never chains
    const next = O.atStop({ reply: REPLY.trimEnd() + "\n- Add a rollback for the migration.\n", sessionId: "s1", continuing: false })!
    expect(next.auto).toBe(false) // one round already: it waits for the person
    O.resetChain("s1") // the person typed
    expect(O.atStop({ reply: REPLY.trimEnd() + "\n- Delete stale fixtures from tests.\n", sessionId: "s1", continuing: false })!.auto).toBe(true)
    O.resetChain("s1")
    // Reworded beyond recognition is still the same work: half its words seen before, no round.
    expect(O.atStop({ reply: REPLY.trimEnd() + "\n- Delete the stale test fixtures now.\n", sessionId: "s1", continuing: false })!.auto).toBe(false)
    O.setAlways(false) // "stop tackling open items by itself"
    O.resetChain("s1")
    expect(O.atStop({ reply: REPLY.trimEnd() + "\n- Rename the feature flag in config.\n", sessionId: "s1", continuing: false })!.auto).toBe(false)
    O.setAlways(true)
  })
  test("what was left for the person never starts a round by itself: it waits for them to say tackle them", () => {
    const reply = `All of this is waiting on you: what your console printed, then the four prompts.

**Open**
- **The console output:** the user id and http number, plus claude mcp add run in Terminal.
- **The four prompts in a new Claude Code session:** list, /mcp count, rename, delete.
- **Then I check:** your user id against the flag.
`
    const r = O.atStop({ reply, sessionId: "s2", continuing: false })!
    expect(r.items).toEqual([])
    expect(r.auto).toBe(false) // the agent once tried a delete that could not be undone
    expect(r.persons).toHaveLength(3)
    const p = O.tacklePrompt(r.items, [], r.persons)
    expect(p).toContain("They want you to do these, not to be handed them")
    expect(p).toContain("AskUserQuestion")
    expect(p).toContain("none marked recommended")
    expect(O.atStop({ reply, sessionId: "s2", continuing: false })!.persons).toEqual([]) // once
    for (const p of ["Should I merge PR #12?", "Decide whether to keep the old API (your call)", "Deploy to production", "Marie needs to approve the design", "Run the four prompts in your browser"])
      expect([p, O.isPersons(p)]).toEqual([p, true])
    expect(O.isPersons("Write the migration for device ids.")).toBe(false)
  })
  test("the turn that tackles them lists them and says what to leave to the person", () => {
    const p = O.tacklePrompt(["ship B", "decide the Pi pose"])
    expect(p).toContain("1. ship B\n2. decide the Pi pose")
    expect(p).toContain("Do nothing that cannot be undone")
  })
})

describe("working the board", () => {
  test("picks investigations first, then the oldest; never a claimed, waiting, tried or running one", async () => {
    const W = await import("../src/attention/worker.ts")
    const t = (id: string, text: string, at: number, o: Record<string, unknown> = {}) => ({ id, text, thread: "auth", threadId: "t1", at, state: "open", ...o }) as any
    const tasks = [
      t("a", "write the expiry migration", 1),
      t("b", "Investigate why e2e failed on auth · PR #12 (https://x)", 5),
      t("c", "wait for the merge train to land", 0),
      t("d", "fix the flaky test", 2, { claimedBy: "marie" }),
      t("e", "rename the helper", 3),
    ]
    expect(W.pick(tasks, { tried: [], running: [] })!.id).toBe("b")
    expect(W.pick(tasks, { tried: ["b"], running: [] })!.id).toBe("a")
    expect(W.pick(tasks, { tried: ["b"], running: [{ taskId: "a", thread: "auth", agent: "auth-1", startedAt: 0 }] })!.id).toBe("e")
    expect(W.pick(tasks, { threads: ["billing"], tried: [], running: [] })).toBe(null)
  })
  test("the agent is told what to do, to mark it done, and to ask rather than guess", async () => {
    const W = await import("../src/attention/worker.ts")
    const p = W.prompt({ id: "k1", text: "fix the flaky test", thread: "auth", threadId: "t", at: 0, state: "open" })
    expect(p).toContain("fix the flaky test")
    expect(p).toContain(`op "done" and id "k1"`)
    expect(p).toContain("never deploying to production yourself")
  })
  test("off until turned on; says what it is doing", async () => {
    const W = await import("../src/attention/worker.ts")
    expect(W.read().on).toBe(false)
    W.write({ on: true, max: 2, running: [{ taskId: "a", thread: "auth", agent: "auth-1", startedAt: 0 }], tried: [] })
    expect(W.describe(W.read())).toBe(`◢ crosstalk: working through the open tasks, at most 2 agents at once, in the background. Working on: auth (auth-1). Say "stop working the board" to stop.`)
  })
})

describe("chasing what waits", () => {
  test("a list that only waits is remembered; when it moves, the session carries on with it, once", () => {
    const r = O.atStop({ reply: "Done.\n\nOpen\n- CI is still running on #12.\n- Waiting for #12 to merge.", sessionId: "c1", continuing: false })!
    expect(r.items).toEqual([])
    expect(r.waiting).toHaveLength(2)
    O.noteWaiting("c1", r.waiting)
    const p = O.chase("c1", "auth · PR #12: checks passed (https://x).")!
    expect(p).toContain("What you were waiting on has moved: auth · PR #12: checks passed")
    expect(p).toContain("1. CI is still running on #12.")
    expect(O.chase("c1", "again")).toBe(null) // once
    expect(O.chase("nobody", "x")).toBe(null)
  })
})

describe("saying items were kept", () => {
  test("at most once an hour per session", () => {
    expect(O.mayRemind("r1", 1_800_000_000_000)).toBe(true)
    expect(O.mayRemind("r1", 1_800_000_000_000 + 60_000)).toBe(false)
    expect(O.mayRemind("r2", 1_800_000_000_000 + 60_000)).toBe(true)
    expect(O.mayRemind("r1", 1_800_000_000_000 + 3_600_001)).toBe(true)
  })
})

describe("kept tasks close by themselves", () => {
  test("gone from the next Open list (however reworded), or all when the reply says nothing is left", () => {
    O.rememberTask("k1", "t1", "Write the migration for device ids.")
    O.rememberTask("k1", "t2", "Fix the flaky reconnect test.")
    expect(O.finishedTasks("k1", "Done with that.")).toEqual([]) // no list, no words: says nothing about them
    expect(O.finishedTasks("k1", "Progress.\n\nOpen\n- Fix the reconnect test that is flaky.")).toEqual(["t1"])
    expect(O.finishedTasks("k1", "Progress.\n\nOpen\n- Fix the reconnect test that is flaky.")).toEqual([]) // once
    expect(O.finishedTasks("k1", "All done, nothing is left.")).toEqual(["t2"])
    expect(O.finishedTasks("nobody", "All done.")).toEqual([])
  })
})
