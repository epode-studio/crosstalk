// Which local files a new worktree should get from the main checkout
// (docs/urls.md, "Servers that just start"): the gitignored env and secret
// files a dev server needs to start at all.
//
//   .env, .env.*        anywhere in the repo, except .env.example / .env.sample
//                       (and *.example, *.sample), which are tracked anyway
//   .dev.vars           anywhere (Cloudflare's wrangler)
//   config/*.local.*    from the top of the repo
//   .crosstalk/env      more patterns, one per line, from the repository itself:
//                       gitignore-like (`*`, `**`, `?`; a pattern with a slash
//                       is from the top, one without matches a name anywhere;
//                       `!pattern` leaves matches out; `#` comments)
//
// Only files git ignores in the main checkout (`git check-ignore`) and does not
// track, regular files only: a symlink is refused, never followed, and the walk
// never goes through a symlinked folder, so nothing outside the repository is
// ever read. Nested repositories and worktrees, dependency folders and build
// output are not walked.

import fs from "node:fs"
import path from "node:path"
import { spawnSync } from "node:child_process"

export const DEFAULT_PATTERNS = [".env", ".env.*", ".dev.vars", "config/*.local.*"]
export const REPO_FILE = ".crosstalk/env"
/** Never copied, whatever a pattern says: templates are tracked anyway. */
export const EXAMPLE = /(^|\.)(example|sample|template|dist)(\.|$)/i
export const MAX_BYTES = 1024 * 1024
export const MAX_FILES = 50
const SKIP_DIRS = new Set([".git", "node_modules", ".venv", "venv", "__pycache__", ".next", ".nuxt", ".svelte-kit", ".turbo", ".cache", "dist", "build", "out", "target", "coverage", ".gradle", ".idea", ".vscode", "vendor", "Pods", "worktrees"])
const MAX_ENTRIES = 40_000
const MAX_DEPTH = 8

export type Patterns = { include: RegExp[]; exclude: RegExp[]; refused: string[] }

/** A gitignore-like pattern as a regular expression over a path from the repo's top. */
export function globToRe(pattern: string): RegExp | null {
  let p = pattern.trim()
  if (!p || p.includes("\0")) return null
  if (p.split("/").some((part) => part === ".." || part === ".")) return null
  const anchored = p.startsWith("/") || p.replace(/\/$/, "").includes("/")
  p = p.replace(/^\/+/, "").replace(/\/+$/, "")
  if (!p) return null
  let re = ""
  for (let i = 0; i < p.length; i++) {
    const c = p[i]
    if (c === "*" && p[i + 1] === "*") {
      // `**/` is any number of folders, `**` anything.
      if (p[i + 2] === "/") {
        re += "(?:.*/)?"
        i += 2
      } else {
        re += ".*"
        i += 1
      }
    } else if (c === "*") re += "[^/]*"
    else if (c === "?") re += "[^/]"
    else re += c.replace(/[.+^${}()|[\]\\]/g, "\\$&")
  }
  return new RegExp(anchored ? `^${re}$` : `(^|/)${re}$`)
}

/** The default patterns and the repository's own `.crosstalk/env`. */
export function patterns(extra = ""): Patterns {
  const out: Patterns = { include: [], exclude: [], refused: [] }
  for (const p of DEFAULT_PATTERNS) out.include.push(globToRe(p)!)
  for (const raw of extra.split("\n").slice(0, 200)) {
    const l = raw.trim()
    if (!l || l.startsWith("#")) continue
    const neg = l.startsWith("!")
    const re = globToRe(neg ? l.slice(1) : l)
    if (!re) {
      out.refused.push(l)
      continue
    }
    ;(neg ? out.exclude : out.include).push(re)
  }
  return out
}

export function readRepoPatterns(main: string): string {
  const f = path.join(main, REPO_FILE)
  try {
    const st = fs.lstatSync(f)
    if (!st.isFile() || st.size > 64 * 1024) return ""
    return fs.readFileSync(f, "utf8")
  } catch {
    return ""
  }
}

