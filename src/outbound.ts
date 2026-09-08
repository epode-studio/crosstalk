// What your agent may send without being asked.
//
// Unprompted messages are the difference between a messaging tool and something
// that coordinates on its own. The risk is not cost, it is an agent that tells
// you everything, because then you stop reading. So an agent gets a small budget
// per peer per hour, and every unprompted message has to say why it affects the
// person receiving it.

import fs from "node:fs"
import path from "node:path"
import { ROOT } from "./config.ts"

const FILE = path.join(ROOT, "outbound.json")
const WINDOW_MS = 60 * 60_000

/** Per peer, per hour. Small on purpose: it forces the agent to choose. */
export const UNPROMPTED_PER_HOUR = Number(process.env.CROSSTALK_UNPROMPTED_PER_HOUR ?? 5)

type Log = Record<string, number[]>

const read = (): Log => {
  try {
    return JSON.parse(fs.readFileSync(FILE, "utf8"))
  } catch {
    return {}
  }
}

const write = (l: Log) => {
  try {
    fs.mkdirSync(ROOT, { recursive: true, mode: 0o700 })
    fs.writeFileSync(FILE, JSON.stringify(l), { mode: 0o600 })
  } catch {}
}

export function remaining(peer: string, now = Date.now()): number {
  const recent = (read()[peer] ?? []).filter((t) => now - t < WINDOW_MS)
  return Math.max(0, UNPROMPTED_PER_HOUR - recent.length)
}

/** Records the send, or refuses when the budget is gone. */
export function spend(peer: string, now = Date.now()): { ok: boolean; left: number } {
  const log = read()
  const recent = (log[peer] ?? []).filter((t) => now - t < WINDOW_MS)
  if (recent.length >= UNPROMPTED_PER_HOUR) return { ok: false, left: 0 }
  recent.push(now)
  log[peer] = recent
  write(log)
  return { ok: true, left: UNPROMPTED_PER_HOUR - recent.length }
}
