// Which threads a session belongs to, found from what it is working on.
//
// No model, no tokens: the repo, the branch and the files a session touched
// (src/footprint.ts) are enough to place nearly every session.
//
//   on a work branch    the thread for that branch; a branch nobody has a
//                       thread for starts one, named after the branch
//   on the default      the thread whose files it touches; a cluster of files
//   branch              no thread covers starts one, named after their folder;
//                       touching two threads' files equally is a question
//
// The default branch is the exception to "same repo and branch, same thread".
// Everyone in a repo is on main some of the time, and main is not a piece of
// work, so there the files decide.
//
// The same overlap rules decide when a peer's session belongs in one of our
// threads (threads find their people) and when two threads have turned out to
// be one piece of work (combine).

import path from "node:path"

export type Footprint = {
  repo?: string
  branch?: string
  /** Repo-relative paths, most recent first. */
  paths: string[]
  /** True when `branch` is the repo's default branch. */
  onDefault?: boolean
}

export type ThreadLite = {
  id: string
  name: string
  repo: string
  live: boolean
  branches: string[]
  files: string[]
  createdAt: number
  combinedInto?: string
}

/** Branch names that are never a piece of work, when git cannot say which is the default. */
const DEFAULTS = new Set(["main", "master", "trunk", "develop", "development", "default", "dev"])

export const isDefaultBranch = (branch: string | undefined, remoteDefault?: string) =>
  !branch || branch === remoteDefault || (!remoteDefault && DEFAULTS.has(branch))

/** The files it takes on the default branch, outside every thread, to start one. */
export const MIN_CLUSTER = 3

/**
 * A thread's name from its branch: the last part that says something, so
 * `feature/auth-tokens`, `paul/auth-tokens` and `auth-tokens` all read
 * `auth-tokens`. A generated suffix (claude/laughing-goldberg-dw38w3) is kept,
 * since it is all there is.
 */
export function nameFromBranch(branch: string): string {
  const parts = branch.split("/").filter(Boolean)
  const last = parts[parts.length - 1] ?? branch
  return (
    last
      .toLowerCase()
      .replace(/^(feat|feature|fix|bugfix|hotfix|chore|wip)[-_]/, "")
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 40) || "thread"
  )
}

/** `src/auth/**` covers everything under src/auth; anything else is one file. */
export function covers(pattern: string, file: string): boolean {
  if (pattern.endsWith("/**")) return file.startsWith(pattern.slice(0, -2))
  return pattern === file
}

/** How many of `paths` a thread's files cover. */
export const overlap = (patterns: string[], paths: string[]) => paths.filter((p) => patterns.some((q) => covers(q, p))).length

/**
 * Files every piece of work touches now and then (the repo's root files, lockfiles): they say nothing
 * about which work a session is on, so they never place it in a thread.
 */
export const telling = (p: string) => p.includes("/") && !/(^|\/)(package-lock\.json|yarn\.lock|pnpm-lock\.yaml|bun\.lockb?|Cargo\.lock|go\.sum|poetry\.lock|Gemfile\.lock)$/.test(p)

/**
 * Whether two sets of files are about the same work: at least two in common,
 * and at least half of the smaller set. One shared file (a lockfile, a config)
 * is a coincidence, not a thread.
 */
export function filesConverge(a: string[], b: string[]): string[] | null {
  if (!a.length || !b.length) return null
  const shared = new Set<string>()
  // Two folder patterns that are the same folder are the same work.
  for (const x of a) if (x.endsWith("/**") ? b.includes(x) : b.some((q) => covers(q, x))) shared.add(x)
  for (const x of b) if (!x.endsWith("/**") && a.some((q) => covers(q, x))) shared.add(x)
  const out = [...shared].sort()
  if (out.some((x) => x.endsWith("/**"))) return out
  return out.length >= 2 && out.length * 2 >= Math.min(a.length, b.length) ? out : null
}

/** A folder holding at least MIN_CLUSTER of these paths, deepest first, none of them covered already. */
export function cluster(paths: string[], claimed: string[], min = MIN_CLUSTER): { dir: string; files: string[] } | null {
  const free = paths.filter((p) => !claimed.some((q) => covers(q, p)))
  if (free.length < min) return null
  const byDir = new Map<string, string[]>()
  for (const p of free) {
    // A file at the repo root says nothing about which work it is.
    let d = path.posix.dirname(p)
    while (d && d !== ".") {
      ;(byDir.get(d) ?? byDir.set(d, []).get(d)!).push(p)
      d = path.posix.dirname(d)
    }
  }
  const best = [...byDir.entries()]
    .filter(([, fs]) => fs.length >= min)
    .sort((a, b) => b[0].split("/").length - a[0].split("/").length || b[1].length - a[1].length)[0]
  return best ? { dir: best[0], files: best[1] } : null
}

