// Staffing is a suggestion (docs/design/next-generation.md, "Getting someone
// on it"): "auth has been stuck for 2 hours, add a second agent?" is a
// question, never an action, and there are no budgets.
//
// A thread is stuck when one of its sessions is active and, for two hours
// (CROSSTALK_STUCK_MS), either
//
//   a blocking question in it has gone unanswered, or
//   nothing moved: no file edited by any of its sessions, no commit on their
//   checkouts, since the later of those and the session becoming active
//
// It is asked about once per stuck spell: "Not now" holds until something
// moves again, and a yes starts one more agent with the thread's brief
// (src/spawn.ts), in the background when tmux is there.

export const stuckMs = (env: NodeJS.ProcessEnv = process.env) => {
  const n = Number(env.CROSSTALK_STUCK_MS)
  return n > 0 ? n : 2 * 60 * 60_000
}

export type Working = {
  sessionId: string
  /** When it was first seen working in this thread. */
  since: number
  lastEditAt?: number
  lastCommitAt?: number
  active: boolean
}

export type Stuck = { why: "question" | "progress"; since: number; question?: string }

/** Whether a thread is stuck now, and since when. */
export function stuck(o: { now: number; ms: number; blocking: { text: string; at: number }[]; working: Working[] }): Stuck | null {
  const active = o.working.filter((w) => w.active)
  if (!active.length) return null
  const q = [...o.blocking].sort((a, b) => a.at - b.at)[0]
  if (q && o.now - q.at >= o.ms) return { why: "question", since: q.at, question: q.text }
  const moved = Math.max(...o.working.map((w) => Math.max(w.since, w.lastEditAt ?? 0, w.lastCommitAt ?? 0)))
  if (o.now - moved >= o.ms) return { why: "progress", since: moved }
  return null
}

export function hours(ms: number): string {
  const h = ms / 3_600_000
  if (h >= 1.75) return `${Math.round(h)} hours`
  if (h >= 0.9) return "an hour"
  const m = Math.max(1, Math.round(ms / 60_000))
  return `${m} minute${m === 1 ? "" : "s"}`
}

export const ADD = "Add an agent"
export const NOT_NOW = "Not now"

export function question(name: string, s: Stuck, now: number): string {
  const how = s.why === "question" ? `has had a blocking question unanswered for ${hours(now - s.since)}` : `has been stuck for ${hours(now - s.since)}`
  return `${name} ${how}. Add a second agent?`
}

/** The new agent's first prompt. */
export function brief(name: string, s: Stuck, primer: string): string {
  const why = s.why === "question" ? `it has a blocking question nobody has answered: "${s.question}"` : "nothing has moved in it for a while"
  return `You are a second agent on the crosstalk thread "${name}", added because ${why}. Work with the session already on it (crosstalk_send reaches the thread's people) and take a part of the work it has not started.\n\n${primer}`
}
