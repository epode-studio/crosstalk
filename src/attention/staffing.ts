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

import { neutral, plainName, recordBlock, type Limits, type View } from "./dispose.ts"

export const stuckMs =(env: NodeJS.ProcessEnv = process.env) => {
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

/**
 * What the person needs to answer it from anywhere (the main session above
 * all): what the thread is doing, what it is stuck on, who is on it.
 */
export function context(o: { recap?: string; s: Stuck; agents: string[]; now: number }): string {
  const one = (x: string) => x.replace(/\s+/g, " ").trim()
  const cut = (x: string, n: number) => (x.length > n ? x.slice(0, n - 1) + "…" : x)
  const doing = o.recap ? `What it is doing: ${cut(one(o.recap), 240)}` : ""
  const why =
    o.s.why === "question" && o.s.question
      ? `Waiting ${hours(o.now - o.s.since)} on: "${cut(one(o.s.question), 200)}"`
      : `No edits or commits for ${hours(o.now - o.s.since)}.`
  const who = o.agents.length ? `On it: ${o.agents.slice(0, 4).join(", ")}${o.agents.length > 4 ? ` and ${o.agents.length - 4} more` : ""}.` : ""
  return [doing, why, who].filter(Boolean).join("\n")
}

/**
 * The new agent's first prompt. The blocking question is someone's words, so
 * it sits inside the quoted record with the rest; the task is crosstalk's and
 * comes after it.
 */
export function brief(name: string, s: Stuck, v: View): string {
  const why = s.why === "question" ? "it has a blocking question nobody has answered (at the top of the record)" : "nothing has moved in it for a while"
  const lead = s.why === "question" && s.question ? [`Blocking question: ${neutral(s.question)}`, ``] : []
  const r = recordBlock(v, undefined, lead)
  return [
    `You are a second agent on the crosstalk thread "${plainName(name)}", added because ${why}.`,
    r.note,
    ``,
    ...r.lines,
    ``,
    `## Your task`,
    `Work with the session already on the thread (crosstalk_say action "tell" reaches its people) and take a part of the work it has not started. crosstalk_thread action "read" shows the whole thread.`,
  ].join("\n")
}

// --- every new agent's brief -----------------------------------------------------
//
// An agent started from a session in a thread (crosstalk_work action "spawn", `crosstalk
// spawn`) starts from the thread, not only the task: its first prompt is the
// thread's record, kept short, then the task. The record is framed as what it
// is, notes kept by the thread's people and sessions: data about the work. The
// only instruction in the prompt is the task, which the person asked for.

/** How much of the thread a new agent's first prompt carries. */
export const BRIEF_LIMITS: Limits = { decisions: 8, questions: 6, tasks: 8, rules: 6, facts: 0, files: 12 }

/** A new agent's first prompt, from the thread it starts in: the thread's record, quoted, then its task. */
export function threadBrief(v: View, task: string, o: { from?: string } = {}): string {
  const lead = v.people?.length ? [`People: ${v.people.map((p) => neutral(p)).join(", ")}`, ``] : []
  const r = recordBlock(v, BRIEF_LIMITS, lead)
  return [
    `You are starting in the crosstalk thread "${plainName(v.name)}"${o.from ? `, started from ${plainName(o.from)}` : ""}.`,
    r.note,
    ``,
    ...r.lines,
    ``,
    `crosstalk_thread action "read" shows the whole thread; crosstalk_say action "tell" with no recipient reaches the people in it.`,
    ``,
    `## Your task`,
    task,
  ].join("\n")
}
