// Git is invisible: a feature that is green and signed off goes into the
// default branch by itself, in small pieces, often.
//
// How it lands depends on the repo:
//
//   push: direct    merged locally (fast-forward, else rebased onto the
//                   default branch in a scratch copy), then the default
//                   branch is pushed, never forced
//   push: pr        the branch is pushed and a PR opened with
//                   `gh pr create`, set to merge itself with
//                   `gh pr merge --auto --rebase`; hosted checks confirm
//   push: local     merged locally, nothing pushed
//   (not set)       pr when there is a remote and gh is installed, else local
//
// The feature's branch is never rewritten: a rebase happens on a detached
// scratch copy, so the author's checkout and branch are as they were. A
// conflict is handed back to the author's agent to settle.

import path from "node:path"
import { spawnSync } from "node:child_process"
import * as G from "./git.ts"
import type { PushMode } from "./config.ts"

export type MergeFacts = {
  defaultBranch?: string
  branch: string
  /** Commits on the branch not in the default branch. */
  ahead: number
  /** Commits on the default branch not in the branch. */
  behind: number
  /** All of the branch's commits already in, as equivalent patches. */
  landed: boolean
  remote?: string
  push?: PushMode
  gh: boolean
}

export type MergePlan =
  | { how: "nothing"; why: string }
  | { how: "refuse"; why: string }
  | { how: "ff" | "rebase"; push: boolean; why: string }
  | { how: "pr"; why: string }

export function planMerge(f: MergeFacts): MergePlan {
  if (!f.defaultBranch) return { how: "refuse", why: "this repository has no default branch to merge into" }
  if (f.branch === f.defaultBranch) return { how: "refuse", why: `the work is on ${f.branch} itself, so there is nothing to merge; it needs a branch of its own` }
  if (f.ahead === 0 || f.landed) return { how: "nothing", why: `everything on ${f.branch} is already in ${f.defaultBranch}` }
  const mode: PushMode = f.push ?? (f.remote && f.gh ? "pr" : "local")
  if (mode === "pr") {
    if (!f.remote) return { how: "refuse", why: "push: pr needs a remote" }
    if (!f.gh) return { how: "refuse", why: "push: pr needs the gh command, which is not installed" }
    return { how: "pr", why: `a PR from ${f.branch}, set to merge itself once checks pass` }
  }
  const push = mode === "direct" && !!f.remote
  const how = f.behind === 0 ? "ff" : "rebase"
  return {
    how,
    push,
    why: `${how === "ff" ? "fast-forward" : `rebased onto ${f.defaultBranch}`}${push ? `, pushed to ${f.remote}` : mode === "direct" ? " (no remote to push to)" : ", not pushed"}`,
  }
}

export function factsFor(root: string, branch: string, o: { push?: PushMode; gh?: boolean }): MergeFacts {
  const d = G.defaultBranch(root) ?? undefined
  return {
    defaultBranch: d,
    branch,
    ahead: d ? G.count(root, `${d}..${branch}`) : 0,
    behind: d ? G.count(root, `${branch}..${d}`) : 0,
    landed: d ? G.landed(root, d, branch) : false,
    remote: G.remoteName(root),
    push: o.push,
    gh: o.gh ?? !!G.which("gh"),
  }
}

export type Merged = {
  ok: boolean
  how: MergePlan["how"]
  text: string
  sha?: string
  shas?: string[]
  files?: string[]
  pr?: string
  conflict?: boolean
}

/**
 * Bring the local default branch up to its remote copy first, when it is
 * behind, so a push is a fast-forward. A default branch that has diverged
 * from its remote is left for a person: crosstalk never forces.
 */
function catchUp(root: string, d: string, remote: string): { ok: boolean; err?: string } {
  const f = G.git(root, ["fetch", "--quiet", remote, `refs/heads/${d}:refs/remotes/${remote}/${d}`], { timeoutMs: 120_000 })
  if (!f.ok) return { ok: true } // offline: the push will say so
  const theirs = G.tip(root, `refs/remotes/${remote}/${d}`)
  const mine = G.tip(root, `refs/heads/${d}`)
  if (!theirs || !mine || theirs === mine) return { ok: true }
  if (G.git(root, ["merge-base", "--is-ancestor", theirs, mine]).ok) return { ok: true }
  if (G.git(root, ["merge-base", "--is-ancestor", mine, theirs]).ok) return G.advance(root, d, theirs, mine)
  return { ok: false, err: `${d} here and on ${remote} have both moved; somebody has to bring them together first` }
}

