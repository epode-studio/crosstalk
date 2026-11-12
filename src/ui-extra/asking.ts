// An MCP server asking the person something in a session's own tab (Claude Code's elicitation dialog): kept
// per session while it is open, so main's pane can say that session is waiting on them, and what for.

import fs from "node:fs"
import path from "node:path"
import { P } from "../config.ts"

const dir = () => path.join(P.root, "asking")
const fileOf = (sessionId: string) => path.join(dir(), `${sessionId.replace(/[^A-Za-z0-9._-]/g, "_")}.json`)

/** The question, while it is open; null clears it (answered, declined or gone). */
export function noteAsking(sessionId: string, q: { server: string; text: string } | null, now = Date.now()) {
  try {
    if (!q) return fs.rmSync(fileOf(sessionId), { force: true })
    fs.mkdirSync(dir(), { recursive: true, mode: 0o700 })
    const clean = (s: string, n: number) => s.replace(/[\u0000-\u001f\u007f-\u009f]/g, " ").slice(0, n)
    fs.writeFileSync(fileOf(sessionId), JSON.stringify({ server: clean(q.server, 60), text: clean(q.text, 200), at: now }), { mode: 0o600 })
  } catch {}
}

/** What an MCP server is asking in that session's tab, if anything (a day at most: one left from a crash is stale). */
export function asking(sessionId: string, now = Date.now()): { server: string; text: string } | undefined {
  try {
    const o = JSON.parse(fs.readFileSync(fileOf(sessionId), "utf8"))
    if (now - Number(o.at) > 86_400_000) return undefined
    return { server: String(o.server), text: String(o.text) }
  } catch {
    return undefined
  }
}
