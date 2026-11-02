// Reads Claude Code's own session registry. This is what makes presence free:
// every session writes its cwd, status and socket path to
// ~/.claude/sessions/<pid>.json, and keeps updatedAt fresh.
//
// A registry entry proves a session existed, not that it is reachable, see
// spike/README.md. Long-lived sessions lose their socket to /tmp cleanup while
// still running, so callers that need reachability must probe.

import fs from "node:fs"
import net from "node:net"
import os from "node:os"
import path from "node:path"

/**
 * Claude Code's own directory: CLAUDE_CONFIG_DIR when it is set, else
 * ~/.claude. Read on every call, so a test or a caller that sets it later is
 * seen. Everything that reads the session registry goes through here.
 */
export const claudeConfigDir = (env: NodeJS.ProcessEnv = process.env): string =>
  env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), ".claude")

/** Where Claude Code writes one <pid>.json per running session. */
export const sessionsDir = (env: NodeJS.ProcessEnv = process.env): string => path.join(claudeConfigDir(env), "sessions")

/** The registry as it was resolved when this module loaded; prefer sessionsDir(). */
export const SESSIONS = sessionsDir()

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
  const dir = sessionsDir()
  let files: string[]
  try {
    files = fs.readdirSync(dir).filter((f) => f.endsWith(".json"))
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
      const e = JSON.parse(fs.readFileSync(path.join(dir, f), "utf8"))
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
