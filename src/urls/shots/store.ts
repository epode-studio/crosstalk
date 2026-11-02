// Screenshots kept as evidence (docs/urls.md, "Screenshots as evidence").
//
// Each capture is a PNG under <crosstalk home>/shots/<thread>/ and a line in
// <crosstalk home>/shots/index.json, read and written under a lock like
// urls.json. A capture is keyed by what it shows: the URL record it came from
// (or the URL itself, for one asked for by address) and the path on it.
//
//   pairs      after is the newest capture of a key; before is the newest one
//              taken before the change that after shows (its changeAt: when
//              the turn that led to it first edited a file), else the one
//              before it
//   bounded    the last KEEP_PER_KEY of each key (CROSSTALK_SHOTS_KEEP, 6),
//              and MAX_BYTES in all (CROSSTALK_SHOTS_MAX_MB, 200): over it,
//              the oldest go first, the newest pair of each key last
//
// Nothing here leaves this machine. Evidence carries a capture's path, never
// its bytes (src/shipping/engine.ts).

import crypto from "node:crypto"
import fs from "node:fs"
import path from "node:path"
import { P } from "../../config.ts"

export type Reason = "turn" | "demand" | "baseline"

export type Shot = {
  id: string
  /** What it shows: `<url record id>|<path>`, or `url:<hash>|<path>` for one asked for by address. */
  key: string
  /** The address captured. */
  url: string
  /** `auth · web`, from the URL's record. */
  label: string
  /** The path on it, when one was asked for: `/login`. */
  path?: string
  /** The PNG, absolute. */
  file: string
  at: number
  bytes: number
  /** The thread (or worktree folder) it is filed under. */
  thread: string
  worktree?: string
  sessionId?: string
  reason: Reason
  /** turn: when that turn first edited a file. The capture before it is this one's before. */
  changeAt?: number
  /** playwright, playwright-cli, chrome. */
  engine: string
  /** The worktree's commit when it was taken. */
  sha?: string
}

export const keepPerKey = () => Math.max(2, Number(process.env.CROSSTALK_SHOTS_KEEP ?? 6) || 6)
export const maxBytes = () => Math.max(1, Number(process.env.CROSSTALK_SHOTS_MAX_MB ?? 200) || 200) * 1024 * 1024

export const shotsDir = () => path.join(P.root, "shots")
const indexFile = () => path.join(shotsDir(), "index.json")

/** A folder name for a thread: its name, safe as one path segment. */
export const folderOf = (thread: string) => thread.toLowerCase().replace(/[^a-z0-9._-]+/g, "-").replace(/^[-.]+|[-.]+$/g, "").slice(0, 48) || "local"

export const keyOf = (o: { urlId?: string; url: string; path?: string }) =>
  `${o.urlId ?? `url:${crypto.createHash("sha1").update(o.url).digest("hex").slice(0, 12)}`}|${o.path ?? ""}`

/**
 * What to keep, pure: the newest `perKey` of each key, then, over `max` bytes,
 * the oldest first, each key's newest pair after everything else.
 */
export function bounded(all: Shot[], o: { perKey?: number; max?: number } = {}): { keep: Shot[]; drop: Shot[] } {
  const perKey = o.perKey ?? keepPerKey()
  const max = o.max ?? maxBytes()
  const byKey = new Map<string, Shot[]>()
  for (const s of all) byKey.set(s.key, [...(byKey.get(s.key) ?? []), s])
  const drop = new Set<string>()
  // 2: a key's newest (its after), 1: the one before it, 0: the rest.
  const worth = new Map<string, number>()
  for (const g of byKey.values()) {
    const newest = [...g].sort((a, b) => b.at - a.at)
    newest.slice(perKey).forEach((s) => drop.add(s.id))
    newest.forEach((s, i) => worth.set(s.id, i === 0 ? 2 : i === 1 ? 1 : 0))
  }
  let left = all.filter((s) => !drop.has(s.id))
  let total = left.reduce((n, s) => n + (s.bytes || 0), 0)
  if (total > max) {
    const order = [...left].sort((a, b) => worth.get(a.id)! - worth.get(b.id)! || a.at - b.at)
    for (const s of order) {
      if (total <= max) break
      drop.add(s.id)
      total -= s.bytes || 0
    }
    left = left.filter((s) => !drop.has(s.id))
  }
  return { keep: left, drop: all.filter((s) => drop.has(s.id)) }
}

