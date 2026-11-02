// What crosstalk's mod shows a person, and what became of each thing.
//
// The mod (mod/register.tsx) draws cards, pickers and the status line, but it
// keeps nothing: Claude Code's $.state is gone after a restart or --resume, and
// a card offered twice is a message handed over twice. So every item the mod
// shows lives here, with an id and a state, and an item that was handed over,
// muted or answered stays that way across restarts of the session, the mod or
// the daemon.
//
//   pending  ─┬─ hand ──▶ handed     (the agent has it)
//             ├─ answer ▶ answered   (a picker answered: restore, route, reply)
//             ├─ mute ──▶ muted
//             └─ later ─▶ later ─── (raised again after the person's next turn)
//
// handed, answered and muted are final. Acting on a final item does nothing and
// says so, which is what stops a resumed session handing a message over twice.
//
// One file, one lock. The daemon writes the items it owns (messages, route
// questions) and the hook writes the restore offer, which has to work with no
// daemon at all: after a restart, the daemon may not be running, and without a
// room it never runs. Every write is a read-modify-write under the lock, so
// neither ever overwrites the other's.
//
// The mod tells the hook it is there by leaving a marker for its session
// (markModActive) before the SessionStart hook runs. The hook then puts the
// restore offer here instead of in a systemMessage, so exactly one of the two
// ever shows.

import fs from "node:fs"
import path from "node:path"
import { P } from "./config.ts"
import * as metrics from "./metrics/log.ts"

export type UiKind = "restore" | "message" | "ask" | "route" | "gather" | "team" | "cleanup" | "thread" | "ship" | "rule" | "connect" | "conflict" | "invite" | "doctor" | "disk" | "install" | "attention" | "steer"
export type UiState = "pending" | "answered" | "handed" | "muted" | "later"
export type UiAction = "hand" | "answer" | "mute" | "later" | "raised" | "unhand"

export const FINAL: ReadonlySet<UiState> = new Set(["answered", "handed", "muted"])

export type Chip = { kind: string; label: string; bytes?: number }

export type UiItem = {
  /** `restore:<session>`, `msg:<held id>`, `route:<unrouted id>`. */
  id: string
  kind: UiKind
  /** The session it is shown in. A held message carried to a new session moves with it. */
  sessionId: string
  state: UiState
  createdAt: number
  updatedAt: number
  /** When the picker for it was last raised, or it was put off: it waits for a turn to end after this. */
  raisedAt?: number
  /** What the person picked or typed, kept for the record. Never shown to a model. */
  answer?: string
  // What the mod draws. Message text is the peer's, and only the mod and the
  // person ever see it, until it is handed over.
  from?: string
  thread?: string
  text?: string
  chips?: Chip[]
  /** The question, for a picker; options are the picker's labels. */
  question?: string
  options?: string[]
  /** restore: how many sessions, and their names. route: the candidate sessions. */
  count?: number
  names?: string[]
  /** route: each option's session id, so a session renamed meanwhile is still the one picked. */
  targets?: Record<string, string>
  ts?: number
  /** message: about this session's own thread, so the mod hands it to the agent without asking. */
  auto?: boolean
}

type File = { v: 1; items: Record<string, UiItem> }

const file = () => path.join(P.root, "ui.json")
const lockDir = () => path.join(P.root, "ui.lock")
const markers = () => path.join(P.root, "ui-mod")
const safe = (id: string) => id.replace(/[^A-Za-z0-9._-]/g, "_")

const WEEK = 7 * 24 * 60 * 60 * 1000

function read(): File {
  try {
    const f = JSON.parse(fs.readFileSync(file(), "utf8"))
    if (f && f.v === 1 && f.items && typeof f.items === "object") return f
  } catch {}
  return { v: 1, items: {} }
}

function write(f: File) {
  fs.mkdirSync(P.root, { recursive: true, mode: 0o700 })
  const tmp = `${file()}.${process.pid}.tmp`
  fs.writeFileSync(tmp, JSON.stringify(f, null, 2), { mode: 0o600 })
  fs.renameSync(tmp, file())
}

const sleepSync = (ms: number) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms)

/**
 * Run `fn` over the store under the lock and write back what it left. A lock
 * older than ten seconds belonged to a process that died holding it.
 */
