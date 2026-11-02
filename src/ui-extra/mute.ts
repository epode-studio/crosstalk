// Muting a person or a thread in plain words ("mute jo", "mute auth for an
// hour"), the crosstalk_mute tool. A person is muted the way /crosstalk:mute
// always did (src/trust.ts, through the daemon). A thread is muted here: its
// messages are held quietly, like a muted person's, and its cards go.
//
// Muting holds, it never drops: what arrives meanwhile is still there to read.

import fs from "node:fs"
import path from "node:path"
import { P } from "../config.ts"
import * as M from "../threads/model.ts"
import * as ui from "../uistate.ts"
import { findThread, readThreads, type ThreadState } from "./threadfile.ts"

const file = () => path.join(P.root, "thread-mutes.json")

/** Thread id → { name, until }. */
type Mutes = Record<string, { name: string; until: number }>

export function loadMutes(): Mutes {
  try {
    const m = JSON.parse(fs.readFileSync(file(), "utf8"))
    return m && typeof m === "object" ? m : {}
  } catch {
    return {}
  }
}

function saveMutes(m: Mutes) {
  fs.mkdirSync(P.root, { recursive: true, mode: 0o700 })
  const tmp = `${file()}.${process.pid}.tmp`
  fs.writeFileSync(tmp, JSON.stringify(m), { mode: 0o600 })
  fs.renameSync(tmp, file())
}

const HOUR = 60 * 60_000
/** Without a "for", a mute lasts a day. */
export const DEFAULT_MS = 24 * HOUR
/** "forever", as far as anyone will notice. */
const FOREVER_MS = 10 * 365 * 24 * HOUR

/**
 * How long, from plain words or a number of minutes: `30`, `30m`, `2h`,
 * `1 day`, `a week`, `forever`, `0` (unmute), `until tomorrow`.
 */
export function parseFor(v: unknown, now = Date.now()): number | null {
  if (v === undefined || v === null || v === "") return DEFAULT_MS
  if (typeof v === "number") return v <= 0 ? 0 : v * 60_000
  const s = String(v).trim().toLowerCase()
  if (/^(0|off|unmute|none|stop)$/.test(s)) return 0
  if (/^(forever|always|for good|indefinitely|until i (say|unmute))/.test(s)) return FOREVER_MS
  if (/tomorrow/.test(s)) {
    const d = new Date(now)
    d.setDate(d.getDate() + 1)
    d.setHours(9, 0, 0, 0)
    return d.getTime() - now
  }
  const m = /^(?:for\s+)?(an?|\d+(?:\.\d+)?)\s*(m|min|mins|minutes?|h|hr|hrs|hours?|d|days?|w|weeks?)?$/.exec(s)
  if (!m) return null
  const n = m[1] === "a" || m[1] === "an" ? 1 : Number(m[1])
  const unit = m[2] ?? "m"
  const per = /^m/.test(unit) ? 60_000 : /^h/.test(unit) ? HOUR : /^d/.test(unit) ? 24 * HOUR : 7 * 24 * HOUR
  return Math.round(n * per)
}

export function until(ms: number, now = Date.now()): string {
  if (ms >= FOREVER_MS) return "until you unmute it"
  const d = new Date(now + ms)
  const sameDay = new Date(now).toDateString() === d.toDateString()
  return `until ${sameDay ? d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" }) : d.toLocaleString([], { weekday: "short", hour: "2-digit", minute: "2-digit" })}`
}

/** Mute (or with 0, unmute) one thread. Its open cards are muted with it. */
export function muteThread(t: M.Thread, ms: number, now = Date.now()): { name: string; until?: number } {
  const m = loadMutes()
  const name = t.meta.value.name
  if (ms <= 0) delete m[t.id]
  else m[t.id] = { name, until: now + ms }
  saveMutes(m)
  if (ms > 0) muteCards((it) => (it.thread ?? "").toLowerCase() === name)
  return { name, until: ms > 0 ? now + ms : undefined }
}

/** Open message cards that match, muted: they stop asking, and stay readable. */
export function muteCards(match: (it: ui.UiItem) => boolean): number {
  let n = 0
  ui.withStore((items, now) => {
    for (const it of Object.values(items))
      if ((it.kind === "message" || it.kind === "ask") && !ui.FINAL.has(it.state) && match(it)) {
        ui.act(items, it.id, "mute", now)
        n++
      }
  })
  return n
}

/**
 * Whether an arriving message is about a muted thread. The envelope names
 * thread ids (`threads`) or a name (`thread`); either counts.
 */
export function threadMuted(env: { thread?: string; threads?: string[] }, now = Date.now(), mutes: Mutes = loadMutes()): boolean {
  const live = Object.entries(mutes).filter(([, v]) => v.until > now)
  if (!live.length) return false
  const ids = new Set(env.threads ?? [])
  const name = env.thread ? M.slug(env.thread) : undefined
  return live.some(([id, v]) => ids.has(id) || (!!name && v.name === name))
}

export function findForMute(name: string, sessionId?: string, st: ThreadState = readThreads()) {
  return findThread(st, name, sessionId)
}
