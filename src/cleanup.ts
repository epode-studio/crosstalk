// Worktree cleanup.
//
// A worktree crosstalk made for an agent (src/spawn.ts) is disposable once its
// work has landed: its branch is merged into the default branch, or the branch
// is gone, and its session has ended. crosstalk then offers once, as the mod's
// picker or a systemMessage, to remove those worktrees, and answers in plain
// words through crosstalk_cleanup. Removing is `git worktree remove` (which
// refuses anything with changes) and `git worktree prune`, and the merged
// branch is deleted with `git branch -d`, which refuses an unmerged one.
//
// Worktrees crosstalk did not make are never touched unless the person
// confirms that very set: they are listed, and only removed when named.

import fs from "node:fs"
import path from "node:path"
import { spawnSync } from "node:child_process"
import { P } from "./config.ts"
import * as R from "./restore.ts"
import * as ui from "./uistate.ts"
import { readSpawned, writeSpawned, tmuxHas, type SpawnRec } from "./spawn.ts"
import { git as liveGit, worktrees, type Git } from "./terminal/repo.ts"

export type Probe = {
  exists: (p: string) => boolean
  /** No changes to tracked files and nothing untracked, links crosstalk made aside. */
  clean: (worktree: string, ignore: string[]) => boolean
  branchExists: (repo: string, branch: string) => boolean
  /**
   * Whether the branch's work is in the default branch: every commit on it is,
   * and it has one of its own (a branch still at `base` landed nothing).
   */
  merged: (repo: string, branch: string, base?: string) => boolean
  ended: (r: SpawnRec) => boolean
}

export type Candidate = { rec: SpawnRec; why: "merged" | "deleted" }

/** Which crosstalk worktrees may go: done with, landed, and clean. */
export function select(recs: SpawnRec[], p: Probe): Candidate[] {
  const out: Candidate[] = []
  for (const r of recs) {
    if (r.removedAt || !p.exists(r.worktree)) continue
    if (!p.ended(r)) continue
    if (!p.clean(r.worktree, r.links)) continue
    if (!p.branchExists(r.repo, r.branch)) out.push({ rec: r, why: "deleted" })
    else if (p.merged(r.repo, r.branch, r.base)) out.push({ rec: r, why: "merged" })
  }
  return out
}

