// Merging the person's own PRs once they are green (src/attention/service.ts
// asks; this decides and does it).
//
//   ready     checks just passed, open, not a draft, approved or needing no
//             review, and nothing in the way (no conflicts): the only time a
//             question is put, one per green run
//   rule      "Always merge my green PRs" (kept in the attention state):
//             merged without asking, one quiet line in main says so
//   merge     `gh pr merge <url> --auto` with a method the repository allows,
//             squash first, so GitHub merges it as soon as its own rules let it
//   off       CROSSTALK_NO_MERGE=1: never asked, never merged

import * as L from "./liveness.ts"
import type { Change, PrView } from "./ci.ts"

/** Off for good on this machine: CROSSTALK_NO_MERGE=1. */
export const disabled = (env: NodeJS.ProcessEnv = process.env) => env.CROSSTALK_NO_MERGE === "1"

/** Why a green PR is not one to merge, or undefined when it is. */
export function blocker(v: Pick<PrView, "state" | "draft" | "checks" | "review" | "mergeable" | "mergeState">): string | undefined {
  if (v.state !== "OPEN") return "not open"
  if (v.draft || v.mergeState === "DRAFT") return "a draft"
  if (v.checks !== "passed") return "checks not green"
  if (v.review === "REVIEW_REQUIRED") return "waiting for a review"
  if (v.review === "CHANGES_REQUESTED") return "changes requested"
  if (v.mergeable === "CONFLICTING" || v.mergeState === "DIRTY") return "has conflicts"
  return undefined
}

export type Decision = "ask" | "merge" | "none"

/**
 * What to do when a PR's checks change: ask (one question), merge (the
 * person said always), or nothing. `mine` is already true for every PR
 * liveness hands on (the person's own); it is checked again here all the same.
 */
export function decide(o: { change: Change; view: PrView; mine?: boolean; always?: boolean; env?: NodeJS.ProcessEnv }): Decision {
  if (disabled(o.env)) return "none"
  if (o.mine === false) return "none"
  if (o.change.kind !== "passed") return "none"
  if (blocker(o.view)) return "none"
  return o.always ? "merge" : "ask"
}

/** The question: `auth · PR #12 is green and approved. Merge it?` */
export function question(label: string, v: Pick<PrView, "review">): string {
  return `${label} is green${v.review === "APPROVED" ? " and approved" : ""}. Merge it?`
}

export type Methods = { squashMergeAllowed?: boolean; mergeCommitAllowed?: boolean; rebaseMergeAllowed?: boolean }

/** The flag for a method the repository allows: squash, else a merge commit, else rebase. Undefined when gh did not say. */
export function methodFlag(m: Methods | undefined): string | undefined {
  if (!m) return undefined
  if (m.squashMergeAllowed) return "--squash"
  if (m.mergeCommitAllowed) return "--merge"
  if (m.rebaseMergeAllowed) return "--rebase"
  return undefined
}

/** `owner/repo` from a PR's URL, as gh wants it. */
const repoArg = (url: string) => /github\.com\/([^/]+\/[^/]+)\/pull\//.exec(url)?.[1]

export type Merger = (url: string, cwd?: string) => Promise<{ ok: boolean; text: string }>

/** `gh pr merge <url> --auto --squash`, never holding the daemon up. */
export const ghMerge: Merger = async (url, cwd) => {
  const repo = repoArg(url)
  let methods: Methods | undefined
  if (repo) {
    const r = await L.runGh(["repo", "view", repo, "--json", "squashMergeAllowed,mergeCommitAllowed,rebaseMergeAllowed"], { cwd, timeoutMs: 15_000 })
    try {
      if (r.ok) methods = JSON.parse(r.stdout)
    } catch {}
  }
  const flag = methodFlag(methods) ?? "--squash"
  const r = await L.runGh(["pr", "merge", url, "--auto", flag], { cwd, timeoutMs: 30_000 })
  return r.ok ? { ok: true, text: flag.slice(2) } : { ok: false, text: "gh could not merge it" }
}
