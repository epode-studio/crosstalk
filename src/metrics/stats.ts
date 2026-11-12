// What the local measurements add up to (log.ts). Pure: events and threads in,
// numbers and sentences out, so the same arithmetic backs crosstalk_inbox action "stats", the
// weekly digest line and anything the README cites later.
//
//   idea to merge     per thread, from its first edit (the thread's start:
//                     threads are made by the first files a session touches)
//                     to its first merged feature
//   human minutes     time pickers were open before a person answered, each
//                     capped at QUESTION_CAP_MS, plus typing: prompt length
//                     at CHARS_PER_MIN. Approximate by design, and it says so
//   questions         asked of a person vs answered by a standing rule, per week
//   tokens            to the first edit, for sessions started with a thread
//                     brief and without one: the "fewer tokens" claim

import * as M from "../threads/model.ts"
import type { Event } from "./log.ts"
import type { FirstEdit } from "./transcripts.ts"

export const QUESTION_CAP_MS = 15 * 60_000
/** About 40 words a minute. */
export const CHARS_PER_MIN = 200
const WEEK = 7 * 24 * 60 * 60_000

export type ThreadStat = { name: string; repo: string; startedAt: number; mergedAt?: number; ideaToMergeMs?: number; humanMin: number }
export type WeekStat = { week: string; asked: number; answered: number; auto: number; humanMin: number; merged: number }
export type TokenStat = { n: number; median?: number; medianFresh?: number }

export type Stats = {
  threads: ThreadStat[]
  weeks: WeekStat[]
  tokens: { withBrief: TokenStat; without: TokenStat }
  merged: number
  medianIdeaToMergeMs?: number
  medianHumanMinPerMerged?: number
}

export const median = (xs: number[]) => {
  if (!xs.length) return undefined
  const s = [...xs].sort((a, b) => a - b)
  const m = Math.floor(s.length / 2)
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2
}

/** Monday of the week `at` falls in, as YYYY-MM-DD (UTC). */
export function weekOf(at: number): string {
  const d = new Date(at)
  const day = (d.getUTCDay() + 6) % 7
  return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate() - day)).toISOString().slice(0, 10)
}

const answeredMin = (e: Extract<Event, { k: "answered" }>) => Math.min(Math.max(0, e.openMs), QUESTION_CAP_MS) / 60_000
const typingMin = (e: Extract<Event, { k: "prompt" }>) => Math.max(0, e.chars) / CHARS_PER_MIN

function firstMerge(t: M.Thread): number | undefined {
  const at = M.live(t, "features")
    .map((f) => f.ship?.merged?.at)
    .filter((x): x is number => typeof x === "number")
  return at.length ? Math.min(...at) : undefined
}

export function compute(o: {
  events: Event[]
  threads: M.Thread[]
  now?: number
  weeks?: number
  /** Tokens to first edit for a session, from its transcript. */
  firstEdit?: (sid: string, transcript?: string) => FirstEdit | null
}): Stats {
  const now = o.now ?? Date.now()
  const nWeeks = Math.max(1, Math.min(52, o.weeks ?? 4))
  const answered = o.events.filter((e): e is Extract<Event, { k: "answered" }> => e.k === "answered")
  const prompts = o.events.filter((e): e is Extract<Event, { k: "prompt" }> => e.k === "prompt")

  const threads: ThreadStat[] = []
  for (const t of o.threads) {
    if (t.meta.value.combinedInto) continue
    const name = t.meta.value.name
    const startedAt = t.meta.value.createdAt
    const mergedAt = firstMerge(t)
    const until = mergedAt ?? now
    const humanMin =
      answered.filter((e) => e.thread === name && e.at >= startedAt && e.at <= until).reduce((s, e) => s + answeredMin(e), 0) +
      prompts.filter((e) => e.threads?.includes(name) && e.at >= startedAt && e.at <= until).reduce((s, e) => s + typingMin(e), 0)
    threads.push({ name, repo: t.meta.value.repo, startedAt, ...(mergedAt ? { mergedAt, ideaToMergeMs: Math.max(0, mergedAt - startedAt) } : {}), humanMin: round1(humanMin) })
  }

  const weeks: WeekStat[] = []
  for (let i = nWeeks - 1; i >= 0; i--) {
    const key = weekOf(now - i * WEEK)
    const inWeek = (at: number) => weekOf(at) === key
    weeks.push({
      week: key,
      asked: o.events.filter((e) => e.k === "asked" && inWeek(e.at)).length,
      answered: answered.filter((e) => inWeek(e.at)).length,
      auto: o.events.filter((e) => e.k === "auto" && inWeek(e.at)).length,
      humanMin: round1(answered.filter((e) => inWeek(e.at)).reduce((s, e) => s + answeredMin(e), 0) + prompts.filter((e) => inWeek(e.at)).reduce((s, e) => s + typingMin(e), 0)),
      merged: threads.filter((t) => t.mergedAt && inWeek(t.mergedAt)).length,
    })
  }

  const withBrief: number[][] = []
  const without: number[][] = []
  const seen = new Set<string>()
  for (const e of o.events) {
    if (e.k !== "session" || seen.has(e.sid)) continue
    seen.add(e.sid)
    const f = o.firstEdit?.(e.sid, e.transcript)
    if (!f) continue
    ;(e.brief ? withBrief : without).push([f.tokens, f.fresh])
  }
  const tok = (xs: number[][]): TokenStat => ({ n: xs.length, median: median(xs.map((x) => x[0])), medianFresh: median(xs.map((x) => x[1])) })

  const merged = threads.filter((t) => t.mergedAt)
  return {
    threads,
    weeks,
    tokens: { withBrief: tok(withBrief), without: tok(without) },
    merged: merged.length,
    medianIdeaToMergeMs: median(merged.map((t) => t.ideaToMergeMs!)),
    medianHumanMinPerMerged: median(merged.map((t) => t.humanMin)),
  }
}