/** A folder's name for a thread: `src/auth` reads `auth`. */
export const nameFromDir = (dir: string) => nameFromBranch(path.posix.basename(dir))

export type Placement =
  | { kind: "none"; why: string }
  | { kind: "join"; threads: { id: string; why: string }[] }
  | { kind: "create"; name: string; branch?: string; files: string[]; why: string }
  | { kind: "ask"; candidates: string[]; why: string }

/** Where a session goes, from its footprint and the threads this machine knows. */
export function place(fp: Footprint, threads: ThreadLite[], min = MIN_CLUSTER): Placement {
  if (!fp.repo) return { kind: "none", why: "not in a git repo with a remote" }
  const here = threads.filter((t) => t.repo === fp.repo && !t.combinedInto)
  if (fp.branch && !fp.onDefault) {
    const same = here.filter((t) => t.branches.includes(fp.branch!))
    if (same.length)
      return { kind: "join", threads: same.map((t) => ({ id: t.id, why: `same branch ${fp.branch}` })) }
    const taken = new Set(here.filter((t) => t.live).map((t) => t.name))
    let name = nameFromBranch(fp.branch)
    for (let i = 2; taken.has(name); i++) name = `${nameFromBranch(fp.branch)}-${i}`
    return { kind: "create", name, branch: fp.branch, files: [], why: `new branch ${fp.branch}` }
  }
  if (!fp.paths.length) return { kind: "none", why: "on the default branch and nothing touched yet" }
  const scored = here
    .map((t) => ({ t, n: overlap(t.files, fp.paths.filter(telling)) }))
    .filter((s) => s.n > 0)
    .sort((a, b) => b.n - a.n)
  if (scored.length) {
    const top = scored.filter((s) => s.n === scored[0].n)
    if (top.length > 1)
      return { kind: "ask", candidates: top.map((s) => s.t.id), why: `touches ${top.map((s) => s.t.name).join(" and ")} equally` }
    const t = scored[0].t
    return { kind: "join", threads: [{ id: t.id, why: `touches ${t.name}'s files` }] }
  }
  const c = cluster(fp.paths, here.flatMap((t) => t.files), min)
  if (!c) return { kind: "none", why: "on the default branch, no thread's files touched yet" }
  const taken = new Set(here.filter((t) => t.live).map((t) => t.name))
  let name = nameFromDir(c.dir)
  for (let i = 2; taken.has(name); i++) name = `${nameFromDir(c.dir)}-${i}`
  return { kind: "create", name, files: [`${c.dir}/**`], why: `new files in ${c.dir}` }
}

/** Whether a peer's session is working on this thread, and why. Same repo, then branch or files. */
export function matchesPeer(t: ThreadLite, fp: Footprint): string | null {
  if (!t.live || t.combinedInto || !fp.repo || fp.repo !== t.repo) return null
  if (fp.branch && !fp.onDefault && t.branches.includes(fp.branch)) return `same branch ${fp.branch}`
  const files = filesConverge(t.files, fp.paths)
  return files ? `same files (${files.slice(0, 3).join(", ")})` : null
}

/** Whether two threads turned out to be one piece of work, and why. */
export function converge(a: ThreadLite, b: ThreadLite): string | null {
  if (a.id === b.id || a.repo !== b.repo || !a.live || !b.live || a.combinedInto || b.combinedInto) return null
  const branch = a.branches.find((x) => b.branches.includes(x))
  if (branch) return `both on branch ${branch}`
  const files = filesConverge(a.files, b.files)
  return files ? `both touch ${files.slice(0, 3).join(", ")}` : null
}

/** Which of two threads survives a combine: the older, then the lower id. Every replica picks the same. */
export const survivor = <T extends { id: string; createdAt: number }>(a: T, b: T): [T, T] =>
  a.createdAt !== b.createdAt ? (a.createdAt < b.createdAt ? [a, b] : [b, a]) : a.id < b.id ? [a, b] : [b, a]
