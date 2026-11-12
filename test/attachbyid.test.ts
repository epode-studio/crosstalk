// A session row pressed in the panel, with no tab to bring forward: attached in a new tab with
// `claude attach`, or, where no tab can be opened from outside, the command to run.
//
//   bun test test/attachbyid.test.ts

import { expect, test } from "bun:test"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"

test("a session with no tab is attached by its id, or the command is given", async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "ct-attach-"))
  process.env.CROSSTALK_HOME = home
  const S = await import("../src/spawn.ts")
  const env = { ...process.env, CROSSTALK_CLAUDE_BG: "1", TERM_PROGRAM: "", TMUX: "", KITTY_WINDOW_ID: "", WEZTERM_PANE: "", ITERM_SESSION_ID: "" }
  const r = S.attachById("062ad8c8-1111-2222-3333-444455556666", { env })!
  expect(r.ok).toBe(true)
  expect(r.text).toContain("attach 062ad8c8")
  expect(S.attachById("062ad8c8-1111", { env: { ...env, CROSSTALK_CLAUDE_BG: "0" } })).toBe(null)
})

test("the tab already attached to a session is found by its claude attach process", async () => {
  const S = await import("../src/spawn.ts")
  const ps = () => ["ttys003  -zsh", "ttys007  /opt/homebrew/bin/claude attach 062ad8c8", "??       claude attach 99999999", "ttys009  claude --resume abc"].join("\n")
  expect(S.attachedTty(["062ad8c8"], ps)).toBe("/dev/ttys007")
  expect(S.attachedTty(["99999999"], ps)).toBe(null) // no terminal: a background process, not a tab
  expect(S.attachedTty(["probe"], ps)).toBe(null)
})

test("Terminal looking through its tabs and finding none is not 'in front'", async () => {
  const F = await import("../src/attention/focus.ts")
  const sys = (out: string) => ({ platform: "darwin" as NodeJS.Platform, run: () => ({ ok: true, out }), has: () => true })
  const t = { program: "Apple_Terminal", tty: "/dev/ttys007" } as any
  expect(F.focusTerm(t, sys("done")).ok).toBe(true)
  expect(F.focusTerm(t, sys(""))).toEqual({ ok: false, kind: "apple", gone: true })
})
