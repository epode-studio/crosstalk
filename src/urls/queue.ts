// Merge queues: watched, and unblocked.
//
// A PR of the person's that is set to merge by itself (auto-merge), or is in
// its repository's merge queue, is looked at with each PR check (GitHub's
// GraphQL: isInMergeQueue, the queue entry, and why it last left the queue).
//
//   queued     it entered the queue: Lately says where in line, and about when
//   dequeued   it left without merging, and crosstalk unblocks it:
//                failed checks, the first time for this commit: put back once
//                  (the merge group's checks are often flaky)
//                a conflict, or checks failed again: the session in its thread
//                  (or a new background agent, when none is open) is told to
//                  update the branch or fix the checks, push, and put it back
//                taken out by a person: left alone, and said so
//   stuck      first in line far longer than the queue usually takes: said
//              once, in main
//
// Putting a PR back in the queue is the person's own earlier choice (they
// queued it), redone with the same `gh pr merge --auto`. CROSSTALK_NO_QUEUE=1
// turns all of it off.

import * as L from "./liveness.ts"

export type QueueView = {
  queued: boolean
  position?: number
  /** GitHub's own estimate, in seconds. */
  eta?: number
  enqueuedAt?: number
  /** The last time it was taken out of the queue, and why (GitHub's words). */
  removed?: { at: number; reason: string }
}

export const disabled = (env: NodeJS.ProcessEnv = process.env) => env.CROSSTALK_NO_QUEUE === "1"

const QUERY = `query($o:String!,$r:String!,$n:Int!){repository(owner:$o,name:$r){pullRequest(number:$n){isInMergeQueue mergeQueueEntry{position estimatedTimeToMerge enqueuedAt} timelineItems(last:3,itemTypes:[REMOVED_FROM_MERGE_QUEUE_EVENT]){nodes{... on RemovedFromMergeQueueEvent{createdAt reason}}}}}}`

/** GitHub's answer, summed up. */
export function parse(j: any): QueueView | undefined {
  const pr = j?.data?.repository?.pullRequest
  if (!pr) return undefined
  const e = pr.mergeQueueEntry
  const nodes: any[] = Array.isArray(pr.timelineItems?.nodes) ? pr.timelineItems.nodes : []
  const last = nodes.filter((n) => n && n.createdAt).at(-1)
  const at = last ? Date.parse(last.createdAt) : NaN
  const enq = e?.enqueuedAt ? Date.parse(e.enqueuedAt) : NaN
  return {
    queued: !!pr.isInMergeQueue,
    ...(typeof e?.position === "number" ? { position: e.position } : {}),
    ...(typeof e?.estimatedTimeToMerge === "number" ? { eta: e.estimatedTimeToMerge } : {}),
    ...(Number.isFinite(enq) ? { enqueuedAt: enq } : {}),
    ...(Number.isFinite(at) ? { removed: { at, reason: String(last.reason ?? "") } } : {}),
  }
}

export type QueueOf = (url: string, cwd?: string) => Promise<QueueView | undefined> | QueueView | undefined

/** One GraphQL call, never holding the daemon up. */
export const ghQueue: QueueOf = async (url, cwd) => {
  const m = /github\.com\/([^/]+)\/([^/]+)\/pull\/(\d+)/.exec(url)
  if (!m) return undefined
  const r = await L.runGh(["api", "graphql", "-f", `query=${QUERY}`, "-F", `o=${m[1]}`, "-F", `r=${m[2]}`, "-F", `n=${m[3]}`], { cwd, timeoutMs: 20_000 })
  if (!r.ok) return undefined
  try {
    return parse(JSON.parse(r.stdout))
  } catch {
    return undefined
  }
}

export type Why = "conflict" | "failed" | "manual" | "other"

/** Why it left the queue, from GitHub's words. */
export function why(reason: string): Why {
  const r = reason.toLowerCase()
  if (/conflict|behind|out of date|not up to date/.test(r)) return "conflict"
  if (/fail|check|status|timed? ?out|ci\b|build/.test(r)) return "failed"
  if (/manual|removed by|dequeued by|by a user|user/.test(r)) return "manual"
  return "other"
}

/** What crosstalk keeps on the PR between looks. */
export type Kept = { queued?: boolean; queuedAt?: number; queueRetries?: number; queueStuckTold?: number; queueSeenRemoval?: number }

