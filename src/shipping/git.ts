// The git shipping needs, out of sight: what a branch changed, a scratch copy
// of a commit, a commit of one file without touching anyone's checkout, and
// moving the default branch forward. Never a force, never a branch that is
// not the feature's own.

import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { spawn, spawnSync } from "node:child_process"
import { worktrees as listWorktrees } from "../terminal/repo.ts"
import { defaultBranch as cleanupDefault } from "../cleanup.ts"

export type R = { ok: boolean; out: string; err: string; code: number }

const env = (extra: Record<string, string> = {}) => ({
  ...process.env,
  GIT_TERMINAL_PROMPT: "0",
  GIT_SSH_COMMAND: process.env.GIT_SSH_COMMAND ?? "ssh -o BatchMode=yes -o ConnectTimeout=10",
  ...extra,
})

export function git(cwd: string, args: string[], o: { input?: string; env?: Record<string, string>; timeoutMs?: number } = {}): R {
  try {
    const r = spawnSync("git", ["-C", cwd, ...args], { encoding: "utf8", input: o.input, env: env(o.env), timeout: o.timeoutMs ?? 60_000, maxBuffer: 64 * 1024 * 1024 })
    return { ok: r.status === 0, out: (r.stdout ?? "").trim(), err: (r.stderr ?? "").trim() || (r.error ? String(r.error) : ""), code: r.status ?? -1 }
  } catch (e) {
    return { ok: false, out: "", err: String(e), code: -1 }
  }
}

/** Run a shell command with a timeout, asynchronously, so the daemon keeps answering. */
export function sh(cmd: string, cwd: string, timeoutMs: number, extraEnv: Record<string, string> = {}): Promise<{ ok: boolean; out: string; code: number | null }> {
  return new Promise((resolve) => {
    let out = ""
    let done = false
    const p = spawn("sh", ["-c", cmd], { cwd, env: env(extraEnv), stdio: ["ignore", "pipe", "pipe"], detached: true })
    const keep = (d: Buffer) => {
      out += d.toString("utf8")
      if (out.length > 200_000) out = out.slice(-100_000)
    }
    p.stdout?.on("data", keep)
    p.stderr?.on("data", keep)
    const t = setTimeout(() => {
      if (done) return
      done = true
      try {
        process.kill(-p.pid!, "SIGKILL")
      } catch {}
      resolve({ ok: false, out: out + `\n[timed out after ${Math.round(timeoutMs / 1000)}s]`, code: null })
    }, timeoutMs)
    p.on("error", (e) => {
      if (done) return
      done = true
      clearTimeout(t)
      resolve({ ok: false, out: String(e), code: null })
    })
    p.on("close", (code) => {
      if (done) return
      done = true
      clearTimeout(t)
      resolve({ ok: code === 0, out, code })
    })
  })
}

export const defaultBranch = (root: string) => cleanupDefault(root)

export const tip = (root: string, ref: string) => {
  const r = git(root, ["rev-parse", "--verify", "--quiet", `${ref}^{commit}`])
  return r.ok && r.out ? r.out : undefined
}

export const branchExists = (root: string, b: string) => !!tip(root, `refs/heads/${b}`)

export const count = (root: string, range: string) => {
  const r = git(root, ["rev-list", "--count", range])
  return r.ok ? Number(r.out) || 0 : 0
}

/** Files a branch changed since it left the default branch. */
export function changedFiles(root: string, base: string, branch: string): string[] {
  const r = git(root, ["diff", "--name-only", `${base}...${branch}`])
  return r.ok ? r.out.split("\n").filter(Boolean) : []
}

/** Whether every commit on the branch is already in base, as itself or as an equivalent patch. */
export function landed(root: string, base: string, branch: string): boolean {
  if (count(root, `${base}..${branch}`) === 0) return true
  const r = git(root, ["cherry", base, branch])
  return r.ok && !!r.out && r.out.split("\n").every((l) => l.startsWith("-"))
}

export const remoteName = (root: string) => {
  const r = git(root, ["remote"])
  if (!r.ok || !r.out) return undefined
  const all = r.out.split("\n").filter(Boolean)
  return all.includes("origin") ? "origin" : all[0]
}

export const worktrees = (root: string) => listWorktrees(root)

/** The checkout that has this branch, if any. */
export const checkoutOf = (root: string, branch: string) => worktrees(root).find((w) => w.branch === branch && !w.bare)

/** The main checkout of the repository a folder is in. */
export const mainOf = (cwd: string) => worktrees(cwd)[0]?.path

export function isClean(dir: string): boolean {
  const r = git(dir, ["status", "--porcelain", "--untracked-files=no"])
  return r.ok && !r.out
}

/** A detached scratch copy of a commit, for a reviewer or a check. */
export function scratch(root: string, at: string, where: string): { ok: boolean; err?: string } {
  fs.mkdirSync(path.dirname(where), { recursive: true })
  if (fs.existsSync(where)) dropScratch(root, where)
  const r = git(root, ["worktree", "add", "--detach", "--quiet", where, at])
  return r.ok ? { ok: true } : { ok: false, err: r.err.split("\n").pop() }
}

