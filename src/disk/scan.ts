// Claude Code's own leftovers (docs/design/next-generation.md, "Disk").
//
// Two kinds, each found conservatively, and nothing is removed here without
// the person's yes (budget.ts asks; free() is only called on an answer):
//
//   worktrees     every `git worktree list` entry under a Claude Code worktree
//                 folder (`.claude/worktrees/`), in any repo the person has
//                 had sessions in, whose branch is merged into the default
//                 branch or gone (its HEAD then already in the default
//                 branch), with no change and nothing untracked, and that no
//                 live session or process is in (by working directory, which
//                 covers one listening from inside it) and no crosstalk
//                 service runs in (docs/services.md): those stop only with
//                 their thread's cleanup
//   transcripts   ~/.claude/projects/<project>/<session>.jsonl, and the
//                 session's folder beside it, untouched for 30 days, whose
//                 working directory no longer exists
//
// Worktrees go with `git worktree remove` (which refuses one with changes)
// and `git worktree prune`; a merged branch goes with `git branch -d`, which
// refuses one that is not. A main checkout is never a candidate.
//
// Sizes come from `du -sk`, run asynchronously so the daemon never stalls on a
// big node_modules.

import fs from "node:fs"
import path from "node:path"
import { execFile } from "node:child_process"
import { git as liveGit, worktrees, type Git } from "../terminal/repo.ts"
import { claudeDir } from "../metrics/transcripts.ts"
import { cwds as procCwds } from "../services/procs.ts"

export const DAY = 24 * 60 * 60_000
export const OLD_DAYS = () => Number(process.env.CROSSTALK_DISK_OLD_DAYS ?? 30)

export type Item = {
  kind: "worktree" | "transcript"
  path: string
  kb: number
  /** What it belonged to: a thread's name when one is known, else its branch or folder. */
  group: string
  why: string
  repo?: string
  branch?: string
  merged?: boolean
  /** Removed along with it: a transcript's session folder. */
  extra?: string[]
}

export type Report = {
  at: number
  /** Everything Claude Code keeps that this looked at: every worktree under its folders and every transcript. */
  usedKb: number
  reclaim: Item[]
  reclaimKb: number
  /** Distinct finished threads the reclaimable items belong to. */
  groups: number
  /** Worktrees left because they are in use, changed or not merged. */
  kept: { path: string; why: string }[]
}

export type Env = {
  claudeDir: string
  now: number
  git: Git
  /** Working directories of sessions and processes alive now. */
  liveCwds: string[]
  /** Repos known some other way (crosstalk's threads), beside those found in transcripts. */
  repos: string[]
  sizeKb: (p: string) => Promise<number>
  /** The thread a branch of a repo belongs to, when crosstalk knows it. */
  threadOf?: (repoRoot: string, branch: string) => string | undefined
  /** crosstalk services (crosstalk_sessions action "serve") running in a worktree: it is kept while any is. */
  services?: (worktree: string) => { name: string }[]
}

export const isClaudeWorktree = (p: string) => /[\\/]\.claude[\\/]worktrees[\\/]/.test(path.resolve(p) + path.sep)

/** Kilobytes on disk, not following links. */
export function duKb(p: string): Promise<number> {
  return new Promise((resolve) =>
    execFile("du", ["-sk", p], { timeout: 120_000, maxBuffer: 1024 * 1024 }, (_e, out) => resolve(Number(String(out ?? "").split(/\s/)[0]) || 0)),
  )
}

/** The working directory a transcript was recorded in: the first `cwd` it mentions. */
export function transcriptCwd(file: string): string | undefined {
  try {
    const fd = fs.openSync(file, "r")
    try {
      const buf = Buffer.alloc(64 * 1024)
      const n = fs.readSync(fd, buf, 0, buf.length, 0)
      const m = /"cwd"\s*:\s*("(?:[^"\\]|\\.)*")/.exec(buf.subarray(0, n).toString("utf8"))
      return m ? JSON.parse(m[1]) : undefined
    } finally {
      fs.closeSync(fd)
    }
  } catch {
    return undefined
  }
}

type Transcript = { file: string; dir?: string; cwd?: string; mtime: number; kb: number }

