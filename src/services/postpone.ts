// Waiting, silently, for what a session started (docs/services.md).
//
// Before crosstalk ends a Claude session (gather's restart in place, a fresh
// session instead of a compaction), it looks below the Claude process for
// anything still running that the session started outside crosstalk: a dev
// server from a backgrounded Bash call, a watcher, a test run. Ending the
// session would end those with it, so the end is postponed, with no question,
// and tried again when they have stopped. crosstalk's own services are left
// out: they outlive the session anyway.
//
// One `ps` per look, no port lookup: anything listening below a shell is a
// process below a shell, which already counts.

import { rootFrom } from "../paths.ts"
import * as Pr from "./procs.ts"
import * as S from "./service.ts"

/** What keeps a session from being ended now, as `ps` sees it. */
export function liveActivity(pid: number, root = rootFrom(import.meta.url)): Pr.Activity[] {
  if (process.env.CROSSTALK_NO_POSTPONE || !pid) return []
  const table = Pr.psTable()
  if (!table.some((p) => p.ppid === pid && Pr.isShell(p))) return []
  const look = S.liveLook()
  const exclude = S.readAll().length ? S.servicePids({ ...look, table: () => table }) : new Set<number>()
  return Pr.activity(pid, { table, listeners: [], exclude, ours: Pr.oursBy(root) })
}

/** How a postponed end is retried: every `poll` ms, for at most `until` ms. */
export const POLL_MS = () => Number(process.env.CROSSTALK_POSTPONE_POLL_MS ?? 15_000)
export const UNTIL_MS = () => Number(process.env.CROSSTALK_POSTPONE_UNTIL_MS ?? 2 * 60 * 60_000)

/** Short words for what is running, for a log line. */
export const what = (a: Pr.Activity[]) =>
  a
    .slice(0, 3)
    .map((x) => x.args.split(/\s+/).slice(0, 3).join(" "))
    .join(", ") + (a.length > 3 ? ", …" : "")
