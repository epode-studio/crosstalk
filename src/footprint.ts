// What a session is working on, so a message about it reaches that session.
//
// A footprint is the repo a session is in, the branch it is on, and the files
// it has touched. The daemon keeps one per local session, and a sender attaches
// a short summary of its own to every message, inside the sealed body. The
// receiving daemon delivers to the local session whose footprint overlaps most,
// and when nothing overlaps or two sessions overlap equally it asks rather than
// guessing.
//
// This is the first step of the thread design in docs/design/next-generation.md:
// threads find their sessions by files, repo and branch. There are no thread
// files yet, only the matching.

import { spawnSync } from "node:child_process"
import path from "node:path"
import type { FootprintSummary } from "./protocol.ts"

/**
 * What travels in an envelope: the normalised remote (e.g.
 * "github.com/epode-studio/crosstalk"), the branch, and repo-relative paths,
 * most recently touched first. Every field is optional, and older peers ignore it.
 */
export type Summary = FootprintSummary

/** What the daemon keeps for one local session. */
export type SessionFootprint = {
  repo?: string
  branch?: string
  /** Repo root on this machine, for turning absolute paths into relative ones. */
  root?: string
  /** Repo-relative path -> when it was last touched. */
  paths: Record<string, number>
  /** When repo and branch were last read from git. */
  gitAt?: number
}

/** Paths kept per session. Old ones fall off, since a footprint is about now. */
const MAX_PATHS = 200
/** Paths sent per message. Enough to match on, small enough not to matter. */
export const SUMMARY_PATHS = 12
/** How long a repo/branch read is trusted before git is asked again. */
const GIT_TTL_MS = 30_000

/**
 * One spelling per repository, whichever way it was cloned.
 *
 *   git@github.com:Epode-Studio/crosstalk.git  -> github.com/epode-studio/crosstalk
 *   https://user@github.com/epode-studio/crosstalk -> github.com/epode-studio/crosstalk
 *   ssh://git@github.com:22/epode-studio/crosstalk.git -> github.com/epode-studio/crosstalk
 */
