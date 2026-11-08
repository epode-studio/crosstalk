// Pull requests' checks (CI): what state they are in, how long until they
// finish, and what changed since the last look.
//
//   state     from `gh pr view --json state,isDraft,statusCheckRollup`: running,
//             passed, failed or none, and which failed
//   eta       how long this repository's checks usually take (the median of the
//             last runs crosstalk saw finish, ci-durations.json) minus how long
//             these have run: "about 6 min left", so nobody has to ask
//   changes   passed, failed, merged, closed: what liveness.ts hands the daemon,
//             which tells the PR's session and, on a failure, keeps a task to
//             investigate it in the thread

import fs from "node:fs"
import path from "node:path"
import { P } from "../config.ts"

export type Checks = "running" | "passed" | "failed" | "none"
export type PrView = { state: string; draft: boolean; checks: Checks; failed: string[]; startedAt?: number; /** Its author's GitHub login. */ author?: string }

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
