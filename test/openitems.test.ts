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
  test("a list is taken in once; under Always the turn goes on, but only once per prompt", () => {
    const first = O.atStop({ reply: REPLY, sessionId: "s1", continuing: false })!
    expect(first.items).toHaveLength(2)
    expect(first.waiting).toEqual(["B is not live until its local checks pass and it ships."])
    expect(first.fresh).toBe(true)
    expect(first.auto).toBe(false) // nobody said Always yet: asked
    expect(O.atStop({ reply: REPLY, sessionId: "s1", continuing: false })!.fresh).toBe(false) // the same list again: not again
    O.setAlways(true)
    const next = REPLY.replace("is selected", "is picked")
    expect(O.atStop({ reply: next, sessionId: "s1", continuing: true })!.auto).toBe(false) // already a continued turn: no loop
    const third = REPLY.replace("is selected", "is chosen")
    expect(O.atStop({ reply: third, sessionId: "s1", continuing: false })!.auto).toBe(true)
    O.setAlways(false)
  })
  test("the turn that tackles them lists them and says what to leave to the person", () => {
    const p = O.tacklePrompt(["ship B", "decide the Pi pose"])
    expect(p).toContain("1. ship B\n2. decide the Pi pose")
    expect(p).toContain("ask them (one question for all of those, at the end) instead of guessing")
  })
})