export const matches = (rel: string, p: Patterns) => !EXAMPLE.test(path.basename(rel)) && p.include.some((r) => r.test(rel)) && !p.exclude.some((r) => r.test(rel))

/** Every path under `top` that matches, without following a symlinked folder or entering another repository. */
export function walk(top: string, p: Patterns): string[] {
  const out: string[] = []
  let seen = 0
  const go = (dir: string, rel: string, depth: number) => {
    if (depth > MAX_DEPTH || seen > MAX_ENTRIES) return
    let ents: fs.Dirent[]
    try {
      ents = fs.readdirSync(dir, { withFileTypes: true })
    } catch {
      return
    }
    for (const e of ents) {
      if (++seen > MAX_ENTRIES) return
      const r = rel ? `${rel}/${e.name}` : e.name
      if (e.isDirectory()) {
        if (SKIP_DIRS.has(e.name)) continue
        // Another repository or a worktree (its own .git): not this checkout's files.
        if (fs.existsSync(path.join(dir, e.name, ".git"))) continue
        go(path.join(dir, e.name), r, depth + 1)
      } else if ((e.isFile() || e.isSymbolicLink()) && matches(r, p)) out.push(r)
    }
  }
  go(top, "", 0)
  return out.sort()
}

export type Git = (cwd: string, args: string[], input?: string) => { ok: boolean; out: string }

export const git: Git = (cwd, args, input) => {
  const r = spawnSync("git", ["-C", cwd, ...args], { input, encoding: "utf8", timeout: 15_000, maxBuffer: 8 * 1024 * 1024 })
  return { ok: r.status === 0 || (args[0] === "check-ignore" && r.status === 1), out: r.stdout ?? "" }
}

/** Of these paths, the ones git ignores there and does not track. */
export function ignored(top: string, rels: string[], g: Git = git): Set<string> {
  if (!rels.length) return new Set()
  const r = g(top, ["check-ignore", "-z", "--stdin"], rels.join("\0") + "\0")
  // One bad path (beyond a symlink, say) fails them all: then one at a time.
  if (!r.ok) return rels.length > 1 ? new Set(rels.filter((x) => ignored(top, [x], g).has(x))) : new Set()
  const ign = new Set(r.out.split("\0").filter(Boolean))
  if (!ign.size) return ign
  const tracked = g(top, ["ls-files", "-z", "--", ...[...ign].map((x) => `:(literal)${x}`)])
  if (tracked.ok) for (const t of tracked.out.split("\0")) ign.delete(t)
  return ign
}

export type Candidate = { rel: string; mode: number; size: number }
export type Selection = { files: Candidate[]; refused: { rel: string; why: string }[]; patternsRefused: string[] }

/** What the main checkout has to give a new worktree. Names only: nothing here reads a file's contents. */
export function select(main: string, g: Git = git): Selection {
  const p = patterns(readRepoPatterns(main))
  const found = walk(main, p)
  const ign = ignored(main, found, g)
  const out: Selection = { files: [], refused: [], patternsRefused: p.refused }
  let realMain = main
  try {
    realMain = fs.realpathSync(main)
  } catch {}
  for (const rel of found) {
    if (!ign.has(rel)) continue
    const abs = path.join(main, rel)
    let st: fs.Stats
    try {
      st = fs.lstatSync(abs)
    } catch {
      continue
    }
    if (st.isSymbolicLink()) {
      out.refused.push({ rel, why: "a symlink (never followed)" })
      continue
    }
    if (!st.isFile()) continue
    if (st.size > MAX_BYTES) {
      out.refused.push({ rel, why: "larger than 1 MB" })
      continue
    }
    try {
      const real = fs.realpathSync(abs)
      if (!real.startsWith(realMain + path.sep)) {
        out.refused.push({ rel, why: "outside the repository" })
        continue
      }
    } catch {
      continue
    }
    out.files.push({ rel, mode: st.mode & 0o7777, size: st.size })
    if (out.files.length >= MAX_FILES) break
  }
  return out
}
