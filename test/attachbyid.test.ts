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
