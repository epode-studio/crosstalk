// Threads across repos: a library's thread tells the repos that depend on it.
//
// When repo A depends on repo B and a session in one of B's threads edits a
// file on B's public surface, every live thread of A hears about it: a
// heads-up with the diff attached as a slice, delivered the way src/warn does
// it (a held message for A's local sessions, a sealed `heads-up` envelope to
// A's people). Only people who are already trusted get it: A's threads only
// ever hold people this machine shares a direct channel with (rooms or repo
// trust), and the envelope goes to direct peers only.
//
// A depends on B when A's own files say so:
//
//   package.json      a dependency whose spec is a git or GitHub URL
//                     (github:o/r, git+https://…, o/r), or a file:/link: path,
//                     or a workspace folder outside the repo
//   go.mod            a require of a module on a known forge, or a replace
//                     pointing at a local folder
//   Cargo.toml        git = "…" or path = "…" in a dependency
//   pyproject.toml    name @ git+https://… or git = "…" / path = "…"
//   .crosstalk/depends  one repo per line: a URL, host/owner/repo, or a path
//
// A path is followed to the clone it names and read as that clone's remote.
// B's public surface is the files .crosstalk/surface lists (globs), plus what
// the package says it exports: package.json main/module/types/bin/exports
// (and the src/ file a dist/ entry is built from), a Go package's non-test
// files outside internal/, Rust's src/lib.rs, a Python package's __init__.py.
//
// Found on the machine that has both clones: the one where a person works on
// the library and on something that uses it, which is exactly where nobody
// remembers to say "I changed the API". Rate limited per (file, thread).

import fs from "node:fs"
import path from "node:path"
import { spawnSync } from "node:child_process"
import { normaliseRemote } from "../footprint.ts"
import * as M from "./model.ts"
import { Gate, type Clock } from "../warn/gate.ts"

export type Dep = { repo: string; via: string }

const FORGES = /^(github\.com|gitlab\.com|bitbucket\.org|codeberg\.org)\//

function remoteOf(dir: string): string | undefined {
  try {
    const r = spawnSync("git", ["-C", dir, "remote", "get-url", "origin"], { encoding: "utf8", timeout: 3000 })
    if (r.status === 0 && r.stdout.trim()) return normaliseRemote(r.stdout.trim())
    const any = spawnSync("git", ["-C", dir, "remote"], { encoding: "utf8", timeout: 3000 })
    const first = (any.stdout ?? "").split("\n").find(Boolean)
    if (!first) return undefined
    const u = spawnSync("git", ["-C", dir, "remote", "get-url", first], { encoding: "utf8", timeout: 3000 })
    return u.status === 0 && u.stdout.trim() ? normaliseRemote(u.stdout.trim()) : undefined
  } catch {
    return undefined
  }
}

