// Each worktree gets its own ports (docs/services.md).
//
// A block of ten, from 4100 up in steps of ten, given to a worktree the first
// time crosstalk makes it (src/spawn.ts) or a session registers in it, and
// kept: the same worktree gets the same block every time, two worktrees
// never share one, and a block with a port in use when it is handed out is
// skipped. Kept in <crosstalk home>/ports.json, by the worktree's top folder.
//
// Services get PORT (the block's first port unless that one is taken by
// another of the worktree's services), CROSSTALK_PORT_BASE and
// CROSSTALK_PORTS; a session is told its block at SessionStart.

import fs from "node:fs"
import path from "node:path"
import { spawnSync } from "node:child_process"
import { P } from "../config.ts"
import { listeners } from "./procs.ts"

export const SIZE = 10
export const START = () => Number(process.env.CROSSTALK_PORT_START ?? 4100)
export const MAX = 65_000

export type Block = { base: number; ports: number[] }
type Store = { blocks: Record<string, { base: number; at: number }> }

const file = () => path.join(P.root, "ports.json")

export function load(): Store {
  try {
    const s = JSON.parse(fs.readFileSync(file(), "utf8"))
    return { blocks: s && typeof s.blocks === "object" ? s.blocks : {} }
  } catch {
    return { blocks: {} }
  }
}

function save(s: Store) {
  fs.mkdirSync(P.root, { recursive: true, mode: 0o700 })
  const tmp = `${file()}.${process.pid}.tmp`
  fs.writeFileSync(tmp, JSON.stringify(s, null, 2), { mode: 0o600 })
  fs.renameSync(tmp, file())
}

const sleepSync = (ms: number) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms)
function locked<T>(fn: () => T): T {
  fs.mkdirSync(P.root, { recursive: true, mode: 0o700 })
  const lock = `${file()}.lock`
  let held = false
  for (let i = 0; i < 200 && !held; i++) {
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
    return fn()
  } finally {
    if (held)
      try {
        fs.rmdirSync(lock)
      } catch {}
  }
}

export const range = (base: number, size = SIZE) => Array.from({ length: size }, (_, i) => base + i)

/**
 * The first block from `start` that overlaps no block already given out and
 * has no port in use. Null when every block up to `max` is taken.
 */
export function pickBase(o: { taken: number[]; inUse: Set<number>; start?: number; size?: number; max?: number }): number | null {
  const size = o.size ?? SIZE
  const max = o.max ?? MAX
  for (let base = o.start ?? START(); base + size - 1 <= max; base += size) {
    if (o.taken.some((t) => Math.abs(t - base) < size)) continue
    if (range(base, size).some((p) => o.inUse.has(p))) continue
    return base
  }
  return null
}

/** A folder's worktree: its git top folder, else itself, with links resolved so one worktree has one key. */
export function rootOf(cwd: string): string {
  let dir = path.resolve(cwd)
  try {
    dir = fs.realpathSync(dir)
  } catch {}
  const r = spawnSync("git", ["-C", dir, "rev-parse", "--show-toplevel"], { encoding: "utf8", timeout: 5000 })
  const top = r.status === 0 ? r.stdout.trim() : ""
  if (!top) return dir
  try {
    return fs.realpathSync(top)
  } catch {
    return top
  }
}

/** This worktree's block, given now if it has none. Stable: asked again, the same block. */
export function blockFor(root: string, o: { inUse?: () => Set<number>; now?: number } = {}): Block | null {
  const have = load().blocks[root]
  if (have) return { base: have.base, ports: range(have.base) }
  return locked(() => {
    const s = load()
    const again = s.blocks[root]
    if (again) return { base: again.base, ports: range(again.base) }
    // A worktree that is gone gives its block back.
    for (const [r] of Object.entries(s.blocks)) if (!fs.existsSync(r)) delete s.blocks[r]
    const inUse = (o.inUse ?? (() => new Set(listeners().map((l) => l.port))))()
    const base = pickBase({ taken: Object.values(s.blocks).map((b) => b.base), inUse })
    if (base === null) return null
    s.blocks[root] = { base, at: o.now ?? Date.now() }
    save(s)
    return { base, ports: range(base) }
  })
}

/** The block a worktree already has, without giving one. */
export function blockOf(root: string): Block | null {
  const b = load().blocks[root]
  return b ? { base: b.base, ports: range(b.base) } : null
}

/** A removed worktree's block goes back. */
export function release(root: string) {
  locked(() => {
    const s = load()
    if (!s.blocks[root]) return
    delete s.blocks[root]
    save(s)
  })
}

/** What a service, and a session's brief, are given. */
export const portEnv = (b: Block, port = b.base): Record<string, string> => ({
  PORT: String(port),
  CROSSTALK_PORT_BASE: String(b.base),
  CROSSTALK_PORTS: b.ports.join(","),
})

export const span = (b: Block) => `${b.ports[0]}-${b.ports[b.ports.length - 1]}`
