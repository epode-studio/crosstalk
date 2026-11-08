// Sessions that are finished close themselves: crosstalk's job, not the person's.
//
//   shipped   its pull request merged, and it has sat idle ten minutes since
//   idle      nothing from it for three hours
//
// Only when it is safe to: never main, never the tab the person is looking
// at, never a session that is busy or waiting on the person, nothing of
// crosstalk's open for it, nothing it started still running (a dev server, a
// watcher), and no uncommitted changes in its folder. Closed is archived, not
// lost: "resume <name>" brings it back with its conversation, and Lately says
// what was closed and why.

import { spawnSync } from "node:child_process"
import fs from "node:fs"

export const SHIPPED_IDLE_MS = () => Number(process.env.CROSSTALK_CLOSE_SHIPPED_MS ?? 10 * 60_000)
export const IDLE_MS = () => Number(process.env.CROSSTALK_CLOSE_IDLE_MS ?? 3 * 3600_000)

export type Candidate = {
  sessionId: string
  name: string
  cwd: string
  seenAt: number
  status: string
  shippedAt?: number
  isMain: boolean
  inFront: boolean
  waiting: number
  running: boolean
  dirty: boolean
}

/** Why it may close now, or null. Pure. */
export function why(c: Candidate, now: number): string | null {
  if (c.isMain || c.inFront || c.waiting > 0 || c.running || c.dirty) return null
  if (c.status && c.status.toLowerCase() !== "idle") return null
  const idle = now - c.seenAt
  if (c.shippedAt && c.shippedAt <= now && idle >= SHIPPED_IDLE_MS()) return "its work shipped"
  if (idle >= IDLE_MS()) return `idle ${Math.round(idle / 3600_000)} h`
  return null
}

/** Uncommitted changes in its folder (a checkout git cannot read counts as clean: nothing to lose). */
export function dirty(cwd: string): boolean {
  if (!cwd || !fs.existsSync(cwd)) return false
  const r = spawnSync("git", ["-C", cwd, "status", "--porcelain", "--untracked-files=no"], { encoding: "utf8", timeout: 5000 })
  return r.status === 0 && r.stdout.trim().length > 0
}