/** A dependency spec that names a repository, as host/owner/repo. */
export function repoFromSpec(spec: string): string | undefined {
  let s = spec.trim().replace(/#.*$/, "")
  if (!s) return undefined
  const short = /^(github|gitlab|bitbucket):(.+)$/.exec(s)
  if (short) return `${short[1] === "bitbucket" ? "bitbucket.org" : `${short[1]}.com`}/${short[2]}`.replace(/\.git$/, "").toLowerCase()
  // pip's `git+https://…/r.git@main`: the ref is not part of the repo.
  s = s.replace(/^git\+/, "").replace(/(\.git)?@[^/@:]+$/, "")
  if (/^(https?|ssh|git):\/\//i.test(s) || /^[^@/\s]+@[^:]+:/.test(s)) {
    const n = normaliseRemote(s)
    const m = /^([^/]+\/[^/]+\/[^/]+)/.exec(n)
    return m ? m[1] : n
  }
  // npm's owner/repo shorthand for GitHub; not a scope, not a path, not a version.
  if (/^[A-Za-z0-9][\w.-]*\/[\w.-]+$/.test(s) && !s.startsWith(".")) return `github.com/${s}`.toLowerCase()
  if (FORGES.test(s.toLowerCase())) return s.toLowerCase().split("/").slice(0, 3).join("/")
  return undefined
}

const readText = (f: string) => {
  try {
    return fs.readFileSync(f, "utf8")
  } catch {
    return undefined
  }
}

/** Every repo `root` depends on, by host/owner/repo. Its own repo is never one. */
export function dependencies(root: string, o: { remoteOf?: (dir: string) => string | undefined } = {}): Dep[] {
  const rem = o.remoteOf ?? remoteOf
  const out = new Map<string, Dep>()
  const self = rem(root)
  const add = (repo: string | undefined, via: string) => {
    if (!repo || repo === self || out.has(repo)) return
    out.set(repo, { repo, via })
  }
  const addPath = (p: string, via: string) => {
    const abs = path.resolve(root, p)
    if (!fs.existsSync(abs)) return
    add(rem(abs), via)
  }

  const pkgText = readText(path.join(root, "package.json"))
  if (pkgText) {
    try {
      const pkg = JSON.parse(pkgText)
      for (const field of ["dependencies", "devDependencies", "peerDependencies", "optionalDependencies"])
        for (const [name, spec] of Object.entries(pkg?.[field] ?? {})) {
          if (typeof spec !== "string") continue
          const m = /^(file|link|portal):(.+)$/.exec(spec)
          if (m) addPath(m[2], `package.json ${name}`)
          else add(repoFromSpec(spec), `package.json ${name}`)
        }
      const ws = Array.isArray(pkg?.workspaces) ? pkg.workspaces : Array.isArray(pkg?.workspaces?.packages) ? pkg.workspaces.packages : []
      for (const w of ws) if (typeof w === "string" && w.startsWith("..") && !w.includes("*")) addPath(w, `package.json workspace ${w}`)
    } catch {}
  }

  const gomod = readText(path.join(root, "go.mod"))
  if (gomod) {
    for (const m of gomod.matchAll(/^\s*(?:require\s+)?([a-z0-9.-]+\.[a-z]+\/[^\s]+)\s+v[0-9][^\s]*/gim)) {
      const mod = m[1].toLowerCase()
      if (FORGES.test(mod)) add(mod.split("/").slice(0, 3).join("/"), `go.mod ${m[1]}`)
    }
    for (const m of gomod.matchAll(/=>\s*(\.{1,2}\/[^\s]+)/g)) addPath(m[1], `go.mod replace ${m[1]}`)
  }

  for (const toml of ["Cargo.toml", "pyproject.toml"]) {
    const t = readText(path.join(root, toml))
    if (!t) continue
    for (const m of t.matchAll(/\bgit\s*=\s*"([^"]+)"/g)) add(repoFromSpec(m[1]), `${toml} git ${m[1]}`)
    for (const m of t.matchAll(/\bpath\s*=\s*"([^"]+)"/g)) addPath(m[1], `${toml} path ${m[1]}`)
    for (const m of t.matchAll(/@\s*(git\+[^\s"',\]]+)/g)) add(repoFromSpec(m[1]), `${toml} ${m[1]}`)
  }

  const listed = readText(path.join(root, ".crosstalk", "depends"))
  if (listed)
    for (const raw of listed.split("\n")) {
      const line = raw.replace(/(^|\s)#.*$/, "").trim()
      if (!line) continue
      if (line.startsWith(".") || line.startsWith("/") || line.startsWith("~")) addPath(line.replace(/^~/, process.env.HOME ?? "~"), `.crosstalk/depends`)
      else add(repoFromSpec(line) ?? normaliseRemote(line), `.crosstalk/depends`)
    }
  return [...out.values()]
}

// --- the public surface ------------------------------------------------------------

export function globToRegex(g: string): RegExp {
  let p = g.trim().replace(/^\.\//, "").replace(/^\//, "")
  if (p.endsWith("/")) p += "**"
  let re = ""
  for (let i = 0; i < p.length; i++) {
    const c = p[i]
    if (c === "*" && p[i + 1] === "*") {
      re += ".*"
      i++
      if (p[i + 1] === "/") i++
    } else if (c === "*") re += "[^/]*"
    else if (c === "?") re += "[^/]"
    else re += c.replace(/[.+^${}()|[\]\\]/g, "\\$&")
  }
  return new RegExp(`^${re}$`)
}

function exportedPaths(v: unknown, out: string[] = []): string[] {
  if (typeof v === "string") out.push(v)
  else if (v && typeof v === "object") for (const x of Object.values(v)) exportedPaths(x, out)
  return out
}

/** Whether a repo-relative file is part of the repo's public surface. */
export function surface(root: string): (file: string) => boolean {
  const exact = new Set<string>()
  const globs: RegExp[] = []
  const listed = readText(path.join(root, ".crosstalk", "surface"))
  if (listed)
    for (const raw of listed.split("\n")) {
      const line = raw.replace(/(^|\s)#.*$/, "").trim()
      if (line) globs.push(globToRegex(line))
    }
  const pkgText = readText(path.join(root, "package.json"))
  if (pkgText)
    try {
      const pkg = JSON.parse(pkgText)
      const entries = [pkg.main, pkg.module, pkg.types, pkg.typings, typeof pkg.browser === "string" ? pkg.browser : undefined, ...exportedPaths(pkg.bin), ...exportedPaths(pkg.exports)].filter(
        (x): x is string => typeof x === "string",
      )
      for (const e of entries) {
        const f = e.replace(/^\.\//, "")
        if (f.includes("*")) globs.push(globToRegex(f))
        else exact.add(f)
        // A built entry point comes from its source.
        const built = /^(dist|lib|build|out)\/(.+?)(\.d)?\.(c|m)?(js|ts)$/.exec(f)
        if (built) globs.push(globToRegex(`src/${built[2]}.*`))
      }
      if (!entries.length) exact.add("index.js")
    } catch {}
  const isGo = fs.existsSync(path.join(root, "go.mod"))
  const isRust = fs.existsSync(path.join(root, "Cargo.toml"))
  const isPy = fs.existsSync(path.join(root, "pyproject.toml")) || fs.existsSync(path.join(root, "setup.py"))
  return (file: string) => {
    const f = file.replace(/^\.\//, "")
    if (exact.has(f) || globs.some((g) => g.test(f))) return true
    if (isGo && f.endsWith(".go") && !f.endsWith("_test.go") && !/(^|\/)(internal|cmd|testdata|examples?)\//.test(f)) return true
    if (isRust && f === "src/lib.rs") return true
    if (isPy && /(^|\/)__init__\.py$/.test(f) && !/(^|\/)tests?\//.test(f)) return true
    return false
  }
}

// --- the heads-up ---------------------------------------------------------------------

export type CrossDeps = {
  me: string
  label: string
  threads: {
    all(): M.Thread[]
    idsFor(sessionId: string): string[]
    thread(id: string): M.Thread | undefined
    sessionsIn(ids: string[]): string[]
    roots(): Record<string, string>
  }
  peers: () => Record<string, { label: string; fingerprint: string }>
  relay: (o: { thread: string; local: string[]; labels: string[]; text: string; diff: { label: string; content: string }; warn: Record<string, unknown>; fromSession: string }) => void
  log: (...a: unknown[]) => void
  rateMs?: number
  clock?: Clock
  /** How long a repo's dependencies are cached. */
  cacheMs?: number
  remoteOf?: (dir: string) => string | undefined
}

type Batch = { from: { sessionId: string; name: string; repo: string; threads: string[] }; dependent: { repo: string; via: string; thread: string }; file: string; diff: string }

const short = (repo: string) => repo.split("/").slice(-2).join("/") || repo

export class CrossRepo {
  private gate: Gate<Batch>
  private depCache = new Map<string, { at: number; deps: Dep[] }>()

  constructor(private d: CrossDeps) {
    this.gate = new Gate<Batch>(d.rateMs ?? Number(process.env.CROSSTALK_CROSSREPO_RATE_MS ?? 10 * 60_000), (_k, items) => this.send(items), d.clock)
  }

  private deps(root: string): Dep[] {
    const c = this.depCache.get(root)
    const now = Date.now()
    if (c && now - c.at < (this.d.cacheMs ?? 10 * 60_000)) return c.deps
    const deps = dependencies(root, { remoteOf: this.d.remoteOf })
    this.depCache.set(root, { at: now, deps })
    return deps
  }

  /** Repos this machine has a clone of that depend on `repo`, and how. */
  dependents(repo: string): { repo: string; via: string }[] {
    const out: { repo: string; via: string }[] = []
    for (const [r, root] of Object.entries(this.d.threads.roots())) {
      if (r === repo || !fs.existsSync(root)) continue
      const dep = this.deps(root).find((x) => x.repo === repo)
      if (dep) out.push({ repo: r, via: dep.via })
    }
    return out
  }

  /** A local session in one of `repo`'s threads edited `file`. Returns the dependent threads told. */
  edited(o: { sessionId: string; name: string; repo: string; root?: string; file: string; diff: string }): string[] {
    const mine = this.d.threads.idsFor(o.sessionId)
    if (!mine.length || !o.root || !fs.existsSync(o.root)) return []
    if (!surface(o.root)(o.file)) return []
    const told: string[] = []
    for (const dep of this.dependents(o.repo))
      for (const t of this.d.threads.all()) {
        if (t.meta.value.repo !== dep.repo || !M.isLive(t) || mine.includes(t.id)) continue
        this.gate.offer(`${o.file}|${t.id}`, { from: { sessionId: o.sessionId, name: o.name, repo: o.repo, threads: mine }, dependent: { repo: dep.repo, via: dep.via, thread: t.id }, file: o.file, diff: o.diff })
        told.push(t.meta.value.name)
      }
    return told
  }

  private send(items: Batch[]) {
    const last = items[items.length - 1]
    const t = this.d.threads.thread(last.dependent.thread)
    if (!t) return
    const fromNames = last.from.threads.map((id) => this.d.threads.thread(id)?.meta.value.name ?? id)
    const local = this.d.threads.sessionsIn([t.id]).filter((sid) => sid !== last.from.sessionId)
    const byFp = new Map(Object.values(this.d.peers()).map((p) => [p.fingerprint, p.label]))
    const labels = M.people(t)
      .filter((fp) => fp !== this.d.me)
      .map((fp) => byFp.get(fp))
      .filter((l): l is string => !!l)
    if (!local.length && !labels.length) return
    const text =
      `heads-up from ${short(last.from.repo)}: ${this.d.label}/${last.from.name}${fromNames.length ? ` in ${fromNames.join(", ")}` : ""} changed ${last.file}` +
      `${items.length > 1 ? ` ${items.length} times` : ""}, part of ${short(last.from.repo)}'s public surface, which ${short(t.meta.value.repo)} depends on (${last.dependent.via}). ` +
      `The diff is attached as a slice. Nobody needs to answer this: check whether ${t.meta.value.name} needs a change, and raise a question only if it needs a decision.`
    this.d.relay({
      thread: t.id,
      local,
      labels,
      text,
      diff: { label: `diff of ${short(last.from.repo)}/${last.file}`, content: last.diff.slice(0, 64 * 1024) },
      warn: { repo: t.meta.value.repo, file: `${short(last.from.repo)}:${last.file}`, symbols: [], pending: [], fromThreads: [], fromNames, target: t.id, library: last.from.repo },
      fromSession: last.from.name,
    })
    this.d.log(`cross-repo heads-up: ${last.from.repo} ${last.file} to ${t.meta.value.name} in ${t.meta.value.repo} (${local.length} here, ${labels.join(", ") || "nobody"} remote)`)
  }
}