export function withStore<T>(fn: (items: Record<string, UiItem>, now: number) => T): T {
  fs.mkdirSync(P.root, { recursive: true, mode: 0o700 })
  let held = false
  for (let i = 0; i < 200 && !held; i++) {
    try {
      fs.mkdirSync(lockDir())
      held = true
    } catch {
      try {
        if (Date.now() - fs.statSync(lockDir()).mtimeMs > 10_000) fs.rmdirSync(lockDir())
      } catch {}
      sleepSync(10)
    }
  }
  try {
    const f = read()
    const was = JSON.stringify(f)
    const now = Date.now()
    const out = fn(f.items, now)
    for (const [id, it] of Object.entries(f.items))
      if ((FINAL.has(it.state) && now - it.updatedAt > WEEK) || now - it.updatedAt > 4 * WEEK) delete f.items[id]
    // Polled every second: only a change is written.
    if (JSON.stringify(f) !== was) write(f)
    return out
  } finally {
    if (held)
      try {
        fs.rmdirSync(lockDir())
      } catch {}
  }
}

/** Read without the lock: a rename makes every write whole. */
export function snapshot(): Record<string, UiItem> {
  return read().items
}

/**
 * Add an item unless one with its id exists. An existing item keeps its state,
 * so syncing the daemon's queue again never brings back a card. A pending one
 * may move to another session (its message was carried over) and take fresher
 * display fields.
 */
export function upsert(items: Record<string, UiItem>, it: Omit<UiItem, "state" | "createdAt" | "updatedAt">, now: number): UiItem {
  const before = items[it.id]
  if (!before) {
    if (metrics.QUESTION_KINDS.has(it.kind)) metrics.record({ k: "asked", at: now, id: it.id, kind: it.kind, ...(it.thread ? { thread: it.thread } : {}) })
    return (items[it.id] = { ...it, state: "pending", createdAt: now, updatedAt: now })
  }
  if (FINAL.has(before.state)) return before
  const moved = before.sessionId !== it.sessionId
  items[it.id] = {
    ...before,
    ...it,
    state: before.state,
    raisedAt: moved ? undefined : before.raisedAt,
    createdAt: before.createdAt,
    updatedAt: moved ? now : before.updatedAt,
  }
  return items[it.id]
}

export type ActResult = { ok: true; item: UiItem } | { ok: false; error: string; item?: UiItem }

/** One step of the state machine. Final states take no further step. */
export function act(items: Record<string, UiItem>, id: string, action: UiAction, now: number, answer?: string): ActResult {
  const it = items[id]
  if (!it) return { ok: false, error: `nothing waiting with id ${id}` }
  if (FINAL.has(it.state)) return { ok: false, error: `already ${it.state}`, item: it }
  const next: UiItem = { ...it, updatedAt: now }
  switch (action) {
    case "raised":
      next.raisedAt = now
      break
    case "later":
      next.state = "later"
      next.raisedAt = now
      break
    case "hand":
      if (it.kind !== "message" && it.kind !== "ask") return { ok: false, error: `a ${it.kind} cannot be handed over`, item: it }
      next.state = "handed"
      break
    case "mute":
      next.state = "muted"
      break
    case "answer":
      next.state = "answered"
      if (answer !== undefined) next.answer = answer
      if (metrics.QUESTION_KINDS.has(it.kind))
        metrics.record({ k: "answered", at: now, id, kind: it.kind, openMs: now - (it.raisedAt ?? it.createdAt), ...(it.thread ? { thread: it.thread } : {}) })
      break
    default:
      return { ok: false, error: `unknown action ${action}`, item: it }
  }
  items[id] = next
  return { ok: true, item: next }
}

/** Mark an item final from outside the mod: a message the agent read, a route answered elsewhere. */
export function settle(items: Record<string, UiItem>, id: string, state: "answered" | "handed" | "muted", now: number) {
  const it = items[id]
  if (it && !FINAL.has(it.state)) items[id] = { ...it, state, updatedAt: now }
}

/**
 * Undo a claim whose effect failed (the route named a session that has gone,
 * the reply could not be sent), so the person can try again.
 */
export function reopen(items: Record<string, UiItem>, id: string, now: number) {
  const it = items[id]
  if (it) items[id] = { ...it, state: "pending", answer: undefined, updatedAt: now }
}

