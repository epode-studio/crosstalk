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
    expect(O.atStop({ reply: "Done.\n\nOpen\n- CI is still running.\n- Waiting for marie's review.", sessionId: "w1", continuing: false })).toBe(null)
  })
  test("the question shows what is left alone", () => {
    expect(O.context(["ship B"], ["CI is still running"])).toBe("· ship B\nWaiting on (left alone): CI is still running")
  })
})

describe("at the end of a turn", () => {
  test("asked once per item, however reworded; under Always it goes on, and a continued turn never asks", () => {
    const first = O.atStop({ reply: REPLY, sessionId: "s1", continuing: false })!
    expect(first.items).toHaveLength(2)
    expect(first.fresh).toBe(true)
    expect(first.auto).toBe(false) // nobody said Always yet: asked
    const again = O.atStop({ reply: REPLY.replace("**Open**", "**Still open**").replace("whichever chat is selected", "whichever chat is currently selected"), sessionId: "s1", continuing: false })!
    expect(again.items).toEqual([]) // the same items, reworded: nothing new
    expect(again.fresh).toBe(false)
    O.setAlways(true)
    const next = REPLY.trimEnd() + "\n- Write the release notes for B.\n"
    const cont = O.atStop({ reply: next, sessionId: "s1", continuing: true })!
    expect(cont.auto).toBe(false) // already a continued turn: no loop
    expect(cont.fresh).toBe(false) // and no question either
    const third = REPLY.trimEnd() + "\n- Add a rollback for the migration.\n"
    const t = O.atStop({ reply: third, sessionId: "s1", continuing: false })!
    expect(t.auto).toBe(true)
    expect(t.items).toEqual(["Add a rollback for the migration."]) // only what is new
    O.setAlways(false)
  })
  test("what is the person's is never work: their console, their prompts, decisions, questions", () => {
    const reply = `All of this is waiting on you: what your console printed, then the four prompts.

**Open**
- **The console output:** the user id and http number, plus claude mcp add run in Terminal.
- **The four prompts in a new Claude Code session:** list, /mcp count, rename, delete.
- **Then I check:** your user id against the flag.
`
    expect(O.atStop({ reply, sessionId: "s2", continuing: false })).toBe(null)
    for (const p of ["Should I merge PR #12?", "Decide whether to keep the old API (your call)", "Deploy to production", "Marie needs to approve the design", "Run the four prompts in your browser"])
      expect([p, O.isPersons(p)]).toEqual([p, true])
    expect(O.isPersons("Write the migration for device ids.")).toBe(false)
  })
  test("the turn that tackles them lists them and says what to leave to the person", () => {
    const p = O.tacklePrompt(["ship B", "decide the Pi pose"])
    expect(p).toContain("1. ship B\n2. decide the Pi pose")
    expect(p).toContain("ask them (one question for all of those, at the end) instead of guessing")
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
