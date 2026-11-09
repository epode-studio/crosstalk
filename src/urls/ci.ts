// Pull requests' checks (CI): what state they are in, how long until they
// finish, and what changed since the last look.
//
//   state     from `gh pr view --json state,isDraft,statusCheckRollup,...`: running,
//             passed, failed or none, and which failed; its review and whether
//             it can be merged, for merging it when green (src/urls/merge.ts)
//   eta       how long this repository's checks usually take (the median of the
//             last runs crosstalk saw finish, ci-durations.json) minus how long
//             these have run: "about 6 min left", so nobody has to ask
//   changes   passed, failed, merged, closed: what liveness.ts hands the daemon,
//             which tells the PR's session and, on a failure, keeps a task to
//             investigate it in the thread; teammates in the thread hear a merge
//             or a failure once (tellTeam)

import fs from "node:fs"
import path from "node:path"
import { P } from "../config.ts"

export type Checks = "running" | "passed" | "failed" | "none"
export type PrView = {
  state: string
  draft: boolean
  checks: Checks
  failed: string[]
  startedAt?: number
  /** Its author's GitHub login. */
  author?: string
  /** gh's reviewDecision: APPROVED, REVIEW_REQUIRED, CHANGES_REQUESTED, or empty when no review is required. */
  review?: string
  /** gh's mergeable: MERGEABLE, CONFLICTING or UNKNOWN. */
  mergeable?: string
  /** gh's mergeStateStatus: CLEAN, BLOCKED, BEHIND, DIRTY, DRAFT, UNSTABLE, HAS_HOOKS, UNKNOWN. */
  mergeState?: string
  /** Set to merge by itself (auto-merge, or waiting for its merge queue). */
  autoMerge?: boolean
}

const FAIL = new Set(["FAILURE", "TIMED_OUT", "CANCELLED", "ACTION_REQUIRED", "STARTUP_FAILURE", "ERROR"])
const OK = new Set(["SUCCESS", "NEUTRAL", "SKIPPED"])

/** gh's JSON for one PR, summed up. */
export function summarize(j: any): PrView {
  const roll: any[] = Array.isArray(j?.statusCheckRollup) ? j.statusCheckRollup : []
  const failed: string[] = []
  let running = false
  let starts: number[] = []
  for (const c of roll) {
    const name = String(c?.name ?? c?.context ?? "check")
    const status = String(c?.status ?? "").toUpperCase()
    const concl = String(c?.conclusion ?? c?.state ?? "").toUpperCase()
    if ((status && status !== "COMPLETED") || concl === "PENDING" || concl === "EXPECTED") running = true
    else if (FAIL.has(concl)) failed.push(name)
    else if (!OK.has(concl) && concl) running = running || false
    const st = Date.parse(c?.startedAt ?? "")
    if (Number.isFinite(st)) starts.push(st)
  }
  const checks: Checks = !roll.length ? "none" : failed.length ? "failed" : running ? "running" : "passed"
  return {
    state: String(j?.state ?? ""),
    draft: !!j?.isDraft,
    ...(typeof j?.author?.login === "string" ? { author: j.author.login } : {}),
    ...(typeof j?.reviewDecision === "string" ? { review: j.reviewDecision.toUpperCase() } : {}),
    ...(typeof j?.mergeable === "string" ? { mergeable: j.mergeable.toUpperCase() } : {}),
    ...(typeof j?.mergeStateStatus === "string" ? { mergeState: j.mergeStateStatus.toUpperCase() } : {}),
    ...(j?.autoMergeRequest ? { autoMerge: true } : {}),
    checks,
    failed: [...new Set(failed)].slice(0, 8),
    ...(starts.length ? { startedAt: Math.min(...starts) } : {}),
  }
}

// --- how long checks take, per repository ----------------------------------------------

const file = () => path.join(P.root, "ci-durations.json")

/** `owner/repo` from a PR's URL. */
export const repoOf = (url: string) => /github\.com\/([^/]+\/[^/]+)\/pull\//.exec(url)?.[1]?.toLowerCase()

function read(): Record<string, number[]> {
  try {
    return JSON.parse(fs.readFileSync(file(), "utf8")) ?? {}
  } catch {
    return {}
  }
}

/** A run that finished: kept, the last twenty per repository. */
export function recordDuration(repo: string | undefined, ms: number) {
  if (!repo || !(ms > 0) || ms > 6 * 3600_000) return
  const all = read()
  all[repo] = [...(all[repo] ?? []), Math.round(ms)].slice(-20)
  try {
    fs.mkdirSync(P.root, { recursive: true, mode: 0o700 })
    const tmp = `${file()}.${process.pid}.tmp`
    fs.writeFileSync(tmp, JSON.stringify(all), { mode: 0o600 })
    fs.renameSync(tmp, file())
  } catch {}
}

export function median(xs: number[]): number | undefined {
  if (!xs.length) return undefined
  const s = [...xs].sort((a, b) => a - b)
  return s[Math.floor(s.length / 2)]
}

/** Milliseconds left, from this repository's usual run, or undefined when there is no history yet. */
export function etaMs(repo: string | undefined, startedAt: number | undefined, now: number, history: Record<string, number[]> = read()): number | undefined {
  if (!repo || !startedAt) return undefined
  const m = median(history[repo] ?? [])
  if (!m) return undefined
  return Math.max(60_000, m - (now - startedAt))
}

/** How long a run usually takes past which it is "taking longer than usual". */
export const SLOW_FACTOR = 1.5

