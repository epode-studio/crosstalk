// Every agent at a glance, for the pane: "show me all my agents", and always in
// the main session's pane. One line each: its name, what it is on, and whether
// it is working, waiting on you, or idle (and for how long).
//
// Read every second while the pane is open, so nothing here runs a process per
// session: liveness is a signal 0, the state is Claude Code's own registry.

import path from "node:path"
import * as R from "../restore.ts"
import { readRegistry } from "../gather.ts"
import * as ui from "../uistate.ts"
import * as N from "../sessions/names.ts"
import type { PaneAgent } from "./pure.ts"
import { readTab } from "../terminal/status.ts"
import * as T from "../sessions/transcripts.ts"
import * as Usage from "./usage.ts"
import fs from "node:fs"

const alive = (pid: number) => {
  try {
    process.kill(pid, 0)
    return true
  } catch (e) {
    return (e as NodeJS.ErrnoException).code === "EPERM"
  }
}

/** Pure: the agents line up from what is handed in. Waiting on you first, then working, then idle longest last. */
export function agentsFrom(o: {
  recs: Pick<R.Rec, "sessionId" | "cwd" | "name" | "seenAt" | "thread" | "terminal" | "endedAt" | "interactive" | "pid">[]
  status: (id: string) => string | undefined
  waiting: (id: string) => number
  alive: (pid: number) => boolean
  name: (id: string) => string | undefined
  /** Its own question or permission prompt is up (the Notification hook's "waiting" on its tab). */
  asking?: (id: string) => boolean
  /** The question its agent is waiting on, if any (src/sessions/transcripts.ts openQuestion). */
  asks?: (id: string, cwd: string) => string | undefined
  /** What it has cost so far, as a pane writes it. */
  cost?: (id: string) => string | undefined
  self?: string
  now: number
}): PaneAgent[] {
  const out: PaneAgent[] = []
  for (const r of o.recs) {
    if (r.endedAt || r.interactive === false || !o.alive(r.pid)) continue
    const st = o.status(r.sessionId)
    const forYou = o.waiting(r.sessionId)
    // Every agent's: a question can be up whatever Claude Code calls its state. Read only when its transcript changed.
    const asks = o.asks?.(r.sessionId, r.cwd)
    const state: PaneAgent["state"] = forYou > 0 || st === "waiting" || o.asking?.(r.sessionId) || asks ? "waiting" : st && st !== "idle" ? "working" : "idle"
    const label = o.name(r.sessionId) ?? (r.name && !/^session-\d+$/.test(r.name) ? r.name : path.basename(r.cwd) || r.sessionId.slice(0, 8))
    out.push({
      name: label,
      ...(r.thread ? { thread: r.thread } : {}),
      state,
      ...(forYou ? { forYou } : {}),
      ...(state === "idle" ? { idleMin: Math.max(0, Math.floor((o.now - r.seenAt) / 60_000)) } : {}),
      ...(r.terminal?.tmux?.socket && path.basename(r.terminal.tmux.socket) === "crosstalk" ? { background: true } : {}),
      ...(r.sessionId === o.self ? { here: true } : {}),
      sessionId: r.sessionId,
      ...(asks ? { asks } : {}),
      ...(o.cost?.(r.sessionId) ? { cost: o.cost(r.sessionId) } : {}),
    })
  }
  const rank = { waiting: 0, working: 1, idle: 2 } as const
  return out.sort((a, b) => rank[a.state] - rank[b.state] || (a.idleMin ?? 0) - (b.idleMin ?? 0) || a.name.localeCompare(b.name))
}

const askCache = new Map<string, { m: number; q?: string }>()

export function agents(self?: string, now = Date.now()): PaneAgent[] {
  const reg = new Map<string, string>()
  try {
    for (const e of readRegistry()) reg.set(e.sessionId, e.status)
  } catch {}
  let snap: Record<string, ui.UiItem> = {}
  try {
    snap = ui.snapshot()
  } catch {}
  const waiting = new Map<string, number>()
  for (const i of Object.values(snap)) if (!["answered", "handed", "muted"].includes(i.state)) waiting.set(i.sessionId, (waiting.get(i.sessionId) ?? 0) + 1)
  const asking = (id: string) => {
    const t = readTab(id)
    return (t?.base ?? t?.want) === "waiting"
  }
  // A transcript is read only when it changed since the last look: the pane asks every second.
  const asks = (id: string, cwd: string) => {
    const file = T.transcriptOf(id, cwd)
    if (!file) return undefined
    let m = 0
    try {
      m = fs.statSync(file).mtimeMs
    } catch {
      return undefined
    }
    const hit = askCache.get(file)
    if (hit && hit.m === m) return hit.q
    const q = T.openQuestion(file)
    const text = q ? `${q.question}${q.options.length ? ` (${q.options.join(" / ")})` : ""}` : undefined
    askCache.set(file, { m, q: text })
    return text
  }
  const spent = Usage.all()
  const cost = (id: string) => Usage.usdText(spent.get(id.replace(/[^A-Za-z0-9._-]/g, "_"))?.usd) || undefined
  return agentsFrom({ recs: R.readAll(), status: (id) => reg.get(id), waiting: (id) => waiting.get(id) ?? 0, alive, name: (id) => N.nameOf(id) ?? undefined, asking, asks, cost, self, now })
}

export { agentLine } from "./pure.ts"