/** What is still waiting on the person in one session, oldest first. */
export function openFor(items: Record<string, UiItem>, sessionId: string): UiItem[] {
  return Object.values(items)
    .filter((i) => i.sessionId === sessionId && !FINAL.has(i.state))
    .sort((a, b) => a.createdAt - b.createdAt)
}

/**
 * Whether the mod may raise this item's picker by itself now.
 *
 * A picker takes the keyboard, so it comes up only when the prompt is empty and
 * no turn runs. It comes up once by itself. Raised before (in this process or a
 * previous one) or put off with Later, it waits until a turn of the person's
 * has ended since, so a resumed session never pops an old question up while
 * the person starts typing.
 */
export function raisable(it: UiItem, o: { idle: boolean; promptEmpty: boolean; lastTurnEnd: number }): boolean {
  if (FINAL.has(it.state) || !o.idle || !o.promptEmpty) return false
  if (it.raisedAt === undefined) return it.state === "pending"
  return o.lastTurnEnd > it.raisedAt
}

// --- the mod's marker ---------------------------------------------------------

/** How long a marker counts: a session start is seconds, a stale one is from an old process. */
const MARKER_MS = 10 * 60 * 1000

export function markModActive(sessionId: string) {
  fs.mkdirSync(markers(), { recursive: true, mode: 0o700 })
  fs.writeFileSync(path.join(markers(), safe(sessionId)), String(Date.now()), { mode: 0o600 })
}

export function modActive(sessionId: string, now = Date.now()): boolean {
  try {
    return now - fs.statSync(path.join(markers(), safe(sessionId))).mtimeMs < MARKER_MS
  } catch {
    return false
  }
}

/** Remove markers nobody will read again. */
export function pruneMarkers(now = Date.now()) {
  try {
    for (const f of fs.readdirSync(markers())) {
      const p = path.join(markers(), f)
      try {
        if (now - fs.statSync(p).mtimeMs > WEEK) fs.unlinkSync(p)
      } catch {}
    }
  } catch {}
}

// --- restore -------------------------------------------------------------------

export const restoreId = (sessionId: string) => `restore:${sessionId}`

/**
 * Where the restore offer goes, given the text the hook claimed for this
 * session: into a picker item when the mod is there (and nothing for the
 * systemMessage), else the systemMessage. Exactly one, never both.
 */
export function restoreSurface(
  sessionId: string,
  offer: { text: string; count: number; names: string[]; restart?: boolean } | null,
): { systemMessage?: string; item?: UiItem } {
  if (!offer) return {}
  if (!modActive(sessionId)) return { systemMessage: offer.text }
  const n = offer.count
  const when = offer.restart === false ? (n === 1 ? "that was cut off" : "that were cut off") : "from before the restart"
  // The offer is claimed already: if the store cannot take it, the systemMessage must.
  try {
    return { item: storeRestore(sessionId, offer, n, when) }
  } catch {
    return { systemMessage: offer.text }
  }
}

// --- gather --------------------------------------------------------------------

export const gatherId = (sessionId: string) => `gather:${sessionId}`
export const GATHER_OPTIONS = ["Bring them in", "Not now"]

/**
 * Where the offer to bring in sessions started before crosstalk goes: the
 * mod's picker when the mod is in this session, else the systemMessage.
 * Exactly one, never both, as for restore.
 */
export function gatherSurface(
  sessionId: string,
  offer: { text: string; question: string; count: number; names: string[] } | null,
  mod = modActive(sessionId),
): { systemMessage?: string; item?: UiItem } {
  if (!offer) return {}
  if (!mod) return { systemMessage: offer.text }
  try {
    return {
      item: withStore((items, now) =>
        upsert(
          items,
          {
            id: gatherId(sessionId),
            kind: "gather",
            sessionId,
            count: offer.count,
            names: offer.names,
            question: offer.question,
            options: GATHER_OPTIONS,
          },
          now,
        ),
      ),
    }
  } catch {
    return { systemMessage: offer.text }
  }
}

function storeRestore(sessionId: string, offer: { count: number; names: string[] }, n: number, when: string): UiItem {
  return withStore((items, now) =>
    upsert(
      items,
      {
        id: restoreId(sessionId),
        kind: "restore",
        sessionId,
        count: n,
        names: offer.names,
        question: `Restore ${n} session${n === 1 ? "" : "s"} ${when}? (${offer.names.join(", ")})`,
        options: ["Restore", "Open as windows", "Not now"],
      },
      now,
    ),
  )
}
