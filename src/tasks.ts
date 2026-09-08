// A room's shared list of work.
//
// Facts are what a room knows. This is what it has agreed to do. Same storage
// shape, same sync, different lifecycle.
//
// The part that matters is claiming. Two agents working the same room will
// otherwise both pick up the same thing, so a task has to be claimed before it
// is worked, claiming is announced, and claiming something already claimed
// fails rather than racing.

import fs from "node:fs"
import path from "node:path"
import crypto from "node:crypto"
import { ROOT } from "./config.ts"

export type TaskState = "open" | "claimed" | "done"

export type Task = {
  id: string
  text: string
  by: string
  at: number
  /** Who it is meant for. Empty means anyone in the room. */
  for?: string
  state: TaskState
  claimedBy?: string
  claimedAt?: number
  doneBy?: string
  doneAt?: number
  /** What happened, written when it was finished. */
  note?: string
  tags: string[]
}

export type TaskStore = Record<string, Task[]>

const FILE = path.join(ROOT, "tasks.json")

export const newTaskId = () => "t_" + crypto.randomBytes(4).toString("hex")

export function load(): TaskStore {
  try {
    const raw = JSON.parse(fs.readFileSync(FILE, "utf8"))
    const out: TaskStore = {}
    for (const [room, list] of Object.entries(raw))
      if (Array.isArray(list)) out[room] = list.filter((t: any) => t?.id && t?.text)
    return out
  } catch {
    return {}
  }
}

export function save(s: TaskStore) {
  fs.mkdirSync(ROOT, { recursive: true, mode: 0o700 })
  const tmp = `${FILE}.tmp`
  fs.writeFileSync(tmp, JSON.stringify(s, null, 2), { mode: 0o600 })
  fs.renameSync(tmp, FILE)
}

export const openTasks = (room: string, s: TaskStore = load()) =>
  (s[room] ?? []).filter((t) => t.state !== "done")

export type TaskOp =
  | { op: "add"; task: Task }
  | { op: "claim"; id: string; by: string; at: number }
  | { op: "release"; id: string; by: string; at: number }
  | { op: "done"; id: string; by: string; at: number; note?: string }
  | { op: "drop"; id: string; by: string; at: number }

/**
 * Returns false when nothing changed, which for a claim means someone else got
 * there first. That is the whole point of claiming, so the caller should say so
 * rather than carrying on.
 */
export function apply(room: string, op: TaskOp, s: TaskStore = load()): boolean {
  const list = (s[room] ??= [])
  const find = (id: string) => list.find((t) => t.id === id)

  if (op.op === "add") {
    if (find(op.task.id)) return false
    list.push({ ...op.task, tags: op.task.tags ?? [], state: op.task.state ?? "open" })
    save(s)
    return true
  }

  const t = find(op.id)
  if (!t) return false

  if (op.op === "claim") {
    // Already claimed by someone else, and not by the person claiming now.
    if (t.state === "claimed" && t.claimedBy && t.claimedBy !== op.by) return false
    if (t.state === "done") return false
    t.state = "claimed"
    t.claimedBy = op.by
    t.claimedAt = op.at
    save(s)
    return true
  }

  if (op.op === "release") {
    if (t.claimedBy !== op.by) return false
    t.state = "open"
    delete t.claimedBy
    delete t.claimedAt
    save(s)
    return true
  }

  if (op.op === "done") {
    if (t.state === "done") return false
    t.state = "done"
    t.doneBy = op.by
    t.doneAt = op.at
    if (op.note) t.note = op.note
    save(s)
    return true
  }

  if (op.op === "drop") {
    s[room] = list.filter((x) => x.id !== op.id)
    save(s)
    return true
  }
  return false
}

/** Anything waiting for you, for the start of a session. */
export function waitingFor(
  who: string,
  rooms: string[],
  s: TaskStore = load(),
): { room: string; task: Task }[] {
  const out: { room: string; task: Task }[] = []
  for (const room of rooms)
    for (const t of openTasks(room, s))
      if (t.state === "open" && (!t.for || t.for === who)) out.push({ room, task: t })
      else if (t.state === "claimed" && t.claimedBy === who) out.push({ room, task: t })
  return out
}

export function digest(who: string, rooms: string[], s: TaskStore = load()): string | null {
  const mine = waitingFor(who, rooms, s)
  if (!mine.length) return null
  const lines = mine.slice(0, 10).map(({ room, task }) => {
    const state =
      task.state === "claimed" ? `you claimed this` : task.for ? `for you, from ${task.by}` : `open, from ${task.by}`
    return `- ${task.id}  ${task.text}  (${state}, #${room})`
  })
  return [
    `<crosstalk-tasks count="${mine.length}">`,
    `Work agreed in a room you are in. Claim one before starting it, so nobody`,
    `does the same thing twice, and say so when it is done.`,
    ``,
    ...lines,
    ...(mine.length > lines.length ? [``, `${mine.length - lines.length} more.`] : []),
    `</crosstalk-tasks>`,
  ].join("\n")
}
