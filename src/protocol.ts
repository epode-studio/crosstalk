// Wire types. Two layers: a Frame the relay can route, and an Envelope only
// the two ends can read. The relay sees fingerprints and byte counts.

export type Intent = "fyi" | "question" | "blocking"
export type Kind =
  | "message"
  | "handoff"
  | "ask"
  | "answer"
  | "decision"
  | "presence"
  | "room_key"
  | "fact"
  | "fact_sync"
  | "task"
  | "task_sync"

export type Slice = {
  kind: "diff" | "file" | "turns" | "text"
  label: string
  content: string
  bytes: number
  sha256: string
}

export type Envelope = {
  v: 1
  id: string
  ts: number
  /** Sender's label and session name, e.g. "paul" and "hardware". */
  from: string
  fromSession: string
  /** Subagent or teammate that composed this, if not the main conversation. */
  fromAgent?: string
  /** Target label, and optionally one session name. Empty means any session. */
  to: string
  toSession?: string
  kind: Kind
  intent: Intent
  text: string
  slices?: Slice[]
  thread?: string
  replyTo?: string
  /** Room this was fanned out to, as the sender named it locally. */
  room?: string
  /** ask/answer correlation. */
  correlation?: string
  /** Presence payload, only on kind === "presence". */
  presence?: SessionPresence[]
  /** A working-set operation, on kind "fact", or a set of them on "fact_sync". */
  fact?: unknown
  /** A task operation, on kind "task", or a set of them on "task_sync". */
  task?: unknown
}

export type SessionPresence = {
  name: string
  cwd: string
  status: string
  lastSeen: number
}

/** What the relay routes. `body` is a sealed Envelope. */
export type Frame =
  | { t: "challenge"; nonce: string }
  | { t: "auth"; pub: string; sig: string; label: string }
  | { t: "ready"; fingerprint: string }
  | { t: "error"; message: string }
  | { t: "send"; to: string; body: string; id: string }
  | { t: "deliver"; from: string; body: string; id: string }
  | { t: "ack"; id: string }
  | { t: "presence"; peers: string[] }
  | { t: "room"; room: RoomRoster }
  | { t: "rooms"; rooms: RoomRoster[] }
  | { t: "room_gone"; roomId: string }
  | { t: "room_deliver"; roomId: string; from: string; body: string; id: string }
  | { t: "ping" }
  | { t: "pong" }

/** A room's membership as the relay reports it. It never sees the room key. */
export type RoomRoster = {
  id: string
  name: string
  members: { fingerprint: string; label: string; addedBy: string; state: string }[]
}

export const line = (o: unknown) => JSON.stringify(o) + "\n"

export function* lines(buffer: { rest: string }, chunk: string): Generator<unknown> {
  buffer.rest += chunk
  let i: number
  while ((i = buffer.rest.indexOf("\n")) !== -1) {
    const raw = buffer.rest.slice(0, i)
    buffer.rest = buffer.rest.slice(i + 1)
    if (!raw.trim()) continue
    try {
      yield JSON.parse(raw)
    } catch {
      // A malformed line is dropped rather than killing the connection.
    }
  }
}
