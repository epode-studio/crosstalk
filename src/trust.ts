// What a source is allowed to do to you.
//
// This replaces three things that were describing one thing: a delivery mode, an
// allowAsk flag, and a branch in the daemon for someone sharing a room you never
// paired with. One ordered level, where each step contains the ones below it.
//
// Trust belongs to the room rather than the person, because what varies is what
// a room is for. An incident room is loud for everyone in it; an ideas room is
// quiet for everyone in it. Setting it per person meant eight decisions for a
// room of eight, and making them again for the next room. A person can still be
// pinned above or below their room.

import fs from "node:fs"
import path from "node:path"
import { ROOT } from "./config.ts"

export const LEVELS = ["mute", "notify", "ask", "handoff", "deliver"] as const
export type Level = (typeof LEVELS)[number]

export const rank = (l: Level) => LEVELS.indexOf(l)
export const atLeast = (have: Level, need: Level) => rank(have) >= rank(need)
export const lower = (a: Level, b: Level) => (rank(a) <= rank(b) ? a : b)
export const isLevel = (s: unknown): s is Level => LEVELS.includes(s as Level)

export const DESCRIPTION: Record<Level, string> = {
  mute: "nothing reaches you",
  notify: "a line on your screen; their words stay behind a tool call",
  ask: "also a question that costs you a turn",
  handoff: "also a work item with state and files",
  deliver: "also their words inside your turn",
}

export type Trust = {
  /** Applies to everyone in a room, keyed by room name without the hash. */
  rooms: Record<string, Level>
  /** Pins that override whatever room a message came through. */
  people: Record<string, Level>
  /** When neither applies. Someone you paired with, in no particular room. */
  default: Level
  /** Held without changing the level, keyed by person or "#room". */
  muted: Record<string, number>
}

const FILE = path.join(ROOT, "trust.json")

export const DEFAULT_TRUST: Trust = {
  rooms: {},
  people: {},
  default: "ask",
  muted: {},
}

/** The level a room starts at when nobody has said otherwise. */
export const ROOM_DEFAULT: Level = "notify"

export function load(): Trust {
  try {
    const raw = JSON.parse(fs.readFileSync(FILE, "utf8"))
    return {
      rooms: raw.rooms ?? {},
      people: raw.people ?? {},
      default: isLevel(raw.default) ? raw.default : DEFAULT_TRUST.default,
      muted: raw.muted ?? {},
    }
  } catch {
    return migrate()
  }
}

export function save(t: Trust) {
  fs.mkdirSync(ROOT, { recursive: true, mode: 0o700 })
  const tmp = `${FILE}.tmp`
  fs.writeFileSync(tmp, JSON.stringify(t, null, 2), { mode: 0o600 })
  fs.renameSync(tmp, FILE)
}

/** Carry across whatever the old two-field policy said, once. */
function migrate(): Trust {
  const t: Trust = { ...DEFAULT_TRUST, rooms: {}, people: {}, muted: {} }
  try {
    const old = JSON.parse(fs.readFileSync(path.join(ROOT, "policy.json"), "utf8"))
    const asLevel = (p: any): Level =>
      p?.delivery === "deliver" ? "deliver" : p?.delivery === "quiet" ? "notify" : p?.allowAsk ? "ask" : "notify"
    if (old?.default) t.default = asLevel(old.default)
    for (const [name, p] of Object.entries(old?.peers ?? {})) {
      t.people[name] = asLevel(p)
      if ((p as any).mutedUntil) t.muted[name] = (p as any).mutedUntil
    }
    save(t)
  } catch {}
  return t
}

export type Context = {
  /** Room the message came through, without the hash, if any. */
  room?: string
  /** False for someone sharing a room you have never paired with. */
  paired: boolean
  /** True for a member that is not a person. */
  machine?: boolean
}

/**
 * The level actually in force. A pin beats the room, the room beats the default,
 * and two things cap the result no matter what: someone you have not paired with
 * cannot exceed a notice, and neither can a member that is not a person.
 */
export function levelFor(person: string, ctx: Context, t: Trust = load()): Level {
  const pinned = t.people[person]
  const roomLevel = ctx.room ? t.rooms[ctx.room] : undefined
  let level: Level = pinned ?? roomLevel ?? (ctx.room ? ROOM_DEFAULT : t.default)
  if (!ctx.paired) level = lower(level, "notify")
  if (ctx.machine) level = lower(level, "notify")
  return level
}

export function isMuted(person: string, ctx: Context, t: Trust = load(), now = Date.now()): boolean {
  if ((t.muted[person] ?? 0) > now) return true
  if (ctx.room && (t.muted[`#${ctx.room}`] ?? 0) > now) return true
  return false
}
