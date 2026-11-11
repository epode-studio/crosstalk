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
  | "thread"
  | "heads-up"
  | "conflict"
  | "rules"
  | "sessions_req"
  | "sessions_res"
  | "share"
  | "share_data"

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
  /**
   * A notice the sender's crosstalk wrote by itself (a PR merged, checks failed), not a person's words:
   * kept in the receiver's Lately, never put to them as a message.
   */
  notice?: boolean
  /** Presence payload, only on kind === "presence". */
  presence?: SessionPresence[]
  /** A working-set operation, on kind "fact", or a set of them on "fact_sync". */
  fact?: unknown
  /** A task operation, on kind "task", or a set of them on "task_sync". */
  task?: unknown
  /**
   * What the sending session is working on: repo remote, branch and the paths
   * it touched most recently. The receiver routes by it. Sealed with the rest
   * of the envelope, so the relay never sees it, and a peer that predates it
   * ignores it and routes the old way.
   */
  footprint?: FootprintSummary
  /**
   * Thread ids the sending session is in, or the threads a message with no
   * named recipient was sent to. The receiver delivers to its own sessions in
   * those threads first. Sealed like everything else here.
   */
  threads?: string[]
  /** A thread's state and content key, on kind "thread" (src/threads/service.ts). */
  threadSync?: unknown
  /** A heads-up or a conflict about an edit, on kind "heads-up" and "conflict" (src/warn/service.ts). */
  warn?: unknown
  /** A repo's standing rules and their key, on kind "rules" (src/rules/doc.ts). */
  rules?: unknown
  /**
   * A request about sessions on one of your own machines, and its answer, on
   * kinds "sessions_req" and "sessions_res" (src/sessions/remote.ts). Only
   * ever accepted from your own machines.
   */
  sessions?: unknown
  /**
   * A running server shared with a teammate (src/share/): an offer, a
   * revocation or a decline on kind "share", one HTTP frame on "share_data".
   * Direct channels only.
   */
  share?: unknown
}

export type FootprintSummary = { repo?: string; branch?: string; paths?: string[] }

export type SessionPresence = {
  name: string
  cwd: string
  status: string
  lastSeen: number
  /** What the session is working on, so a peer's thread can find it. Absent outside a repo. */
  footprint?: FootprintSummary
  /** Its thread ids. Present (maybe empty) only from a daemon that knows threads. */
  threads?: string[]
}

/** What the relay routes. `body` is a sealed Envelope. */
export type Frame =
  | { t: "challenge"; nonce: string }
  | { t: "auth"; pub: string; sig: string; label: string }
  | { t: "ready"; fingerprint: string }
  | { t: "error"; message: string }
  | { t: "send"; to: string; body: string; id: string }
  /** Like send, for a live peer only: never buffered, never acked, a budget of its own (src/share/). */
  | { t: "stream"; to: string; body: string; id: string }
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

/**
 * A name a sender chose (their session, a thread, a room), cut to a short
 * plain charset: letters, digits, space and `._-@:`, and a leading `#`. It ends up in notices,
 * tag attributes and cards on the receiving side, so nothing that could close
 * a tag, start a line or pass for markup survives. Empty or not a string is
 * undefined.
 */
export function cleanName(v: unknown, max = 64): string | undefined {
  if (typeof v !== "string") return undefined
  const s = v
    .normalize("NFKC")
    .replace(/[^\p{L}\p{N} ._#@:-]+/gu, "-")
    .replace(/\s+/g, " ")
    .trim()
    // A room's leading # is its own; anywhere else it could pass for a heading.
    .replace(/(?!^)#/g, "-")
    .slice(0, max)
    .trim()
  return s || undefined
}

/** Clean an inbound envelope's sender-chosen names in place, on receipt. */
export function cleanEnvelope(env: Envelope): Envelope {
  if (!env || typeof env !== "object") return env
  env.fromSession = cleanName(env.fromSession) ?? "-"
  if (env.fromAgent !== undefined) env.fromAgent = cleanName(env.fromAgent)
  if (env.thread !== undefined) env.thread = cleanName(env.thread)
  if (env.room !== undefined) env.room = cleanName(env.room)
  if (env.toSession !== undefined) env.toSession = cleanName(env.toSession)
  if (Array.isArray(env.threads)) env.threads = env.threads.map((t) => cleanName(t)).filter((t): t is string => !!t)
  return env
}