export function dropScratch(root: string, where: string) {
  for (const l of ["node_modules", ".venv", "venv"])
    try {
      if (fs.lstatSync(path.join(where, l)).isSymbolicLink()) fs.unlinkSync(path.join(where, l))
    } catch {}
  git(root, ["worktree", "remove", "--force", where])
  try {
    fs.rmSync(where, { recursive: true, force: true })
  } catch {}
  git(root, ["worktree", "prune"])
}

/** Dependencies are shared, not copied: the main checkout's, linked in. */
export function linkDeps(main: string, where: string): string[] {
  const out: string[] = []
  for (const d of ["node_modules", ".venv", "venv"]) {
    const from = path.join(main, d)
    const to = path.join(where, d)
    try {
      if (fs.existsSync(from) && !fs.existsSync(to)) {
        fs.symlinkSync(from, to, "dir")
        out.push(d)
      }
    } catch {}
  }
  return out
}

/** A file's content at a commit, or undefined. */
export function show(root: string, ref: string, file: string): string | undefined {
  const r = spawnSync("git", ["-C", root, "show", `${ref}:${file}`], { encoding: "utf8", env: env(), timeout: 10_000 })
  return r.status === 0 ? r.stdout : undefined
}

const WHO = {
  GIT_AUTHOR_NAME: process.env.CROSSTALK_GIT_NAME ?? "crosstalk",
  GIT_AUTHOR_EMAIL: process.env.CROSSTALK_GIT_EMAIL ?? "crosstalk@localhost",
  GIT_COMMITTER_NAME: process.env.CROSSTALK_GIT_NAME ?? "crosstalk",
  GIT_COMMITTER_EMAIL: process.env.CROSSTALK_GIT_EMAIL ?? "crosstalk@localhost",
}

/**
 * A commit of one file on top of a branch, made with a private index so no
 * checkout or index of anyone's is touched. The branch does not move here;
 * advance() does that.
 */
export function commitFile(root: string, branch: string, file: string, content: string, message: string): { ok: boolean; sha?: string; parent?: string; err?: string } {
  const parent = tip(root, `refs/heads/${branch}`)
  if (!parent) return { ok: false, err: `no branch ${branch}` }
  const idx = path.join(os.tmpdir(), `crosstalk-index-${process.pid}-${Date.now()}`)
  const e = { GIT_INDEX_FILE: idx }
  try {
    if (!git(root, ["read-tree", parent], { env: e }).ok) return { ok: false, err: "read-tree failed" }
    const blob = git(root, ["hash-object", "-w", "--stdin"], { input: content })
    if (!blob.ok) return { ok: false, err: blob.err }
    if (!git(root, ["update-index", "--add", "--cacheinfo", `100644,${blob.out},${file}`], { env: e }).ok) return { ok: false, err: "update-index failed" }
    const tree = git(root, ["write-tree"], { env: e })
    if (!tree.ok) return { ok: false, err: tree.err }
    const c = git(root, ["commit-tree", tree.out, "-p", parent, "-m", message], { env: WHO })
    return c.ok ? { ok: true, sha: c.out, parent } : { ok: false, err: c.err }
  } finally {
    try {
      fs.unlinkSync(idx)
    } catch {}
  }
}

/**
 * Move a branch forward to a commit that descends from where it is. A checkout
 * that has it is fast-forwarded (git refuses if that would overwrite someone's
 * uncommitted changes); otherwise the ref moves only if nobody moved it since.
 */
export function advance(root: string, branch: string, to: string, from: string): { ok: boolean; err?: string } {
  if (!git(root, ["merge-base", "--is-ancestor", from, to]).ok) return { ok: false, err: `${branch} moved meanwhile` }
  const w = checkoutOf(root, branch)
  if (w) {
    const r = git(w.path, ["merge", "--ff-only", "--quiet", to])
    return r.ok ? { ok: true } : { ok: false, err: `the checkout of ${branch} at ${w.path} could not move forward: ${r.err.split("\n").pop()}` }
  }
  const r = git(root, ["update-ref", "-m", "crosstalk: ship", `refs/heads/${branch}`, to, from])
  return r.ok ? { ok: true } : { ok: false, err: r.err }
}

/** Push one branch, never forced. */
export function push(root: string, remote: string, branch: string): { ok: boolean; err?: string } {
  const r = git(root, ["push", "--quiet", remote, `refs/heads/${branch}:refs/heads/${branch}`], { timeoutMs: 120_000 })
  return r.ok ? { ok: true } : { ok: false, err: r.err.split("\n").slice(-2).join(" ") }
}

export function which(bin: string, envVars: NodeJS.ProcessEnv = process.env): string | undefined {
  for (const d of (envVars.PATH ?? "").split(path.delimiter)) {
    if (!d) continue
    const p = path.join(d, bin)
    try {
      fs.accessSync(p, fs.constants.X_OK)
      if (fs.statSync(p).isFile()) return p
    } catch {}
  }
  return undefined
}
