// Parking a thread: out of sight until needed.
//
// "park auth" (crosstalk_work action park). While parked, crosstalk starts
// nothing new in it (the board, chasing what it waited on) and its notices and
// questions stay out of main, held, not lost: "unpark auth" brings them back as
// they were. A permission an agent is stuck on still comes through, so nothing
// waits silently. Parking is the person's own, never synced to teammates.
//
// Also the cap on agents working at once (WIP): a background agent asked for
// past the cap waits its turn in a queue, started by the daemon when one ends.

import fs from "node:fs"
import path from "node:path"
import { P } from "../config.ts"

const file = () => path.join(P.root, "parked.json")
type Parked = Record<string, { at: number }>

export function read(): Parked {
  try {
    const p = JSON.parse(fs.readFileSync(file(), "utf8"))
    return p && typeof p === "object" ? p : {}
  } catch {
    return {}
  }
}
function write(p: Parked) {
  fs.mkdirSync(P.root, { recursive: true, mode: 0o700 })
  const tmp = `${file()}.${process.pid}.tmp`
  fs.writeFileSync(tmp, JSON.stringify(p), { mode: 0o600 })
  fs.renameSync(tmp, file())
}

const key = (t: string) => t.trim().toLowerCase()
export const isParked = (thread: string | undefined, p = read()) => !!thread && !!p[key(thread)]
export const names = (p = read()) => Object.keys(p)

/** Park or unpark a thread; returns what to say. */
export function set(thread: string, on: boolean, now = Date.now()): string {
  const t = thread.trim()
  if (!t) return "◢ crosstalk: say which thread to park."
  const p = read()
  if (on) {
    if (p[key(t)]) return `◢ crosstalk: ${t} is already parked. Say "unpark ${t}" to bring it back.`
    write({ ...p, [key(t)]: { at: now } })
    return `◢ crosstalk: parked ${t}. Nothing new starts in it and its questions wait out of sight. Say "unpark ${t}" when you want it back.`
  }
  if (!p[key(t)]) return `◢ crosstalk: ${t} was not parked.`
  const { [key(t)]: _, ...rest } = p
  write(rest)
  return `◢ crosstalk: ${t} is back. Anything it held is in main again.`
}

/** Whether an item is held while its thread is parked. A stuck agent's permission always comes through. */
export function held(i: { id: string; thread?: string }, p = read()): boolean {
  if (i.id.startsWith("attn:perm:")) return false
  return isParked(i.thread, p)
}

// --- at most N agents at once --------------------------------------------------------------

export const wipMax = (env: NodeJS.ProcessEnv = process.env) => Math.max(1, Number(env.CROSSTALK_WIP ?? 4) || 4)

export type Queued = { task: string; name?: string; cwd: string; by?: string; thread?: unknown; at: number }
const qfile = () => path.join(P.root, "queue.json")
export function queue(): Queued[] {
  try {
    const q = JSON.parse(fs.readFileSync(qfile(), "utf8"))
    return Array.isArray(q) ? q : []
  } catch {
    return []
  }
}
export function writeQueue(q: Queued[]) {
  fs.mkdirSync(P.root, { recursive: true, mode: 0o700 })
  const tmp = `${qfile()}.${process.pid}.tmp`
  fs.writeFileSync(tmp, JSON.stringify(q), { mode: 0o600 })
  fs.renameSync(tmp, qfile())
}
export function enqueue(x: Omit<Queued, "at">, now = Date.now()): number {
  const q = [...queue(), { ...x, at: now }]
  writeQueue(q)
  return q.length
}

/**
 * Start what waits, while there is room. `running` counts the background
 * agents at work now; `start` starts one (false: leave it queued). A queued
 * agent in a parked thread waits for it to be unparked. Returns what started.
 */
export function drain(running: number, start: (x: Queued) => boolean, o: { max?: number; parked?: Parked; threadOf?: (x: Queued) => string | undefined } = {}): Queued[] {
  const max = o.max ?? wipMax()
  const all = queue()
  // A day in the queue is long enough: whatever it was for has moved on.
  const q = all.filter((x) => Date.now() - x.at < 86_400_000)
  if (!all.length) return []
  const started: Queued[] = []
  const left: Queued[] = []
  let n = running
  for (const x of q) {
    if (n < max && !isParked(o.threadOf?.(x), o.parked ?? read()) && start(x)) {
      started.push(x)
      n++
    } else left.push(x)
  }
  if (started.length || q.length !== all.length) writeQueue(left)
  return started
}
