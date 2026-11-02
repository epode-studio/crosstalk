// Which repository a folder belongs to, the way a person thinks of it: every
// worktree of one repository is the same repository, so a spawned agent's
// worktree goes in the same window as the checkout it came from.
//
// Nothing here imports the rest of crosstalk, so restore, layout, spawn and
// cleanup can all use it without a cycle.

import { spawnSync } from "node:child_process"
import path from "node:path"

export type Git = (cwd: string, args: string[]) => { ok: boolean; out: string }

export const git: Git = (cwd, args) => {
  try {
    const r = spawnSync("git", ["-C", cwd, ...args], { encoding: "utf8", timeout: 10_000, env: { ...process.env, GIT_TERMINAL_PROMPT: "0" } })
    return { ok: r.status === 0, out: (r.stdout ?? "").trim() || (r.status === 0 ? "" : (r.stderr ?? "").trim()) }
  } catch (e) {
    return { ok: false, out: String(e) }
  }
}

export type Worktree = { path: string; head?: string; branch?: string; bare?: boolean; detached?: boolean }

/** `git worktree list --porcelain`, parsed. The first entry is the main checkout. */
export function parseWorktrees(porcelain: string): Worktree[] {
  const out: Worktree[] = []
  let cur: Worktree | null = null
  for (const line of porcelain.split("\n")) {
    if (line.startsWith("worktree ")) {
      cur = { path: line.slice(9) }
      out.push(cur)
    } else if (!cur) continue
    else if (line.startsWith("HEAD ")) cur.head = line.slice(5)
    else if (line.startsWith("branch ")) cur.branch = line.slice(7).replace(/^refs\/heads\//, "")
    else if (line === "bare") cur.bare = true
    else if (line === "detached") cur.detached = true
  }
  return out
}

export function worktrees(cwd: string, g: Git = git): Worktree[] {
  const r = g(cwd, ["worktree", "list", "--porcelain"])
  return r.ok ? parseWorktrees(r.out) : []
}

const cache = new Map<string, string | null>()

/**
 * The repository's main checkout, which names it: the same for every worktree
 * of it. Null outside git. Cached for the life of the process.
 */
export function repoOf(cwd: string, g: Git = git): string | null {
  if (!cwd) return null
  if (cache.has(cwd)) return cache.get(cwd)!
  let key: string | null = null
  const main = worktrees(cwd, g)[0]
  if (main && !main.bare) key = main.path
  else {
    const top = g(cwd, ["rev-parse", "--show-toplevel"])
    if (top.ok && top.out) key = top.out
  }
  cache.set(cwd, key)
  return key
}

/** Records compare by repository; a folder outside git is its own. */
export const repoKey = (cwd: string, g: Git = git) => repoOf(cwd, g) ?? path.resolve(cwd)

/** A repository's short name, for branches, folders and tmux sessions. */
export const repoName = (root: string) => slug(path.basename(root)) || "repo"

export function slug(s: string, max = 32): string {
  return s
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, max)
    .replace(/-+$/g, "")
}