/**
 * What a person reads for checks still running: `about 6 min left`, or
 * `taking longer than usual` once a run has gone well past its usual length,
 * rather than an ETA that has already passed. Empty with no history yet.
 */
export function etaLine(repo: string | undefined, startedAt: number | undefined, now: number, history: Record<string, number[]> = read()): string {
  if (!repo || !startedAt) return ""
  const m = median(history[repo] ?? [])
  if (!m) return ""
  if (now - startedAt > SLOW_FACTOR * m) return "taking longer than usual"
  return etaText(etaMs(repo, startedAt, now, history))
}

/** `about 6 min left`, `about 1 h left`. */
export function etaText(ms: number | undefined): string {
  if (ms === undefined) return ""
  const min = Math.round(ms / 60_000)
  return min < 60 ? `about ${Math.max(1, min)} min left` : `about ${Math.round(min / 60)} h left`
}

// --- what changed ---------------------------------------------------------------------

export type Change = { kind: "passed" | "failed" | "merged" | "closed"; failed?: string[] }

/** What happened between two looks at one PR. */
export function change(before: { state?: string; checks?: string } | undefined, after: PrView): Change | null {
  if (!before) return null
  if (after.state === "MERGED" && before.state !== "MERGED") return { kind: "merged" }
  if (after.state === "CLOSED" && before.state !== "CLOSED") return { kind: "closed" }
  if (before.checks === after.checks) return null
  if (after.checks === "failed") return { kind: "failed", failed: after.failed }
  if (after.checks === "passed" && before.checks === "running") return { kind: "passed" }
  return null
}

/** The line a session is handed, and a person shown. */
export function changeText(label: string, url: string, c: Change): string {
  if (c.kind === "merged") return `${label} merged (${url}).`
  if (c.kind === "closed") return `${label} was closed without merging (${url}).`
  if (c.kind === "passed") return `${label}: checks passed (${url}).`
  return `${label}: checks failed${c.failed?.length ? `: ${c.failed.join(", ")}` : ""} (${url}). A task to investigate it is in the thread.`
}

// --- telling teammates ------------------------------------------------------------------

/** The line teammates in the thread hear: `auth · PR #12 merged (paul)`. Only a merge or a failure is news to them. */
export function teamText(label: string, c: Change, me: string): string | undefined {
  if (c.kind === "merged") return `${label} merged (${me})`
  if (c.kind === "failed") return `${label}: checks failed (${me})`
  return undefined
}

const told = () => path.join(P.root, "ci-told.json")

/**
 * Whether teammates have not yet heard this (PR, kind): true once, then false,
 * kept across restarts. A week's worth, two hundred at most.
 */
export function firstTime(key: string, now = Date.now()): boolean {
  let all: Record<string, number> = {}
  try {
    all = JSON.parse(fs.readFileSync(told(), "utf8")) ?? {}
  } catch {}
  if (all[key]) return false
  all[key] = now
  const kept = Object.entries(all)
    .filter(([, at]) => now - at < 7 * 86_400_000)
    .sort((a, b) => a[1] - b[1])
    .slice(-200)
  try {
    fs.mkdirSync(P.root, { recursive: true, mode: 0o700 })
    const tmp = `${told()}.${process.pid}.tmp`
    fs.writeFileSync(tmp, JSON.stringify(Object.fromEntries(kept)), { mode: 0o600 })
    fs.renameSync(tmp, told())
  } catch {}
  return true
}

/**
 * A PR in a thread merged, or its checks failed: the other people in that
 * thread hear it once, over the same path a message to them takes (`send`).
 * Nothing when the thread is only this person's. Returns who was told.
 */
export function tellTeam(o: { u: { id: string; label: string }; c: Change; threadId?: string; me: string; teammates: (threadIds: string[]) => string[]; send: (label: string, text: string) => void; once?: (key: string) => boolean }): string[] {
  const text = teamText(o.u.label, o.c, o.me)
  if (!text || !o.threadId) return []
  const labels = o.teammates([o.threadId])
  if (!labels.length) return []
  if (!(o.once ?? firstTime)(`${o.u.id}:${o.c.kind}`)) return []
  for (const l of labels) o.send(l, text)
  return labels
}

/** The investigation a failure becomes, kept as a task in the thread. */
export const investigation = (label: string, url: string, failed: string[] = []) =>
  `Investigate why ${failed.length ? failed.join(", ") : "the checks"} failed on ${label} (${url}): read the logs, find the cause, fix it or say what blocks it`

// --- what just happened, for the main session's pane ---------------------------------

const events = () => path.join(P.root, "events.json")

export type Event = { text: string; at: number }

/** Kept for the main session's pane: the last thirty, a day at most. */
export function recordEvent(text: string, at = Date.now()) {
  let all: Event[] = []
  try {
    all = JSON.parse(fs.readFileSync(events(), "utf8")) ?? []
  } catch {}
  all = [...all.filter((e) => at - e.at < 86_400_000), { text, at }].slice(-30)
  try {
    fs.mkdirSync(P.root, { recursive: true, mode: 0o700 })
    const tmp = `${events()}.${process.pid}.tmp`
    fs.writeFileSync(tmp, JSON.stringify(all), { mode: 0o600 })
    fs.renameSync(tmp, events())
  } catch {}
}

export function recentEvents(n = 6, now = Date.now()): Event[] {
  try {
    const all: Event[] = JSON.parse(fs.readFileSync(events(), "utf8")) ?? []
    return all.filter((e) => now - e.at < 86_400_000).slice(-n).reverse()
  } catch {
    return []
  }
}
