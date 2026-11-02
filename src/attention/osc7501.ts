// The Program Status Protocol, OSC 7501, for the few terminals known to read it.
//
// Claude Code emits 7501 itself only after a terminal answers the `OSC 7501;?`
// query, which almost none do, and crosstalk never sends a query (the answer
// would land in someone's prompt). So instead, behind CROSSTALK_OSC7501=1, the
// tab-status adapter (src/terminal/status.ts) also writes crosstalk's own state
// to the session's tty for terminals known to parse it: Ghostty 1.4+ and Rex.
//
//   working  → state=working
//   waiting  → state=blocked:kind=question
//   done     → state=done
//   off      → state=idle

import type { Term } from "../restore.ts"

export type TabState = "working" | "waiting" | "done" | "off"

export const enabled = (env: NodeJS.ProcessEnv = process.env) => env.CROSSTALK_OSC7501 === "1"

/** Terminals known to read 7501. Inside tmux it is dropped, so never there. */
export function reads7501(t: Term): boolean {
  if (t.tmux) return false
  const p = (t.program ?? "").toLowerCase()
  return p === "ghostty" || p.startsWith("rex")
}

export function sequence(state: TabState, id = "crosstalk"): string {
  const s = state === "working" ? "state=working" : state === "waiting" ? "state=blocked:kind=question" : state === "done" ? "state=done" : "state=idle"
  return `\x1b]7501;${s}:app=crosstalk:id=${id.replace(/[^A-Za-z0-9_-]/g, "").slice(0, 32) || "crosstalk"}\x1b\\`
}