function transcripts(dir: string): Transcript[] {
  const out: Transcript[] = []
  const root = path.join(dir, "projects")
  let projects: string[] = []
  try {
    projects = fs.readdirSync(root)
  } catch {
    return out
  }
  for (const p of projects) {
    const pd = path.join(root, p)
    let names: string[] = []
    try {
      names = fs.readdirSync(pd).filter((f) => f.endsWith(".jsonl"))
    } catch {
      continue
    }
    for (const n of names) {
      const file = path.join(pd, n)
      try {
        const st = fs.statSync(file)
        const side = path.join(pd, n.slice(0, -".jsonl".length))
        out.push({ file, dir: fs.existsSync(side) ? side : undefined, cwd: transcriptCwd(file), mtime: st.mtimeMs, kb: Math.ceil(st.size / 1024) })
      } catch {}
    }
  }
  return out
}

const under = (p: string, dir: string) => {
  const a = path.resolve(p)
  const b = path.resolve(dir)
  return a === b || a.startsWith(b + path.sep)
}

function defaultBranch(repo: string, g: Git): string | undefined {
  const o = g(repo, ["symbolic-ref", "--quiet", "--short", "refs/remotes/origin/HEAD"])
  if (o.ok && o.out) return o.out.replace(/^origin\//, "")
  for (const b of ["main", "master", "trunk"]) if (g(repo, ["rev-parse", "--verify", "--quiet", `refs/heads/${b}`]).ok) return b
  return undefined
}

function clean(w: string, g: Git): boolean {
  const r = g(w, ["status", "--porcelain", "--untracked-files=all"])
  return r.ok && !r.out.trim()
}

/** Merged: no commit of its own left outside the default branch (locally or on origin), and at least one that landed. */
function mergedInto(repo: string, d: string, ref: string, g: Git): boolean {
  if (!g(repo, ["merge-base", "--is-ancestor", ref, d]).ok) {
    const remote = g(repo, ["rev-parse", "--verify", "--quiet", `refs/remotes/origin/${d}`])
    if (!remote.ok || !g(repo, ["merge-base", "--is-ancestor", ref, `origin/${d}`]).ok) {
      // Landed as equivalent patches (a rebase onto the default branch).
      const cherry = g(repo, ["cherry", d, ref])
      return cherry.ok && !!cherry.out && cherry.out.split("\n").every((l) => l.startsWith("-"))
    }
  }
  return true
}

/** Where removable and network volumes are mounted: a folder missing under one may just be unplugged. */
const MOUNT_PARENT = /^(\/|\/Volumes|\/media|\/media\/[^/]+|\/mnt|\/run\/media\/[^/]+|\/net|\/Network|[A-Za-z]:\\?)$/

/**
 * Whether a missing folder may only be on a volume that is not mounted now
 * (/Volumes/<disk> unplugged, /mnt/<share> down): its nearest existing parent
 * is a mount point's parent, or the root. Such a transcript is not "its
 * folder is gone", and is never reclaimed.
 */
export function mayBeUnmounted(cwd: string, exists: (p: string) => boolean = fs.existsSync): boolean {
  let p = path.resolve(cwd)
  for (;;) {
    const up = path.dirname(p)
    if (up === p) return true
    p = up
    if (exists(p)) return MOUNT_PARENT.test(p)
  }
}

export async function scan(e: Env): Promise<Report> {
  const g = e.git
  const ts = transcripts(e.claudeDir)
  // Every repo the person has had sessions in, by its main checkout.
  const repos = new Set<string>()
  const cwds = new Set<string>([...ts.map((t) => t.cwd).filter((c): c is string => !!c), ...e.liveCwds, ...e.repos])
  const seenTop = new Set<string>()
  for (const c of cwds) {
    if (!fs.existsSync(c)) continue
    const top = g(c, ["rev-parse", "--show-toplevel"])
    if (!top.ok || !top.out || seenTop.has(top.out)) continue
    seenTop.add(top.out)
    const main = worktrees(c, g)[0]
    if (main && !main.bare) repos.add(main.path)
  }
  // Worktree folders Claude Code made but git does not list: none are removed, they only count as used.
  const reclaim: Item[] = []
  const kept: Report["kept"] = []
  let usedKb = 0
  const live = e.liveCwds.filter(Boolean)
  for (const repo of repos) {
    const d = defaultBranch(repo, g)
    for (const w of worktrees(repo, g).slice(1)) {
      if (w.bare || !isClaudeWorktree(w.path) || !fs.existsSync(w.path)) continue
      const kb = await e.sizeKb(w.path)
      usedKb += kb
      const keep = (why: string) => kept.push({ path: w.path, why })
      if (live.some((c) => under(c, w.path))) {
        keep("a session is working in it")
        continue
      }
      const svcs = e.services?.(w.path) ?? []
      if (svcs.length) {
        keep(`a crosstalk service is running in it (${svcs.map((x) => x.name).join(", ")})`)
        continue
      }
      if (!clean(w.path, g)) {
        keep("it has changes")
        continue
      }
      if (!d) {
        keep("no default branch to compare with")
        continue
      }
      const branchThere = !!w.branch && g(repo, ["rev-parse", "--verify", "--quiet", `refs/heads/${w.branch}`]).ok
      if (w.branch === d) {
        keep("it is on the default branch")
        continue
      }
      const ref = branchThere ? `refs/heads/${w.branch}` : w.head ?? "HEAD"
      if (!mergedInto(repo, d, ref, g)) {
        keep("its work is not merged")
        continue
      }
      const group = (w.branch && e.threadOf?.(repo, w.branch)) || w.branch || path.basename(w.path)
      reclaim.push({
        kind: "worktree",
        path: w.path,
        kb,
        group,
        repo,
        ...(w.branch ? { branch: w.branch } : {}),
        merged: branchThere,
        why: branchThere ? `${w.branch} is merged into ${d}` : `its branch is gone and its work is in ${d}`,
      })
    }
  }
  const old = e.now - OLD_DAYS() * DAY
  for (const t of ts) {
    const kb = t.kb + (t.dir ? await e.sizeKb(t.dir) : 0)
    usedKb += kb
    if (t.mtime > old || !t.cwd || fs.existsSync(t.cwd) || mayBeUnmounted(t.cwd)) continue
    reclaim.push({
      kind: "transcript",
      path: t.file,
      kb,
      group: t.cwd,
      why: `untouched for ${Math.floor((e.now - t.mtime) / DAY)} days, and ${t.cwd} no longer exists`,
      ...(t.dir ? { extra: [t.dir] } : {}),
    })
  }
  return {
    at: e.now,
    usedKb,
    reclaim,
    reclaimKb: reclaim.reduce((s, i) => s + i.kb, 0),
    groups: new Set(reclaim.map((i) => i.group)).size,
    kept,
  }
}

export type Freed = { path: string; kb: number; ok: boolean; why?: string }

/**
 * Remove exactly the confirmed items that a fresh scan still finds
 * reclaimable: anything that changed since the person said yes stays.
 */
export function free(confirmed: Item[], fresh: Report, g: Git = liveGit): Freed[] {
  const still = new Map(fresh.reclaim.map((i) => [`${i.kind}:${path.resolve(i.path)}`, i]))
  const out: Freed[] = []
  for (const c of confirmed) {
    const i = still.get(`${c.kind}:${path.resolve(c.path)}`)
    if (!i) {
      out.push({ path: c.path, kb: 0, ok: false, why: "no longer finished, or already gone" })
      continue
    }
    if (i.kind === "worktree") {
      const r = g(i.repo!, ["worktree", "remove", i.path])
      if (!r.ok) {
        out.push({ path: i.path, kb: 0, ok: false, why: r.out.split("\n").pop() })
        continue
      }
      g(i.repo!, ["worktree", "prune"])
      if (i.branch && i.merged) g(i.repo!, ["branch", "-d", i.branch])
      out.push({ path: i.path, kb: i.kb, ok: true })
    } else {
      try {
        fs.rmSync(i.path, { force: true })
        for (const x of i.extra ?? []) fs.rmSync(x, { recursive: true, force: true })
        out.push({ path: i.path, kb: i.kb, ok: true })
      } catch (err) {
        out.push({ path: i.path, kb: 0, ok: false, why: (err as Error).message })
      }
    }
  }
  return out
}

export const human = (kb: number) => (kb >= 1024 * 1024 ? `${(kb / 1024 / 1024).toFixed(1).replace(/\.0$/, "")} GB` : kb >= 1024 ? `${Math.round(kb / 1024)} MB` : `${kb} KB`)

/** Live working directories: Claude Code's registry, crosstalk's restore records and every process's cwd (/proc on Linux, lsof elsewhere). */
export function liveCwds(o: { registry?: { cwd: string }[]; records?: { cwd: string }[] } = {}): string[] {
  const out = new Set<string>([...(o.registry ?? []), ...(o.records ?? [])].map((r) => r.cwd).filter(Boolean))
  try {
    for (const c of procCwds().values()) out.add(c)
  } catch {}
  return [...out]
}

export const defaultClaudeDir = claudeDir
