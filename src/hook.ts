#!/usr/bin/env bun
// One hook for every client.
//
// Claude Code and Codex take the same hooks.json shape, the same event names and
// the same stdout protocol. Google's Antigravity CLI (agy) takes a different
// shape on both sides, so this file reads the payload to tell which one is
// calling and answers in that client's own format.
//
// What also differs is how a message reaches a running session. Claude Code
// exposes an inbox socket, so the daemon can put a notice into a session
// whenever it likes. Codex and agy have no such thing, but their hooks can add
// text to a turn, and both fire between tool calls, so a notice can arrive
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
 * Every client names the event, each in its own field. agy names it in none of
 * them, so hooks.json passes it as an argument instead.
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

/**
 * agy is the one client that speaks camelCase protojson, and conversationId is
 * the field it always sends. Claude Code and Codex send session_id. That one
 * difference is enough to pick the right output format below.
 */
const isAgy = typeof hook.conversationId === "string"

const sessionId: string | undefined =
  hook.session_id ??
  hook.sessionId ??
  hook.thread_id ??
  hook.conversation_id ??
  hook.conversationId ??
  process.env.CLAUDE_CODE_SESSION_ID ??
  process.env.ANTIGRAVITY_CONVERSATION_ID

/**
 * agy has no SessionStart. PreInvocation runs before every model call and
 * numbers them from zero, so the first one is where a session announces itself.
 */
const isSessionStart = isAgy
  ? /^PreInvocation$/i.test(eventName) && Number(hook.invocationNum ?? 0) === 0
  : /^SessionStart$/i.test(eventName)

/**
 * agy runs a hook in the directory holding hooks.json, not the project, so
 * process.cwd() is wrong for it. workspacePaths carries the real one. Failing
 * that, a hooks.json checked in at `<project>/.agents/` puts the project one
 * level up.
 */
const AGENT_DIRS = new Set([".agents", ".agent", "_agents", "_agent"])
function agyCwd(): string {
  const ws = hook.workspacePaths
  if (Array.isArray(ws) && typeof ws[0] === "string" && ws[0]) return ws[0]
  const here = process.cwd()
  if (AGENT_DIRS.has(path.basename(here))) return path.dirname(here)
  return here
}
const cwd: string = hook.cwd ?? (isAgy ? agyCwd() : process.cwd())

/** Nothing to do until someone has paired. */
if (!loadIdentity() || !sessionId) {
  process.stdout.write(JSON.stringify(isAgy ? {} : { continue: true }))
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
    // Codex names a thread and agy numbers a conversation; neither gives a name
    // worth showing, so fall back to the directory being worked in.
    name = hook.thread_name ?? (path.basename(cwd) || name)
  }
  await request({
    op: "register",
    sessionId,
    pid: process.ppid,
    name,
    cwd,
    socket: socket ?? "",
    transcript: hook.transcript_path ?? hook.transcriptPath,
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

/**
 * The same text, in whichever field the client actually reads.
 *
 * Claude Code, Codex and Qwen Code take hookSpecificOutput.additionalContext.
 * Kimi Code takes a plain `message` and wraps it in a <hook_result> tag itself.
 * agy takes steps and ignores every other key, so an empty object is how you
 * say nothing to it. Writing all of them costs nothing: a client that does not
 * know a field ignores it.
 */
const say = (extra?: string) => {
  if (isAgy) {
    process.stdout.write(JSON.stringify(extra ? { injectSteps: [{ ephemeralMessage: extra }] } : {}))
    process.exit(0)
  }
  const out: any = { continue: true }
  if (extra) {
    out.hookSpecificOutput = { hookEventName: eventName, additionalContext: extra }
    out.message = extra
  }
  process.stdout.write(JSON.stringify(out))
  process.exit(0)
}

// agy has no session-start event, so a session that began before the daemon did
// would never be known to it. Re-announcing on each model call is one call over
// a unix socket and keeps the roster right.
if (isAgy && !isSessionStart && /^PreInvocation$/i.test(eventName)) await registerSession()

if (isSessionStart) {
  await registerSession()
  // What the room already knows, so nobody explains it again. A session with no
  // inbox socket is only ever reached from here, so anything already waiting has
  // to come along too, or it would sit until the next event.
  try {
    const [f, t, n] = await Promise.all([
      request({ op: "facts", cwd }, 6000).catch(() => null),
      request({ op: "tasks" }, 6000).catch(() => null),
      socket ? Promise.resolve(null) : pendingNotice(),
    ])
    const parts = [f?.digest, t?.digest, n].filter(Boolean)
    say(parts.length ? parts.join("\n\n") : undefined)
  } catch {
    say()
  }
}

// Every other event is a chance to hand over anything waiting. The daemon
// returns nothing for a session it can push to directly.
say((await pendingNotice()) ?? undefined)
