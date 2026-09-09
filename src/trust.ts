// What a source is allowed to do to you.
//
// This replaces three things that were describing one thing: a delivery mode, an
// allowAsk flag, and a branch in the daemon for someone sharing a room you never
// a direct channel to. One ordered level, where each step contains the ones below it.
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
  /** When neither applies. Someone in a room of two with you, in no particular room. */
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
    return { ...DEFAULT_TRUST, rooms: {}, people: {}, muted: {} }
  }
}

export function save(t: Trust) {
  fs.mkdirSync(ROOT, { recursive: true, mode: 0o700 })
  const tmp = `${FILE}.tmp`
  fs.writeFileSync(tmp, JSON.stringify(t, null, 2), { mode: 0o600 })
  fs.renameSync(tmp, FILE)
}

export type Context = {
  /** Room the message came through, without the hash, if any. */
  room?: string
  /** False for a room member this machine has no direct channel to. */
  direct: boolean
  /** True for a member that is not a person. */
  machine?: boolean
}

/**
 * The level actually in force. A pin beats the room, the room beats the default,
 * and two things cap the result no matter what: someone you share no channel with
 * cannot exceed a notice, and neither can a member that is not a person.
 */
export function levelFor(person: string, ctx: Context, t: Trust = load()): Level {
  const pinned = t.people[person]
  const roomLevel = ctx.room ? t.rooms[ctx.room] : undefined
  let level: Level = pinned ?? roomLevel ?? (ctx.room ? ROOM_DEFAULT : t.default)
  if (!ctx.direct) level = lower(level, "notify")
  if (ctx.machine) level = lower(level, "notify")
  return level
}

/**
 * Silence someone, or a `#room`, until a moment. Undefined lifts it.
 *
 * This writes the same map `isMuted` reads. It used to write a separate
 * policy.json that nothing consulted, so muting somebody did nothing at all.
 */
export function mute(who: string, until: number | undefined, t: Trust = load()): Trust {
  if (until && until > Date.now()) t.muted[who] = until
  else delete t.muted[who]
  save(t)
  return t
}

export function isMuted(person: string, ctx: Context, t: Trust = load(), now = Date.now()): boolean {
  if ((t.muted[person] ?? 0) > now) return true
  if (ctx.room && (t.muted[`#${ctx.room}`] ?? 0) > now) return true
  return false
}
