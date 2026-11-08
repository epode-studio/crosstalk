// Less to carry: how much crosstalk asks of the person, and when.
//
//   normal   questions that stop an agent (its own question, a permission
//            prompt, a teammate's question, what the person just asked for)
//            come at once; the rest wait for a natural break and come
//            together, every half hour or once five are waiting (a
//            "decision window")
//   focus    "I'm focusing for an hour": only what stops an agent comes;
//            when it ends, one line says what waited
//   away     "I'm going to bed", "out for a walk": everything keeps going as
//            far as it safely can. An agent's question takes its recommended
//            option, or the agent picks the safest reversible choice itself
//            and notes why; open lists are tackled (a few rounds per
//            session); the board is worked, paused at 90% of the plan's
//            5-hour window. Permission prompts, deploys and anything only the
//            person can do wait. The first message back ends it with a
//            summary of what happened.
//
// Breaks: after twelve decisions in an hour, a nudge to take five, and
// what can wait waits ten minutes.
//
// Defaults: an agent's question that marks an option "(Recommended)" says it
// will go with that in fifteen minutes; unanswered by then, it does, and the
// choice is listed in Lately and in the next summary.

import fs from "node:fs"
import path from "node:path"
import { P } from "../config.ts"

export type Decision = { at: number; who: string; question: string; answer: string; how: "default" | "away" }
export type State = {
  mode?: "focus" | "away"
  since?: number
  until?: number
  /** Away: whether the board was being worked before, to put it back. */
  workerWasOn?: boolean
  /** Away: what the sessions had cost when it began, for the summary. */
  usdAtStart?: number
  /** Away: open lists tackled by itself, per session, this time. */
  rounds?: Record<string, number>
  /** Focus ended, said once. */
  endedNote?: string
  /** Non-urgent questions wait until this (a break nudge). */
  holdUntil?: number
  /** When the current decision window opened. */
  windowAt?: number
  /** Answers given, the last hour's, for the break nudge. */
  answers?: number[]
  nudgedAt?: number
  /** A break nudge, shown once by the next session that asks. */
  nudge?: string
  /** Decisions made without the person: by a default, or while away. */
  decisions?: Decision[]
}

const file = () => path.join(P.root, "calm.json")
export const WINDOW_MS = () => Number(process.env.CROSSTALK_WINDOW_MS ?? 30 * 60_000)
export const WINDOW_OPEN_MS = 2 * 60_000
export const WINDOW_COUNT = 5
export const DEFAULT_AFTER_MS = () => Number(process.env.CROSSTALK_DEFAULT_AFTER_MS ?? 15 * 60_000)
export const AWAY_ROUNDS = 5
export const NUDGE_AT = 12

export function read(): State {
  try {
    return JSON.parse(fs.readFileSync(file(), "utf8")) ?? {}
  } catch {
    return {}
  }
}

/** Read, change, write: one writer at a time (a short lock), whole file replaced. */
export function update<T>(fn: (s: State) => T): T {
  fs.mkdirSync(P.root, { recursive: true, mode: 0o700 })
  const lock = `${file()}.lock`
  let held = false
  for (let i = 0; i < 40 && !held; i++) {
    try {
      fs.mkdirSync(lock)
      held = true
    } catch {
      try {
        if (Date.now() - fs.statSync(lock).mtimeMs > 5000) fs.rmdirSync(lock)
      } catch {}
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 5)
    }
  }
  try {
    const s = read()
    const out = fn(s)
    const tmp = `${file()}.${process.pid}.tmp`
    fs.writeFileSync(tmp, JSON.stringify(s), { mode: 0o600 })
    fs.renameSync(tmp, file())
    return out
  } finally {
    if (held)
      try {
        fs.rmdirSync(lock)
      } catch {}
  }
}

/** The mode now: an expired focus or away is over. */
export function mode(s: State = read(), now = Date.now()): "focus" | "away" | undefined {
  if (!s.mode) return undefined
  if (s.until && now >= s.until && s.mode === "focus") return undefined
  return s.mode
}

export const isAway = (now = Date.now()) => mode(read(), now) === "away"

// --- what may interrupt ------------------------------------------------------------------