/** The default branch: origin's HEAD, else main or master, else whatever the main checkout is on. */
export function defaultBranch(repo: string, g: Git = liveGit): string | null {
  const o = g(repo, ["symbolic-ref", "--quiet", "--short", "refs/remotes/origin/HEAD"])
  if (o.ok && o.out) return o.out.replace(/^origin\//, "")
  for (const b of ["main", "master", "trunk"]) if (g(repo, ["rev-parse", "--verify", "--quiet", `refs/heads/${b}`]).ok) return b
  const h = g(repo, ["symbolic-ref", "--quiet", "--short", "HEAD"])
  return h.ok && h.out ? h.out : null
}

export function liveProbe(g: Git = liveGit): Probe {
  const defaults = new Map<string, string | null>()
  const def = (repo: string) => {
    if (!defaults.has(repo)) defaults.set(repo, defaultBranch(repo, g))
    return defaults.get(repo)!
  }
  return {
    exists: (p) => fs.existsSync(p),
    clean: (w, ignore) => {
      const r = g(w, ["status", "--porcelain", "--untracked-files=all"])
      if (!r.ok) return false
      const skip = new Set(ignore)
      return r.out
        .split("\n")
        .filter(Boolean)
        .every((l) => l.startsWith("?? ") && skip.has(l.slice(3).replace(/\/$/, "")))
    },
    branchExists: (repo, b) => g(repo, ["rev-parse", "--verify", "--quiet", `refs/heads/${b}`]).ok,
    merged: (repo, b, base) => {
      const d = def(repo)
      if (!d || d === b) return false
      const tip = g(repo, ["rev-parse", "--verify", "--quiet", `refs/heads/${b}`])
      if (!tip.ok || (base && tip.out === base)) return false
      const ahead = g(repo, ["rev-list", "--count", `${d}..${b}`])
      if (!ahead.ok || ahead.out !== "0") {
        const remote = g(repo, ["rev-list", "--count", `origin/${d}..${b}`])
        if (!remote.ok || remote.out !== "0") {
          // Landed as equivalent patches: shipping rebases onto the default
          // branch rather than rewriting the agent's own branch.
          const cherry = g(repo, ["cherry", d, b])
          if (!cherry.ok || !cherry.out || !cherry.out.split("\n").every((l) => l.startsWith("-"))) return false
        }
      }
      return true
    },
    ended: (r) => {
      if (r.background && r.tmux && tmuxHas(r.tmux)) return false
      const live = R.readAll().some((x) => !x.endedAt && path.resolve(x.cwd).startsWith(path.resolve(r.worktree)) && R.recAlive(x))
      return !live
    },
  }
}

/**
 * Worktrees of these repositories that crosstalk did not make, merged and
 * clean, for the person to confirm by name. Never the main checkout.
 */
export function foreign(repos: string[], mine: Set<string>, p: Probe, g: Git = liveGit): { path: string; branch?: string; repo: string }[] {
  const out: { path: string; branch?: string; repo: string }[] = []
  for (const repo of repos)
    for (const w of worktrees(repo, g).slice(1)) {
      if (w.bare || mine.has(path.resolve(w.path)) || !p.exists(w.path)) continue
      if (!w.branch || !p.clean(w.path, [])) continue
      if (p.merged(repo, w.branch)) out.push({ path: w.path, branch: w.branch, repo })
    }
  return out
}

/** Kilobytes on disk, not following links: a shared node_modules is not this worktree's. */
export function sizeKb(p: string): number {
  const r = spawnSync("du", ["-sk", p], { encoding: "utf8", timeout: 60_000 })
  return Number((r.stdout ?? "").split(/\s/)[0]) || 0
}

export const human = (kb: number) => (kb >= 1024 * 1024 ? `${(kb / 1024 / 1024).toFixed(1)} GB` : kb >= 1024 ? `${Math.round(kb / 1024)} MB` : `${kb} KB`)

export type Removed = { path: string; kb: number; ok: boolean; why?: string }

/** Remove one worktree the safe way, and prune. A crosstalk branch that merged goes too. */
export function removeOne(o: { repo: string; worktree: string; links: string[]; branch?: string; ours: boolean }, g: Git = liveGit): Removed {
  const kb = sizeKb(o.worktree)
  for (const l of o.links) {
    const p = path.join(o.worktree, l)
    try {
      if (fs.lstatSync(p).isSymbolicLink()) fs.unlinkSync(p)
    } catch {}
  }
  const r = g(o.repo, ["worktree", "remove", o.worktree])
  if (!r.ok) {
    // Put the links back: the worktree is still there and still in use.
    for (const l of o.links)
      try {
        fs.symlinkSync(path.join(o.repo, l), path.join(o.worktree, l), "dir")
      } catch {}
    return { path: o.worktree, kb: 0, ok: false, why: r.out.split("\n").pop() }
  }
  g(o.repo, ["worktree", "prune"])
  if (o.ours && o.branch) g(o.repo, ["branch", "-d", o.branch])
  return { path: o.worktree, kb, ok: true }
}

// --- the offer ----------------------------------------------------------------------

export const cleanupId = (sessionId: string) => `cleanup:${sessionId}`
export const CLEANUP_OPTIONS = ["Remove them", "Not now"]

export type Offer = { text: string; question: string; count: number; names: string[] }

export function offerFor(c: Candidate[]): Offer | null {
  const fresh = c.filter((x) => !x.rec.offeredAt)
  if (!fresh.length) return null
  const n = c.length
  const names = c.slice(0, 4).map((x) => x.rec.name).concat(n > 4 ? ["…"] : [])
  const question = `${n} agent worktree${n === 1 ? " is" : "s are"} done with: ${n === 1 ? "its" : "their"} work is merged and ${n === 1 ? "its session has" : "their sessions have"} ended. Remove ${n === 1 ? "it" : "them"}?`
  return { count: n, names, question, text: `◢ crosstalk: ${question} (${names.join(", ")}) Say "clean up the worktrees" to do it.` }
}

const stamp = () => path.join(P.root, "cleanup-stamp")
export const CHECK_EVERY_MS = () => Number(process.env.CROSSTALK_CLEANUP_EVERY_MS ?? 10 * 60 * 1000)

/**
 * Put the offer once: each worktree is named in an offer at most once. Cheap
 * when there is nothing crosstalk made, and at most every ten minutes.
 */
export function offerOnce(o: { force?: boolean; probe?: Probe } = {}): Offer | null {
  const recs = readSpawned().filter((r) => !r.removedAt)
  if (!recs.length) return null
  if (!o.force) {
    try {
      if (Date.now() - fs.statSync(stamp()).mtimeMs < CHECK_EVERY_MS()) return null
    } catch {}
    fs.mkdirSync(P.root, { recursive: true, mode: 0o700 })
    fs.writeFileSync(stamp(), String(Date.now()), { mode: 0o600 })
  }
  const c = select(recs, o.probe ?? liveProbe())
  const offer = offerFor(c)
  if (!offer) return null
  const now = Date.now()
  for (const x of c) if (!x.rec.offeredAt) writeSpawned({ ...x.rec, offeredAt: now })
  return offer
}

/** The offer as the mod's picker when the mod is here, else the systemMessage. Exactly one. */
export function surface(sessionId: string, offer: Offer | null, mod = ui.modActive(sessionId)): { systemMessage?: string } {
  if (!offer) return {}
  if (!mod) return { systemMessage: offer.text }
  try {
    ui.withStore((items, now) =>
      ui.upsert(items, { id: cleanupId(sessionId), kind: "cleanup", sessionId, count: offer.count, names: offer.names, question: offer.question, options: CLEANUP_OPTIONS }, now),
    )
    return {}
  } catch {
    return { systemMessage: offer.text }
  }
}

// --- what the tool and the CLI do ---------------------------------------------------

export type Outcome = { ok: boolean; text: string; removed: Removed[] }

/**
 * Without confirm, what could go. With it, remove every crosstalk worktree
 * that may, plus exactly the other worktrees named in `include`.
 */
export function run(o: { confirm?: boolean; include?: string[]; cwd?: string; probe?: Probe; git?: Git }): Outcome {
  const g = o.git ?? liveGit
  const p = o.probe ?? liveProbe(g)
  const recs = readSpawned().filter((r) => !r.removedAt)
  const mine = select(recs, p)
  const repos = [...new Set([...recs.map((r) => r.repo), ...(o.cwd ? [worktrees(o.cwd, g)[0]?.path].filter((x): x is string => !!x) : [])])]
  const others = foreign(repos, new Set(recs.map((r) => path.resolve(r.worktree))), p, g)
  const still = recs.filter((r) => !mine.some((m) => m.rec.id === r.id) && p.exists(r.worktree))

  if (!o.confirm) {
    const lines: string[] = []
    if (!mine.length && !others.length) lines.push("◢ crosstalk: no worktree is ready to remove.")
    if (mine.length) {
      lines.push(`◢ crosstalk: ${mine.length} worktree${mine.length === 1 ? "" : "s"} crosstalk made can go (merged or branch deleted, session ended):`)
      for (const m of mine) lines.push(`  ${m.rec.name.padEnd(16)} ${m.rec.worktree}  (${m.why === "merged" ? "merged" : "branch deleted"})`)
    }
    if (others.length) {
      lines.push(`Merged worktrees crosstalk did not make, removed only if you name them:`)
      for (const w of others) lines.push(`  ${w.path}  (${w.branch})`)
    }
    if (still.length) lines.push(`Still in use or not merged: ${still.map((r) => r.name).join(", ")}.`)
    return { ok: true, text: lines.join("\n"), removed: [] }
  }

  const removed: Removed[] = []
  for (const m of mine) {
    const r = removeOne({ repo: m.rec.repo, worktree: m.rec.worktree, links: m.rec.links, branch: m.rec.branch, ours: true }, g)
    removed.push(r)
    if (r.ok) writeSpawned({ ...m.rec, removedAt: Date.now() })
  }
  const asked = new Set((o.include ?? []).map((x) => path.resolve(x)))
  for (const w of others) if (asked.has(path.resolve(w.path))) removed.push(removeOne({ repo: w.repo, worktree: w.path, links: [], ours: false }, g))
  const unknown = [...asked].filter((a) => !others.some((w) => path.resolve(w.path) === a))
  const ok = removed.filter((r) => r.ok)
  const kb = ok.reduce((s, r) => s + r.kb, 0)
  const parts = [ok.length ? `◢ crosstalk: removed ${ok.length} worktree${ok.length === 1 ? "" : "s"}, freeing ${human(kb)}.` : "◢ crosstalk: removed no worktree."]
  for (const r of removed.filter((x) => !x.ok)) parts.push(`  kept ${r.path}: ${r.why}`)
  if (unknown.length) parts.push(`  left alone, not a merged clean worktree: ${unknown.join(", ")}`)
  return { ok: removed.every((r) => r.ok), text: parts.join("\n"), removed }
}

/** The picker's answer. */
export function act(session: string, id: string, action: string, value?: string): Record<string, unknown> {
  if (action === "raised" || action === "later") return ui.withStore((items, now) => ui.act(items, id, action, now))
  const v = (value ?? "").trim()
  const no = action === "mute" || /^(not now|no|never|later|keep)\b/i.test(v)
  const claim = ui.withStore((items, now) => ui.act(items, id, "answer", now, v || (no ? "Not now" : "Remove them")))
  if (!claim.ok) return claim
  if (no) return { ok: true, item: claim.item, text: `Kept them. Say "clean up the worktrees" any time.` }
  const out = run({ confirm: true })
  return { ok: out.ok, item: claim.item, text: out.text }
}