export type Step =
  | { kind: "queued"; position?: number; eta?: number }
  | { kind: "dequeued"; why: Why; reason: string; action: "requeue" | "fix" | "leave" }
  | { kind: "stuck"; minutes: number }

/** Usually long enough for a queue: an hour, or twice GitHub's estimate when it gives one. */
const stuckAfter = (eta?: number) => Math.max(60 * 60_000, (eta ?? 0) * 2000)

/**
 * What happened since the last look, and what to do; with what to keep. A
 * removal is acted on once (by its time), a stuck queue said once per entry.
 */
export function step(before: Kept, v: QueueView, now: number): { step: Step | null; keep: Kept } {
  const keep: Kept = { ...before, queued: v.queued }
  if (v.queued) {
    if (!before.queued) {
      keep.queuedAt = v.enqueuedAt ?? now
      keep.queueStuckTold = undefined
      return { step: { kind: "queued", ...(v.position !== undefined ? { position: v.position } : {}), ...(v.eta !== undefined ? { eta: v.eta } : {}) }, keep }
    }
    const since = before.queuedAt ?? v.enqueuedAt ?? now
    if ((v.position ?? 1) <= 1 && !before.queueStuckTold && now - since > stuckAfter(v.eta)) {
      keep.queueStuckTold = now
      return { step: { kind: "stuck", minutes: Math.round((now - since) / 60_000) }, keep }
    }
    return { step: null, keep }
  }
  // Out of the queue: only a removal not seen before counts (a merge is the PR's own "merged").
  if (!before.queued || !v.removed || (before.queueSeenRemoval && v.removed.at <= before.queueSeenRemoval)) return { step: null, keep }
  keep.queueSeenRemoval = v.removed.at
  const w = why(v.removed.reason)
  const retries = before.queueRetries ?? 0
  const action = w === "manual" ? "leave" : w === "conflict" ? "fix" : retries < 1 ? "requeue" : "fix"
  if (action === "requeue") keep.queueRetries = retries + 1
  if (action === "fix") keep.queueRetries = 0
  return { step: { kind: "dequeued", why: w, reason: v.removed.reason, action }, keep }
}

const ord = (n: number) => `${n}${n % 10 === 1 && n % 100 !== 11 ? "st" : n % 10 === 2 && n % 100 !== 12 ? "nd" : n % 10 === 3 && n % 100 !== 13 ? "rd" : "th"}`

/** The line for Lately and main. */
export function text(label: string, s: Step): string {
  if (s.kind === "queued") return `${label} is in the merge queue${s.position ? `, ${ord(s.position)} in line` : ""}${s.eta ? `, merging in about ${Math.max(1, Math.round(s.eta / 60))} min` : ""}.`
  if (s.kind === "stuck") return `${label} has been first in the merge queue for ${s.minutes} min, far longer than usual. The queue's own checks may be hung; worth a look in GitHub.`
  const r = s.reason ? ` (${s.reason.replace(/_/g, " ").toLowerCase()})` : ""
  if (s.action === "leave") return `${label} was taken out of the merge queue by hand${r}. Left alone.`
  if (s.action === "requeue") return `${label} left the merge queue${r}. Put back once, in case it was a flaky check.`
  return `${label} left the merge queue${r}. Being fixed, then it goes back in by itself.`
}

/** What the agent that unblocks it is told. */
export function fixPrompt(label: string, url: string, s: Extract<Step, { kind: "dequeued" }>): string {
  const what =
    s.why === "conflict"
      ? `It conflicts with, or is behind, its base branch. Bring the base branch in (merge or rebase, whichever this repository does), resolve the conflicts keeping both sides' intent, run the checks that cover what you touched, and push.`
      : `Its checks failed in the merge queue${s.reason ? ` (${s.reason})` : ""}, more than once. Find which checks failed in the merge group (gh pr checks ${url}, or the queue's run in GitHub Actions), fix the cause rather than skipping or disabling a test, run those checks locally, and push.`
  return [
    `${label} (${url}) was taken out of the merge queue, and crosstalk asks you to unblock it.`,
    what,
    `Then put it back in the queue with: gh pr merge ${url} --auto (the same method it used before). If it cannot be fixed without a decision only the person can make, ask them with AskUserQuestion, with no option marked recommended.`,
  ].join("\n")
}
