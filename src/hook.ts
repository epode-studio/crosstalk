#!/usr/bin/env bun
// One hook for both clients.
//
// Claude Code and Codex take the same hooks.json shape, the same event names and
// the same stdout protocol, so a single binary serves both. What differs is how
// a message reaches a running session.
//
// Claude Code exposes an inbox socket, so the daemon can put a notice into a
// session whenever it likes. Codex has no such thing, but its hooks can add text
// to a turn, and PostToolUse fires between tool calls, so a notice can arrive
// mid-turn there too. The daemon decides: a session that registered a socket is
// pushed to, a session without one pulls here instead. Neither does both.

import path from "node:path"
import os from "node:os"
import fs from "node:fs"
import { ensureDaemon, request } from "./client.ts"
import { loadIdentity } from "./config.ts"
import { rootFrom } from "./paths.ts"

const input = await new Promise<string>((resolve) => {
  let raw = ""
  if (process.stdin.isTTY) return resolve("")
  process.stdin.setEncoding("utf8")
  process.stdin.on("data", (d) => (raw += d))
  process.stdin.on("end", () => resolve(raw))
  process.stdin.on("error", () => resolve(""))
  setTimeout(() => resolve(raw), 2000)
})

let hook: any = {}
try {
  hook = JSON.parse(input || "{}")
} catch {}

/**
 * Every client names the event, each in its own field. Claude Code, Codex and
 * Gemini CLI all take the same output shape, so once the name is known the rest
 * of this file does not care which one it is talking to.
 */
const eventName: string =
  hook.hook_event_name ??
  hook.hookEventName ??
  hook.event_name ??
  hook.hook_event?.type ??
  hook.event_type ??
  hook.event ??
  process.argv[2] ??
  "SessionStart"

/** Gemini calls its turn start BeforeAgent, Claude Code calls it UserPromptSubmit. */
const isSessionStart = /^SessionStart$/i.test(eventName)

const sessionId: string | undefined =
  hook.session_id ??
  hook.sessionId ??
  hook.thread_id ??
  hook.conversation_id ??
  process.env.CLAUDE_CODE_SESSION_ID
const cwd: string = hook.cwd ?? process.cwd()

/** Nothing to do until someone has paired. */
if (!loadIdentity() || !sessionId) {
  process.stdout.write(JSON.stringify({ continue: true }))
  process.exit(0)
}

const root = rootFrom(import.meta.url)

// Claude Code hands every hook the session's inbox socket. Codex has none, and
// that absence is what tells the daemon to hold messages for the hook to pull.
const socket = process.env.CLAUDE_CODE_MESSAGING_SOCKET

async function registerSession() {
  if (!(await ensureDaemon(root))) return
  let name = `session-${process.ppid}`
  if (socket) {
    // Claude Code publishes a registry we can read a proper name and cwd from.
    try {
      const dir = path.join(os.homedir(), ".claude", "sessions")
      for (const f of fs.readdirSync(dir)) {
        if (!f.endsWith(".json")) continue
        const e = JSON.parse(fs.readFileSync(path.join(dir, f), "utf8"))
        if (e.sessionId === sessionId) {
          name = e.name ?? name
          break
        }
      }
    } catch {}
  } else {
    // Codex names a thread rather than a session; fall back to the directory.
    name = hook.thread_name ?? (path.basename(cwd) || name)
  }
  await request({
    op: "register",
    sessionId,
    pid: process.ppid,
    name,
    cwd,
    socket: socket ?? "",
    transcript: hook.transcript_path,
  }).catch(() => {})
}

/** Anything waiting, phrased as a notice with none of the sender's words in it. */
async function pendingNotice(): Promise<string | null> {
  try {
    const r = await request({ op: "notices", sessionId }, 4000)
    return r?.notice ?? null
  } catch {
    return null
  }
}

const say = (extra?: string) => {
  const out: any = { continue: true }
  if (extra)
    out.hookSpecificOutput = { hookEventName: eventName, additionalContext: extra }
  process.stdout.write(JSON.stringify(out))
  process.exit(0)
}

if (isSessionStart) {
  await registerSession()
  // What the room already knows, so nobody explains it again.
  try {
    const [f, t] = await Promise.all([
      request({ op: "facts", cwd }, 6000).catch(() => null),
      request({ op: "tasks" }, 6000).catch(() => null),
    ])
    const parts = [f?.digest, t?.digest].filter(Boolean)
    say(parts.length ? parts.join("\n\n") : undefined)
  } catch {
    say()
  }
}

// Every other event is a chance to hand over anything waiting. The daemon
// returns nothing for a session it can push to directly.
say((await pendingNotice()) ?? undefined)
