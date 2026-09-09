// Rooms: shared spaces with a roster everyone can see, that members can add
// each other to.
//
// Three rules keep this from becoming an ungated inbound path:
//
//   1. You can only be added by someone you already share a channel with. A room
//      grows along links that already exist, so nobody reaches you out of
//      nowhere.
//   2. Being added creates an invitation, not membership. Nothing from the room
//      touches your session until you accept.
//   3. Room members you share no channel with are still strangers. Their
//      messages can notify you; they can never be delivered mid-turn and can
//      never use ask.
//
// Messages are sealed with a room key that the relay never sees. The inviter
// hands the key over the pairwise channel it already shares with the invitee.
// The relay knows who is in which room and how big the messages are. It cannot
// read one.

import fs from "node:fs"
import path from "node:path"
import crypto from "node:crypto"
import { ROOT } from "./config.ts"

const FILE = path.join(ROOT, "rooms.json")

export type Member = {
  fingerprint: string
  label: string
  addedBy: string
  addedAt: number
  state: "invited" | "joined"
}

export type Room = {
  id: string
  name: string
  /** Keys by epoch, base64. An epoch bump follows every removal. */
  keys: Record<number, string>
  epoch: number
  members: Record<string, Member>
  /** Set while we have been invited but have not answered. */
  pending?: { invitedBy: string; at: number }
  joinedAt?: number
}

export type RoomState = Record<string, Room>

const isRoomRecord = (v: unknown): v is Room =>
  !!v &&
  typeof v === "object" &&
  typeof (v as Room).id === "string" &&
  typeof (v as Room).name === "string" &&
  typeof (v as Room).members === "object"

/** Anything in the file that is not a well-formed room is dropped. */
export const load = (): RoomState => {
  try {
    const raw = JSON.parse(fs.readFileSync(FILE, "utf8")) as Record<string, unknown>
    const out: RoomState = {}
    for (const [k, v] of Object.entries(raw)) if (isRoomRecord(v)) out[k] = v
    return out
  } catch {
    return {}
  }
}

export function save(r: RoomState) {
  fs.mkdirSync(ROOT, { recursive: true, mode: 0o700 })
  const tmp = `${FILE}.tmp`
  fs.writeFileSync(tmp, JSON.stringify(r, null, 2), { mode: 0o600 })
  fs.renameSync(tmp, FILE)
}

export const newRoomId = () => crypto.randomBytes(8).toString("hex")
export const newRoomKey = () => crypto.randomBytes(32).toString("base64")

export const keyFor = (room: Room, epoch = room.epoch): Buffer | null => {
  const k = room.keys?.[epoch]
  return k ? Buffer.from(k, "base64") : null
}

export const normalise = (name: string) => String(name ?? "").trim().replace(/^#/, "").toLowerCase()
export const isRoom = (to: string) => to.startsWith("#")

/**
 * A direct channel with one person is a room of two. It is derived rather than stored:
 * both sides compute the same id from the two fingerprints, and the key is the
 * pairwise key they already share, so there is nothing to agree on and nothing
 * to go stale. Everything a person can be in is a room; some rooms happen to
 * have two people in them.
 */
export function oneToOneId(a: string, b: string): string {
  const pair = [a, b].sort().join("|")
  return (
    "1to1" +
    crypto.createHash("sha256").update("crosstalk/room/1to1|" + pair).digest("hex").slice(0, 12)
  )
}

export type AnyRoom = {
  id: string
  name: string
  kind: "direct" | "shared"
  pending?: { invitedBy: string; at: number } | null
  members: { label: string; state: "invited" | "joined"; direct: boolean; you: boolean }[]
}

/** Find a joined room by its human name, which is unique on this machine. */
export function byName(name: string, state = load()): Room | undefined {
  const n = normalise(name)
  return Object.values(state).find((r) => normalise(r.name) === n && !r.pending)
}

export function upsert(room: Room, state = load()): RoomState {
  state[room.id] = room
  save(state)
  return state
}
