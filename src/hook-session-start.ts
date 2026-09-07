#!/usr/bin/env bun
// SessionStart hook. Starts the daemon if needed and registers this session,
// handing over its inbox socket and messaging token so the daemon can post as
// a verified own-child of the session rather than as an anonymous peer.

import path from "node:path"
import os from "node:os"
import { ensureDaemon, request } from "./client.ts"
import { rootFrom } from "./paths.ts"
import { loadIdentity } from "./config.ts"

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

if (!loadIdentity()) {
  console.log(JSON.stringify({ continue: true }))
  process.exit(0) // not paired yet; nothing to do
}

const root = rootFrom(import.meta.url)
if (!(await ensureDaemon(root))) {
  console.error("crosstalk: daemon would not start; see ~/.claude/crosstalk/daemon.log")
  process.exit(0)
}

const sessionId = hook.session_id ?? process.env.CLAUDE_CODE_SESSION_ID
const socket = process.env.CLAUDE_CODE_MESSAGING_SOCKET
if (!sessionId || !socket) process.exit(0)

const sessionsDir = path.join(os.homedir(), ".claude", "sessions")
let name = `session-${process.ppid}`
let cwd = hook.cwd ?? process.cwd()
try {
  const fs = await import("node:fs")
  for (const f of fs.readdirSync(sessionsDir)) {
    if (!f.endsWith(".json")) continue
    const e = JSON.parse(fs.readFileSync(path.join(sessionsDir, f), "utf8"))
    if (e.sessionId === sessionId) {
      name = e.name ?? name
      cwd = e.cwd ?? cwd
      break
    }
  }
} catch {}

await request({
  op: "register",
  sessionId,
  pid: process.ppid,
  name,
  cwd,
  socket,
  token: process.env.CLAUDE_CODE_MESSAGING_TOKEN,
  transcript: hook.transcript_path,
}).catch(() => {})
