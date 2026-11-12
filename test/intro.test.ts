// The welcome and "what can crosstalk do?": plain words, once, and reachable.
//
//   bun test test/intro.test.ts

import { describe, expect, test } from "bun:test"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"

process.env.CROSSTALK_HOME = fs.mkdtempSync(path.join(os.tmpdir(), "ct-intro-"))
const I = await import("../src/intro.ts")
const T = await import("../src/tools/index.ts")

describe("intro", () => {
  test("the welcome comes once per machine, short", () => {
    const w = I.welcomeOnce()
    expect(w).toContain("Nothing to learn")
    expect(w!.split("\n").length).toBeLessThanOrEqual(5)
    expect(I.welcomeOnce()).toBe(null)
  })
  test("everything to say is a quoted phrase, never a slash command or a flag", () => {
    for (const g of I.THINGS) for (const l of g.lines) {
      expect(l.startsWith(`"`) || l.startsWith("a reply")).toBe(true)
      expect(l).not.toMatch(/\/crosstalk|(^|\s)--[a-z]/)
    }
  })
  test(`"what can crosstalk do?" reaches the list through crosstalk_inbox`, () => {
    expect(T.resolve("crosstalk_inbox", { action: "intro" })).toEqual({ name: "crosstalk_intro", args: {} })
    expect(I.introText()).toContain(`"tidy up my sessions"`)
  })
})