/** What stops an agent or was just asked for: never held. */
export function urgent(it: { id: string; kind: string }): boolean {
  return it.kind === "session" || it.kind === "restore" || it.kind === "ask" || it.id.startsWith("relay:") || it.id.startsWith("attn:perm:") || it.id.startsWith("sess:")
}

/**
 * Whether a non-urgent question may be asked now. Opens a decision window
 * when it is time (half an hour since the last, or five waiting); a window
 * stays open two minutes, so its questions come one after another.
 */
export function windowOpen(s: State, waiting: number, now: number): boolean {
  const m = mode(s, now)
  if (m === "focus" || m === "away") return false
  if (s.holdUntil && now < s.holdUntil) return false
  if (s.windowAt && now - s.windowAt < WINDOW_OPEN_MS) return true
  return !s.windowAt || now - s.windowAt >= WINDOW_MS() || waiting >= WINDOW_COUNT
}

/** One answer given: counted for the break nudge. Returns the nudge to show, once in a while. */
export function answered(s: State, now: number): string | null {
  s.answers = [...(s.answers ?? []).filter((t) => now - t < 3600_000), now]
  if (s.answers.length < NUDGE_AT || (s.nudgedAt && now - s.nudgedAt < 2 * 3600_000)) return null
  s.nudgedAt = now
  s.holdUntil = now + 10 * 60_000
  return `${s.answers.length} decisions in the last hour. Take five: anything that can wait will, for ten minutes.`
}

// --- modes ------------------------------------------------------------------------------

/** "Focusing for an hour": minutes, 60 unless said. */
export function startFocus(s: State, minutes: number, now: number) {
  s.mode = "focus"
  s.since = now
  s.until = now + Math.max(5, Math.min(8 * 60, minutes || 60)) * 60_000
  delete s.endedNote
}

export function startAway(s: State, o: { now: number; workerWasOn: boolean; usd: number; hours?: number }) {
  s.mode = "away"
  s.since = o.now
  s.until = o.hours ? o.now + o.hours * 3600_000 : undefined
  s.workerWasOn = o.workerWasOn
  s.usdAtStart = o.usd
  s.rounds = {}
}

/** Back to normal. Returns when the mode began, for the summary. */
export function end(s: State): { mode?: "focus" | "away"; since?: number; workerWasOn?: boolean; usdAtStart?: number } {
  const was = { mode: s.mode, since: s.since, workerWasOn: s.workerWasOn, usdAtStart: s.usdAtStart }
  delete s.mode
  delete s.until
  delete s.rounds
  delete s.workerWasOn
  delete s.usdAtStart
  return was
}

/** Away: one more round of an open list for this session, while under the limit. */
export function takeRound(s: State, sessionId: string): boolean {
  const r = (s.rounds ??= {})
  if ((r[sessionId] ?? 0) >= AWAY_ROUNDS) return false
  r[sessionId] = (r[sessionId] ?? 0) + 1
  return true
}

export function decided(s: State, d: Decision) {
  s.decisions = [...(s.decisions ?? []).filter((x) => d.at - x.at < 7 * 86_400_000), d].slice(-100)
}

// --- an agent's question, without the person ------------------------------------------

export type Option = { label: string; description?: string }

/** The option the agent recommended, if it marked one. */
export function recommended(options: Option[]): Option | undefined {
  return options.find((o) => /\(recommended\)/i.test(o.label) || /^recommended\b/i.test(o.description ?? ""))
}

/**
 * Away: the answer an agent gets. Its recommended option; otherwise words
 * that let it keep going safely.
 */
export function awayAnswer(options: Option[], until?: number): { answer: string; how: "recommended" | "own" } {
  const r = recommended(options)
  if (r) return { answer: r.label, how: "recommended" }
  const back = until ? ` (back around ${new Date(until).toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit" })})` : ""
  return {
    answer: `The person is away${back} and asked crosstalk to keep things going. Choose the safest, most reversible option yourself, write down which and why as a decision in the thread (crosstalk_thread), and carry on. If nothing here is safe to choose without them, leave this part, say so in the thread, and continue with the rest of the work.`,
    how: "own",
  }
}
