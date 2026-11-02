// When the person last typed, and in which session.
//
// The UserPromptSubmit hook (and the mod's turn.start) touch one small file per
// session, so the hook pays one write and nothing needs a lock: the newest
// file is the session typed in last, its time is when. The daemon reads them
// for two things: where a question goes when no terminal can say which tab is
// in front (focus.ts), and whether the person is away (push.ts).

import fs from "node:fs"
import path from "node:path"
import { P } from "../config.ts"

const dir = () => path.join(P.root, "typed")
const safe = (id: string) => id.replace(/[^A-Za-z0-9._-]/g, "_")

export function noteTyped(sessionId: string, now = Date.now()) {
  if (!sessionId) return
  try {
    fs.mkdirSync(dir(), { recursive: true, mode: 0o700 })
    const f = path.join(dir(), safe(sessionId))
    fs.writeFileSync(f, sessionId, { mode: 0o600 })
    const t = new Date(now)
    fs.utimesSync(f, t, t)
  } catch {}
}

/** Every session typed in, newest first. */
export function typed(): { sessionId: string; at: number }[] {
  let names: string[]
  try {
    names = fs.readdirSync(dir())
  } catch {
    return []
  }
  const out: { sessionId: string; at: number }[] = []
  for (const n of names) {
    try {
      const f = path.join(dir(), n)
      out.push({ sessionId: fs.readFileSync(f, "utf8") || n, at: fs.statSync(f).mtimeMs })
    } catch {}
  }
  return out.sort((a, b) => b.at - a.at)
}

export const lastTyped = () => typed()[0]

/** Files of sessions nobody will type in again. */
export function prune(keep: Set<string>, now = Date.now()) {
  for (const t of typed()) if (!keep.has(t.sessionId) && now - t.at > 7 * 24 * 3600_000) {
    try {
      fs.unlinkSync(path.join(dir(), safe(t.sessionId)))
    } catch {}
  }
}

/**
 * Away: nothing typed anywhere and the tab in front unchanged for `minutes`.
 * `focusChangedAt` is the daemon's own record of the last time the focused
 * session changed.
 */
export function isAway(o: { now: number; lastTypedAt?: number; focusChangedAt?: number; minutes: number }): boolean {
  const last = Math.max(o.lastTypedAt ?? 0, o.focusChangedAt ?? 0)
  return o.now - last >= o.minutes * 60_000
}

export const awayMinutes = (env: NodeJS.ProcessEnv = process.env) => {
  const n = Number(env.CROSSTALK_AWAY_MIN)
  return Number.isFinite(n) && n >= 0 && env.CROSSTALK_AWAY_MIN !== undefined && env.CROSSTALK_AWAY_MIN !== "" ? n : 10
}