export type Pair = { key: string; label: string; url: string; path?: string; thread: string; after: Shot; before?: Shot }

/** The before and after of one key, pure. Before is the newest capture taken before the change after shows. */
export function pairFor(all: Shot[], key: string): Pair | undefined {
  const mine = all.filter((s) => s.key === key).sort((a, b) => b.at - a.at)
  const after = mine[0]
  if (!after) return undefined
  const cut = Math.min(after.changeAt ?? after.at, after.at)
  const before = mine.find((s) => s.id !== after.id && s.at < cut) ?? (after.changeAt === undefined ? mine[1] : undefined)
  return { key, label: after.label, url: after.url, ...(after.path ? { path: after.path } : {}), thread: after.thread, after, ...(before ? { before } : {}) }
}

/** Every key's pair, newest first. */
export function pairs(all: Shot[]): Pair[] {
  const keys = [...new Set(all.map((s) => s.key))]
  return keys
    .map((k) => pairFor(all, k)!)
    .filter(Boolean)
    .sort((a, b) => b.after.at - a.after.at)
}

const sleepSync = (ms: number) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms)

export class ShotStore {
  readonly file: string
  constructor(o: { file?: string } = {}) {
    this.file = o.file ?? indexFile()
  }

  read(): Shot[] {
    try {
      const raw = JSON.parse(fs.readFileSync(this.file, "utf8"))
      return Array.isArray(raw?.shots) ? raw.shots.filter((s: any) => s && typeof s.id === "string" && typeof s.file === "string" && typeof s.key === "string") : []
    } catch {
      return []
    }
  }

  private write(all: Shot[]) {
    fs.mkdirSync(path.dirname(this.file), { recursive: true, mode: 0o700 })
    const tmp = `${this.file}.${process.pid}.tmp`
    fs.writeFileSync(tmp, JSON.stringify({ v: 1, shots: all }, null, 1), { mode: 0o600 })
    fs.renameSync(tmp, this.file)
  }

  /** Read, change, bound and write under a lock; the files of what was dropped are removed. */
  mutate<T>(fn: (all: Shot[]) => T): T {
    fs.mkdirSync(path.dirname(this.file), { recursive: true, mode: 0o700 })
    const lock = `${this.file}.lock`
    let held = false
    for (let i = 0; i < 300 && !held; i++) {
      try {
        fs.mkdirSync(lock)
        held = true
      } catch {
        try {
          if (Date.now() - fs.statSync(lock).mtimeMs > 5000) fs.rmdirSync(lock)
        } catch {}
        sleepSync(10)
      }
    }
    try {
      // A capture whose file went (removed by hand) is forgotten.
      const all = this.read().filter((s) => fs.existsSync(s.file))
      const out = fn(all)
      const { keep, drop } = bounded(all)
      for (const s of drop) if (under(s.file, shotsDir()))
        try {
          fs.unlinkSync(s.file)
        } catch {}
      this.write(keep)
      return out
    } finally {
      if (held)
        try {
          fs.rmdirSync(lock)
        } catch {}
    }
  }

  add(s: Omit<Shot, "id">): Shot {
    const shot: Shot = { ...s, id: `${s.at.toString(36)}-${crypto.randomBytes(3).toString("hex")}` }
    this.mutate((all) => void all.push(shot))
    return shot
  }

  /** A thread's (by name), or a worktree's, newest first. */
  list(o: { thread?: string; worktree?: string } = {}): Shot[] {
    const t = o.thread?.toLowerCase()
    return this.read()
      .filter((s) => (!t && !o.worktree) || (t && s.thread.toLowerCase() === t) || (o.worktree && s.worktree === o.worktree))
      .filter((s) => fs.existsSync(s.file))
      .sort((a, b) => b.at - a.at)
  }
}

const under = (p: string, dir: string) => {
  const r = path.relative(dir, p)
  return !!r && !r.startsWith("..") && !path.isAbsolute(r)
}

export const shotStore = (o: { file?: string } = {}) => new ShotStore(o)

/** Where a new capture goes. */
export function fileFor(o: { thread: string; key: string; at: number }): string {
  const slug = o.key.replace(/[^A-Za-z0-9._-]+/g, "_").slice(0, 60)
  return path.join(shotsDir(), folderOf(o.thread), `${slug}-${o.at.toString(36)}.png`)
}