export function executeMerge(root: string, branch: string, o: { push?: PushMode; gh?: boolean; scratchDir: string; title?: string; body?: string }): Merged {
  let facts = factsFor(root, branch, o)
  let plan = planMerge(facts)
  if (plan.how === "refuse" || plan.how === "nothing") return { ok: plan.how === "nothing", how: plan.how, text: plan.why }
  const d = facts.defaultBranch!

  if (plan.how === "pr") {
    const p = G.push(root, facts.remote!, branch)
    if (!p.ok) return { ok: false, how: "pr", text: `could not push ${branch}: ${p.err}` }
    const gh = (args: string[]) => spawnSync("gh", args, { cwd: root, encoding: "utf8", timeout: 120_000 })
    const created = gh(["pr", "create", "--head", branch, "--base", d, "--title", o.title ?? branch, "--body", o.body ?? "Opened by crosstalk."])
    const url = (created.stdout ?? "").trim().split("\n").pop() ?? ""
    if (created.status !== 0 && !/already exists/.test(created.stderr ?? "")) return { ok: false, how: "pr", text: `gh pr create failed: ${(created.stderr ?? "").trim().split("\n").pop()}` }
    const auto = gh(["pr", "merge", branch, "--auto", "--rebase"])
    const autoNote = auto.status === 0 ? "set to merge itself once checks pass" : `open, but auto-merge is off for this repository (${(auto.stderr ?? "").trim().split("\n").pop()})`
    return { ok: true, how: "pr", pr: url, text: `PR ${url || `for ${branch}`} ${autoNote}` }
  }

  if (plan.push) {
    const c = catchUp(root, d, facts.remote!)
    if (!c.ok) return { ok: false, how: plan.how, text: c.err! }
    facts = factsFor(root, branch, o)
    plan = planMerge(facts)
    if (plan.how === "nothing") return { ok: true, how: "nothing", text: plan.why }
    if (plan.how !== "ff" && plan.how !== "rebase") return { ok: false, how: plan.how, text: plan.why }
  }
  const from = G.tip(root, `refs/heads/${d}`)!
  let to = G.tip(root, `refs/heads/${branch}`)!
  if (plan.how === "rebase") {
    const where = path.join(o.scratchDir, `merge-${Date.now()}`)
    const s = G.scratch(root, to, where)
    if (!s.ok) return { ok: false, how: "rebase", text: `could not make a scratch copy: ${s.err}` }
    try {
      const rb = G.git(where, ["rebase", "--quiet", from], { env: { GIT_EDITOR: "true" }, timeoutMs: 120_000 })
      if (!rb.ok) {
        const files = G.git(where, ["diff", "--name-only", "--diff-filter=U"]).out
        G.git(where, ["rebase", "--abort"])
        return { ok: false, how: "rebase", conflict: true, text: `${branch} conflicts with ${d}${files ? ` in ${files.split("\n").join(", ")}` : ""}; bring the branch up to date with ${d} and say it is ready again` }
      }
      to = G.tip(where, "HEAD")!
    } finally {
      G.dropScratch(root, where)
    }
  }
  const files = G.git(root, ["diff", "--name-only", from, to]).out.split("\n").filter(Boolean)
  const shas = G.git(root, ["rev-list", `${from}..${to}`]).out.split("\n").filter(Boolean)
  const adv = G.advance(root, d, to, from)
  if (!adv.ok) return { ok: false, how: plan.how, text: adv.err! }
  let text = `merged into ${d} (${plan.why})`
  if (plan.push) {
    const p = G.push(root, facts.remote!, d)
    if (!p.ok) return { ok: false, how: plan.how, sha: to, shas, files, text: `merged into ${d} here, but the push to ${facts.remote} was refused: ${p.err}. Nothing was forced.` }
  }
  return { ok: true, how: plan.how, sha: to, shas, files, text }
}

/**
 * One file changed on the default branch, as a commit of its own: the flags
 * file. Pushed when the repo pushes directly.
 */
export function commitToDefault(root: string, file: string, content: string, message: string, o: { push?: PushMode; gh?: boolean }): { ok: boolean; sha?: string; text: string } {
  const d = G.defaultBranch(root)
  if (!d) return { ok: false, text: "no default branch to commit to" }
  const remote = G.remoteName(root)
  const mode: PushMode = o.push ?? (remote && (o.gh ?? !!G.which("gh")) ? "pr" : "local")
  if (mode !== "local" && remote) {
    const c = catchUp(root, d, remote)
    if (!c.ok) return { ok: false, text: c.err! }
  }
  const c = G.commitFile(root, d, file, content, message)
  if (!c.ok) return { ok: false, text: c.err ?? "commit failed" }
  if (mode === "pr" && remote) {
    // The default branch only moves through PRs here, so the change is one.
    const b = `crosstalk/flags-${Date.now().toString(36)}`
    if (!G.git(root, ["branch", b, c.sha!]).ok) return { ok: false, text: `could not make branch ${b}` }
    const p = G.push(root, remote, b)
    if (!p.ok) return { ok: false, sha: c.sha, text: `could not push ${b}: ${p.err}` }
    const gh = (args: string[]) => spawnSync("gh", args, { cwd: root, encoding: "utf8", timeout: 120_000 })
    const pr = gh(["pr", "create", "--head", b, "--base", d, "--title", message, "--body", "Opened by crosstalk."])
    if (pr.status !== 0) return { ok: false, sha: c.sha, text: `gh pr create failed: ${(pr.stderr ?? "").trim().split("\n").pop()}` }
    gh(["pr", "merge", b, "--auto", "--rebase"])
    return { ok: true, sha: c.sha, text: `opened ${(pr.stdout ?? "").trim().split("\n").pop()} to change it on ${d}` }
  }
  const adv = G.advance(root, d, c.sha!, c.parent!)
  if (!adv.ok) return { ok: false, text: adv.err! }
  if (mode === "direct" && remote) {
    const p = G.push(root, remote, d)
    if (!p.ok) return { ok: false, sha: c.sha, text: `committed on ${d}, but the push was refused: ${p.err}` }
    return { ok: true, sha: c.sha, text: `committed on ${d} and pushed` }
  }
  return { ok: true, sha: c.sha, text: `committed on ${d}` }
}
