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

const args = process.argv.slice(2)
/**
 * Kimi Code's payload is indistinguishable from Claude Code's, so the config
 * written by `crosstalk install kimi` names the client instead. Nothing else
 * needs one: every other client is recognisable from what it sends.
 */
const client = (() => {
  const i = args.indexOf("--client")
  return i === -1 ? "" : (args[i + 1] ?? "").toLowerCase()
})()
const positional = args.filter((a, i) => !a.startsWith("--") && args[i - 1] !== "--client")

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
  positional[0] ??
  "SessionStart"

/**
 * agy is the one client that speaks camelCase protojson, and conversationId is
 * the field it always sends. Claude Code and Codex send session_id. That one
 * difference is enough to pick the right output format below.
 */
const isAgy = typeof hook.conversationId === "string"
const isKimi = client === "kimi"

/**
 * Hermes names its events in snake_case and nobody else does, which is the
 * cheapest way to recognise it. It reads back a `context` string rather than
 * any of the fields the others use.
 */
const isHermes = /^(pre|post|on)_[a-z_]+$/.test(eventName)

/**
 * Goose names the event in `event` where everyone else uses hook_event_name,
 * and that is the whole difference in the payload. In the answer it is the odd
 * one out entirely: it reads a decision, never context. An object without a
 * `decision` key is not ignored there, it counts as the hook having failed.
 */
const isGoose = typeof hook.event === "string" && !hook.hook_event_name && !hook.hookEventName

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
/**
 * Where the working set goes on the first turn.
 *
 * agy has no session-start event, so its first PreInvocation stands in.
 * Hermes has one, but only pre_llm_call is read back for context, so its first
 * turn stands in too. It flags that itself, nested one level down.
 */
const isSessionStart = isAgy
  ? /^PreInvocation$/i.test(eventName) && Number(hook.invocationNum ?? 0) === 0
  : isHermes
    ? /^pre_llm_call$/.test(eventName) && hook.extra?.is_first_turn === true
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
const cwd: string = hook.cwd ?? hook.working_dir ?? (isAgy ? agyCwd() : process.cwd())

/**
 * Every event that can carry text to the model, and no others.
 *
 * Asking the daemon for a notice consumes it, so an event that cannot deliver
 * must not ask: it would take the notice and drop it. Three clients make this
 * concrete. Hermes reads a hook's answer on pre_llm_call and nowhere else.
 * Codex parses each event against its own schema with deny_unknown_fields,
 * where Stop has no hookSpecificOutput field at all, so a notice returned there
 * does not get ignored, it throws away the whole object it arrived in. And
 * Goose is the mirror image: Stop is the only event that puts anything in front
 * of its model, by refusing to let the turn end.
 */
const DELIVERS = isGoose
  ? /^Stop$/i
  : /^(SessionStart|UserPromptSubmit|PreToolUse|PostToolUse|PreInvocation|pre_llm_call)$/i

/** Nothing to do until someone has paired. */
if (!loadIdentity() || !sessionId) {
  process.stdout.write(
    JSON.stringify(
      isGoose ? { decision: "allow" } : isAgy || isHermes || isKimi ? {} : { continue: true },
    ),
  )
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
 * agy takes steps, Hermes takes a `context` string, Kimi Code takes a plain
 * `message` and wraps it in a <hook_result> tag itself.
 *
 * Goose has no way to add context at all. What it has is a Stop hook that can
 * refuse to let the turn end, and the reason it gives is put into the
 * conversation as a message the model reads and the user does not see. So on
 * Goose the text is the reason, and saying nothing has to be said as "allow":
 * an object it cannot find a decision in counts as the hook having failed.
 *
 * Each gets that field and nothing else. Writing several at once looks free but
 * is not: Codex parses its output with deny_unknown_fields, so one stray key
 * throws away the whole object and the message silently never arrives.
 */
const say = (extra?: string) => {
  if (isAgy) {
    process.stdout.write(JSON.stringify(extra ? { injectSteps: [{ ephemeralMessage: extra }] } : {}))
    process.exit(0)
  }
  if (isHermes) {
    process.stdout.write(JSON.stringify(extra ? { context: extra } : {}))
    process.exit(0)
  }
  if (isKimi) {
    process.stdout.write(JSON.stringify(extra ? { message: extra } : {}))
    process.exit(0)
  }
  if (isGoose) {
    process.stdout.write(
      JSON.stringify(extra ? { decision: "block", reason: extra } : { decision: "allow" }),
    )
    process.exit(0)
  }
  const out: any = { continue: true }
  if (extra) out.hookSpecificOutput = { hookEventName: eventName, additionalContext: extra }
  process.stdout.write(JSON.stringify(out))
  process.exit(0)
}

// Neither agy nor Hermes reliably announces a session at a moment this hook can
// also speak from, so both re-announce on every model call. It is one call over
// a unix socket, and it keeps the roster right for a session that started
// before the daemon did.
if (!isSessionStart && (/^PreInvocation$/i.test(eventName) || /^(pre_llm_call|on_session_start)$/.test(eventName)))
  await registerSession()

if (isSessionStart) {
  await registerSession()
  // Goose is the one client whose session start cannot carry text: only
  // PreToolUse and Stop are asked for a decision, and only a Stop refusal puts
  // anything in front of the model. So it registers here and waits, and its
  // messages arrive when a turn tries to end. It gets no working set.
  if (!DELIVERS.test(eventName)) say()
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

if (!DELIVERS.test(eventName)) say()

// Every remaining event is a chance to hand over anything waiting. The daemon
// returns nothing for a session it can push to directly.
say((await pendingNotice()) ?? undefined)