export function normaliseRemote(url: string): string {
  let u = url.trim()
  if (!u) return ""
  // scp-like syntax has a colon and no scheme.
  const scp = /^(?:[^@/]+@)?([^:/]+):(?!\/)(.+)$/.exec(u)
  if (scp && !/^[a-z]+:\/\//i.test(u)) u = `${scp[1]}/${scp[2]}`
  else u = u.replace(/^[a-z+]+:\/\//i, "").replace(/^[^@/]+@/, "").replace(/^([^/:]+):\d+\//, "$1/")
  return u
    .replace(/\.git\/?$/, "")
    .replace(/\/+$/, "")
    .toLowerCase()
}

function git(cwd: string, args: string[]): string {
  try {
    const r = spawnSync("git", ["-C", cwd, ...args], { encoding: "utf8", timeout: 2000 })
    return r.status === 0 ? r.stdout.trim() : ""
  } catch {
    return ""
  }
}

/** Repo remote, branch and root for a directory, or nothing outside a repo. */
export function readGit(cwd: string): { repo?: string; branch?: string; root?: string } {
  if (!cwd) return {}
  const root = git(cwd, ["rev-parse", "--show-toplevel"])
  if (!root) return {}
  // origin when there is one, else whichever remote comes first.
  let remote = git(cwd, ["config", "--get", "remote.origin.url"])
  if (!remote) {
    const first = git(cwd, ["remote"]).split("\n")[0]
    if (first) remote = git(cwd, ["config", "--get", `remote.${first}.url`])
  }
  const branch = git(cwd, ["rev-parse", "--abbrev-ref", "HEAD"])
  return {
    repo: remote ? normaliseRemote(remote) : undefined,
    branch: branch && branch !== "HEAD" ? branch : undefined,
    root,
  }
}

/** Refresh repo and branch from git when the last read is stale. */
export function refreshGit(fp: SessionFootprint, cwd: string, now = Date.now()): SessionFootprint {
  if (fp.gitAt && now - fp.gitAt < GIT_TTL_MS) return fp
  const g = readGit(cwd)
  return { ...fp, repo: g.repo, branch: g.branch, root: g.root, gitAt: now }
}

/**
 * Paths a tool call touched, from the tool input a PostToolUse hook is given.
 * Claude Code names them file_path, notebook_path or path; Codex's apply_patch
 * puts them in the patch text. Anything else touches nothing we can name.
 */
export function pathsFromToolInput(input: unknown): string[] {
  if (!input || typeof input !== "object") return []
  const i = input as Record<string, unknown>
  const out: string[] = []
  for (const k of ["file_path", "notebook_path", "path"]) {
    const v = i[k]
    if (typeof v === "string" && v) out.push(v)
  }
  for (const k of ["command", "patch", "input"]) {
    const v = i[k]
    const text = typeof v === "string" ? v : Array.isArray(v) ? v.join("\n") : ""
    for (const m of text.matchAll(/^\*\*\* (?:Add|Update|Delete) File: (.+)$/gm)) out.push(m[1].trim())
  }
  return [...new Set(out)].slice(0, 20)
}

/** Record touched paths, made relative to the repo root so two machines agree. */
export function touch(fp: SessionFootprint, cwd: string, touched: string[], now = Date.now()): SessionFootprint {
  if (!touched.length) return fp
  const paths = { ...fp.paths }
  for (const raw of touched) {
    const abs = path.resolve(cwd || "/", raw)
    const base = fp.root ?? cwd
    const rel = base ? path.relative(base, abs) : raw
    // Outside the repo it says nothing about the repo's work.
    if (!rel || rel.startsWith("..") || path.isAbsolute(rel)) continue
    paths[rel.split(path.sep).join("/")] = now
  }
  const kept = Object.entries(paths)
    .sort((a, b) => b[1] - a[1])
    .slice(0, MAX_PATHS)
  return { ...fp, paths: Object.fromEntries(kept) }
}

export function summarise(fp: SessionFootprint | undefined, n = SUMMARY_PATHS): Summary | undefined {
  if (!fp?.repo) return undefined
  const paths = Object.entries(fp.paths)
    .sort((a, b) => b[1] - a[1])
    .slice(0, n)
    .map(([p]) => p)
  return { repo: fp.repo, ...(fp.branch ? { branch: fp.branch } : {}), ...(paths.length ? { paths } : {}) }
}

/** Accept only the shape we expect from a peer; anything else counts as absent. */
export function parseSummary(v: unknown): Summary | undefined {
  if (!v || typeof v !== "object") return undefined
  const o = v as Record<string, unknown>
  if (typeof o.repo !== "string" || !o.repo) return undefined
  return {
    repo: normaliseRemote(o.repo).slice(0, 200),
    branch: typeof o.branch === "string" && o.branch ? o.branch.slice(0, 200) : undefined,
    paths: Array.isArray(o.paths)
      ? o.paths.filter((p): p is string => typeof p === "string").slice(0, SUMMARY_PATHS * 2)
      : undefined,
  }
}

/** Weights: the repo makes a match possible, the branch outranks any file overlap. */
const BRANCH_WEIGHT = 10
const PATH_WEIGHT = 1
const MAX_PATH_SCORE = 9

/**
 * How well a local session matches a message. Zero unless the repo matches,
 * then one, plus the branch, plus shared files. A shared directory counts half
 * as much as a shared file, so neighbouring work still finds its session.
 */
export function score(local: SessionFootprint | undefined, msg: Summary): number {
  if (!local?.repo || !msg.repo || local.repo !== msg.repo) return 0
  let s = 1
  if (msg.branch && local.branch && msg.branch === local.branch) s += BRANCH_WEIGHT
  const mine = Object.keys(local.paths)
  const dirs = new Set(mine.map((p) => path.posix.dirname(p)))
  let overlap = 0
  for (const p of msg.paths ?? []) {
    if (local.paths[p] !== undefined) overlap += PATH_WEIGHT
    else if (dirs.has(path.posix.dirname(p))) overlap += PATH_WEIGHT / 2
  }
  return s + Math.min(overlap, MAX_PATH_SCORE)
}

export type Choice<T> =
  | { pick: T; score: number }
  | { pick?: undefined; why: "none" | "tie"; tied: T[] }

/** The best match, or why there is none. Ties are not broken by guessing. */
export function choose<T>(candidates: { item: T; fp?: SessionFootprint }[], msg: Summary): Choice<T> {
  const scored = candidates
    .map((c) => ({ item: c.item, s: score(c.fp, msg) }))
    .filter((c) => c.s > 0)
    .sort((a, b) => b.s - a.s)
  if (!scored.length) return { why: "none", tied: [] }
  const top = scored.filter((c) => c.s === scored[0].s)
  if (top.length > 1) return { why: "tie", tied: top.map((c) => c.item) }
  return { pick: scored[0].item, score: scored[0].s }
}

/** Bindings remember an answer, so the same question is asked once. */
export const bindingKey = (sender: string, msg: Summary) =>
  `${sender}\u0000${msg.repo ?? ""}\u0000${msg.branch ?? ""}`
