#!/usr/bin/env bun
// A stand-in for the Claude Code process that starts crosstalk's MCP server.
//
//   bun test/channel-host.ts <crosstalk home> <session id> <out dir> [claude flags...]
//
// The server decides whether channel push is on from its parent's command line
// (src/channels.ts), and this process is that parent, so the flags after the
// first three arguments are what it sees: run it with
// `--dangerously-load-development-channels server:crosstalk` for a session with
// channels on, and with nothing for one without. It does the MCP handshake and
// appends every notifications/claude/channel it receives to <out>/channel.txt,
// and the server's stderr to <out>/server.log, until it is killed.

import { spawn } from "node:child_process"
import fs from "node:fs"
import path from "node:path"

const [home, sessionId, out] = process.argv.slice(2)
if (!home || !sessionId || !out) {
  console.error("usage: bun test/channel-host.ts <crosstalk home> <session id> <out dir> [claude flags...]")
  process.exit(2)
}
fs.mkdirSync(out, { recursive: true })
const channelLog = path.join(out, "channel.txt")
fs.writeFileSync(channelLog, "")
const env = { ...process.env, CROSSTALK_HOME: home, CLAUDE_CODE_SESSION_ID: sessionId }
delete env.CLAUDE_PLUGIN_ROOT
delete env.CROSSTALK_CHANNELS

const child = spawn("bun", [path.join(import.meta.dir, "..", "src", "server.ts")], {
  env,
  stdio: ["pipe", "pipe", fs.openSync(path.join(out, "server.log"), "a")],
})
let rest = ""
child.stdout.on("data", (b) => {
  rest += b.toString("utf8")
  let i
  while ((i = rest.indexOf("\n")) !== -1) {
    const line = rest.slice(0, i).trim()
    rest = rest.slice(i + 1)
    if (!line) continue
    try {
      const m = JSON.parse(line)
      if (m.method === "notifications/claude/channel") fs.appendFileSync(channelLog, JSON.stringify(m.params) + "\n")
    } catch {}
  }
})
const send = (o: unknown) => child.stdin.write(JSON.stringify(o) + "\n")
send({
  jsonrpc: "2.0", id: 0, method: "initialize",
  params: { protocolVersion: "2025-11-25", capabilities: { roots: { listChanged: true } }, clientInfo: { name: "claude-code", version: "test" } },
})
setTimeout(() => send({ jsonrpc: "2.0", method: "notifications/initialized" }), 300)
const stop = () => { child.kill(); process.exit(0) }
process.on("SIGTERM", stop)
process.on("SIGINT", stop)
child.on("exit", () => process.exit(0))
