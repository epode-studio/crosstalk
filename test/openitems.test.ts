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

describe("at the end of a turn", () => {
  test("a list is taken in once; under Always the turn goes on, but only once per prompt", () => {
    const first = O.atStop({ reply: REPLY, sessionId: "s1", continuing: false })!
    expect(first.items).toHaveLength(3)
    expect(first.fresh).toBe(true)
    expect(first.auto).toBe(false) // nobody said Always yet: asked
    expect(O.atStop({ reply: REPLY, sessionId: "s1", continuing: false })!.fresh).toBe(false) // the same list again: not again
    O.setAlways(true)
    const next = REPLY.replace("it ships.", "it ships today.")
    expect(O.atStop({ reply: next, sessionId: "s1", continuing: true })!.auto).toBe(false) // already a continued turn: no loop
    const third = REPLY.replace("it ships.", "it ships tomorrow.")
    expect(O.atStop({ reply: third, sessionId: "s1", continuing: false })!.auto).toBe(true)
    O.setAlways(false)
  })
  test("the turn that tackles them lists them and says what to leave to the person", () => {
    const p = O.tacklePrompt(["ship B", "decide the Pi pose"])
    expect(p).toContain("1. ship B\n2. decide the Pi pose")
    expect(p).toContain("ask them (one question for all of those, at the end) instead of guessing")
  })
})
