// Working the board: "work through the open tasks".
//
// Off until the person turns it on, in their own words (crosstalk_work action
// "board", on: true); "stop working the board" turns it off. While on, every
// minute the daemon:
//
//   picks      the most pressing open task nobody has claimed, in a live thread
//              (in the threads named, when some were), skipping any that only
//              waits on something (src/attention/openitems.ts isWaiting)
//   claims     it in the thread, as the worker, so no other agent takes it
//   starts     a background agent on it in its own copy of the code, from the
//              thread's brief, told to mark it done and to ask, not guess,
//              where only the person can decide; never more than `max` at
//              once (2 unless said)
//   lets go    of a task whose agent has ended without marking it done: the
//              claim is noted on the task and it is not picked again by itself
//
// The agents follow crosstalk's shipping rules like any other: risky work goes
// through review and a flag, and nothing is deployed to production by them.

import fs from "node:fs"
import path from "node:path"
import { P } from "../config.ts"
import { isWaiting } from "./openitems.ts"

export type Running = { taskId: string; thread: string; agent: string; startedAt: number }
export type Prefs = { on: boolean; max: number; threads?: string[]; running: Running[]; tried?: string[] }

const file = () => path.join(P.root, "worker.json")
export const DEFAULT_MAX = 2
export const LABEL = "crosstalk worker"

export function read(): Prefs {
  try {
    const p = JSON.parse(fs.readFileSync(file(), "utf8"))
    return { on: !!p.on, max: Math.max(1, Math.min(4, Number(p.max) || DEFAULT_MAX)), ...(Array.isArray(p.threads) ? { threads: p.threads.map(String) } : {}), running: Array.isArray(p.running) ? p.running : [], tried: Array.isArray(p.tried) ? p.tried.slice(-200) : [] }
  } catch {
    return { on: false, max: DEFAULT_MAX, running: [], tried: [] }
  }
}

export function write(p: Prefs) {
  fs.mkdirSync(P.root, { recursive: true, mode: 0o700 })
  const tmp = `${file()}.${process.pid}.tmp`
  fs.writeFileSync(tmp, JSON.stringify(p), { mode: 0o600 })
  fs.renameSync(tmp, file())
}

export type OpenTask = { id: string; text: string; thread: string; threadId: string; at: number; claimedBy?: string; state: string; blocking?: boolean }

/**
 * The task to take next, if any. Investigations of failures first, then the
 * oldest. Pure.
 */
export function pick(tasks: OpenTask[], o: { threads?: string[]; tried: string[]; running: Running[] }): OpenTask | null {
  const want = o.threads?.map((t) => t.toLowerCase())
  const busy = new Set(o.running.map((r) => r.taskId))
  const ok = tasks.filter(
    (t) => t.state === "open" && !t.claimedBy && !busy.has(t.id) && !o.tried.includes(t.id) && !isWaiting(t.text) && (!want || want.includes(t.thread.toLowerCase())),
  )
  const investigation = (t: OpenTask) => /^investigate\b/i.test(t.text)
  return ok.sort((a, b) => Number(investigation(b)) - Number(investigation(a)) || a.at - b.at)[0] ?? null
}

/** The new agent's task: the thread's brief comes first (spawn adds it); this is what it is for. */
export function prompt(t: OpenTask): string {
  return [
    `You were started by crosstalk to work one open task of the thread "${t.thread}":`,
    ``,
    `  ${t.text}`,
    ``,
    `Do it in this copy of the code, test it, and ship it the way this repository ships (crosstalk_ship), never deploying to production yourself. When it is done, mark the task done: crosstalk_thread action "task" with op "done" and id "${t.id}". If it needs a decision only the person can make, ask once with crosstalk's question, then carry on with what does not depend on it. If it cannot be done, say why in a note on the task and stop.`,
  ].join("\n")
}

/** The line the person sees when turning it on or off, and the state now. */
export function describe(p: Prefs): string {
  if (!p.on) return `◢ crosstalk: not working the board. Say "work through the open tasks" to start.`
  const where = p.threads?.length ? ` in ${p.threads.join(", ")}` : ""
  const now = p.running.length ? ` Working on: ${p.running.map((r) => `${r.thread} (${r.agent})`).join(", ")}.` : " Nothing taken yet."
  return `◢ crosstalk: working through the open tasks${where}, at most ${p.max} agents at once, in the background.${now} Say "stop working the board" to stop.`
}
