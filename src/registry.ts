// Reads Claude Code's own session registry. This is what makes presence free:
// every session writes its cwd, status and socket path to
// ~/.claude/sessions/<pid>.json, and keeps updatedAt fresh.
//
// A registry entry proves a session existed, not that it is reachable — see
// spike/README.md. Long-lived sessions lose their socket to /tmp cleanup while
// still running, so callers that need reachability must probe.

import fs from "node:fs"
import net from "node:net"
import os from "node:os"
import path from "node:path"

export const SESSIONS = path.join(os.homedir(), ".claude", "sessions")

export type LocalSession = {
  pid: number
  sessionId: string
  name: string
  cwd: string
  status: string
  version: string
  socket: string
  updatedAt: number
}

export function listLocalSessions(): LocalSession[] {
  let files: string[]
  try {
    files = fs.readdirSync(SESSIONS).filter((f) => f.endsWith(".json"))
  } catch {
    return []
  }
  const out: LocalSession[] = []
  for (const f of files) {
    const pid = Number(f.slice(0, -5))
    if (!pid) continue
    try {
      process.kill(pid, 0)
    } catch {
      continue // process gone
    }
    try {
      const e = JSON.parse(fs.readFileSync(path.join(SESSIONS, f), "utf8"))
      if (!e.messagingSocketPath) continue
      if (!fs.existsSync(e.messagingSocketPath)) continue // socket swept
      out.push({
        pid: e.pid,
        sessionId: e.sessionId,
        name: e.name ?? `session-${e.pid}`,
        cwd: e.cwd ?? "",
        status: e.status ?? "unknown",
        version: e.version ?? "",
        socket: e.messagingSocketPath,
        updatedAt: e.updatedAt ?? 0,
      })
    } catch {
      continue
    }
  }
  return out.sort((a, b) => b.updatedAt - a.updatedAt)
}

export const findSession = (nameOrId: string): LocalSession | undefined => {
  const all = listLocalSessions()
  return (
    all.find((s) => s.sessionId === nameOrId) ??
    all.find((s) => s.name === nameOrId) ??
    all.find((s) => s.name.startsWith(nameOrId))
  )
}

/** Connect-probe a socket the way ListAgents does, to test reachability. */
export function reachable(socket: string, timeoutMs = 500): Promise<boolean> {
  return new Promise((resolve) => {
    const s = net.createConnection(socket)
    const done = (ok: boolean) => {
      s.destroy()
      resolve(ok)
    }
    s.setTimeout(timeoutMs, () => done(false))
    s.on("connect", () => done(true))
    s.on("error", () => done(false))
  })
}