const round1 = (x: number) => Math.round(x * 10) / 10

export function duration(ms?: number): string {
  if (ms === undefined) return "n/a"
  const h = ms / 3_600_000
  if (h >= 48) return `${round1(h / 24)} days`
  if (h >= 1) return `${round1(h)} h`
  return `${Math.round(ms / 60_000)} min`
}

export const kTokens = (n?: number) => (n === undefined ? "n/a" : n >= 1000 ? `${Math.round(n / 1000)}k` : String(Math.round(n)))

/** The token comparison in one sentence, the form the README can cite. */
export function tokenLine(s: Stats): string {
  const a = s.tokens.withBrief
  const b = s.tokens.without
  if (!a.n && !b.n) return "No session has made an edit yet, so there is nothing to compare."
  return `Tokens to the first edit: ${kTokens(a.median)} with a thread brief (median, n=${a.n}), ${kTokens(b.median)} without (n=${b.n}); new to the model, without cache reads: ${kTokens(a.medianFresh)} vs ${kTokens(b.medianFresh)}.`
}

/** What crosstalk_inbox action "stats" shows. */
export function render(s: Stats): string {
  const lines = ["◢ crosstalk stats (local to this machine, never sent anywhere)", ""]
  lines.push(
    `Merged threads: ${s.merged}. Median idea to merge: ${duration(s.medianIdeaToMergeMs)}. Median human minutes per merged thread: ${s.medianHumanMinPerMerged ?? "n/a"} (approximate: open pickers capped at 15 min each, plus typing at ${CHARS_PER_MIN} characters a minute).`,
  )
  lines.push(tokenLine(s), "")
  lines.push("Week of      asked  by rules  answered  your min  merged")
  for (const w of s.weeks) lines.push(`${w.week}  ${String(w.asked).padStart(5)}  ${String(w.auto).padStart(8)}  ${String(w.answered).padStart(8)}  ${String(w.humanMin).padStart(8)}  ${String(w.merged).padStart(6)}`)
  const recent = s.threads.filter((t) => t.mergedAt).sort((a, b) => b.mergedAt! - a.mergedAt!).slice(0, 8)
  if (recent.length) {
    lines.push("", "Recently merged:")
    for (const t of recent) lines.push(`  ${t.name.padEnd(24)} ${duration(t.ideaToMergeMs).padStart(9)} idea to merge, ${t.humanMin} human min`)
  }
  return lines.join("\n")
}

/** One line for the weekly digest: last week's numbers. */
export function weeklyLine(s: Stats): string {
  const w = s.weeks[s.weeks.length - 1]
  const share = w.asked + w.auto ? ` (${w.auto} of ${w.asked + w.auto} answered by standing rules)` : ""
  const merged = s.threads.filter((t) => t.mergedAt && weekOf(t.mergedAt) === w.week)
  const tok = s.tokens.withBrief.n && s.tokens.without.n ? ` First edits took ${kTokens(s.tokens.withBrief.median)} tokens from a thread brief, ${kTokens(s.tokens.without.median)} without.` : ""
  return (
    `◢ crosstalk, week of ${w.week}: ${merged.length} thread${merged.length === 1 ? "" : "s"} merged` +
    (merged.length ? ` (median ${duration(median(merged.map((t) => t.ideaToMergeMs!)))} from first edit)` : "") +
    `, about ${Math.round(w.humanMin)} min of your time, ${w.asked + w.auto} question${w.asked + w.auto === 1 ? "" : "s"}${share}.${tok} Local only; "crosstalk stats" for more.`
  )
}
