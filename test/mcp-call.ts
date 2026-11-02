#!/usr/bin/env bun
// One MCP tool call against crosstalk's server, over stdio, the way an agent
// makes it. Prints the result's text; exits 1 when the result is an error.
//
//   bun test/mcp-call.ts <crosstalk home> <session id> <tool> '<json arguments>' [cwd]

import { spawn } from "node:child_process"
import path from "node:path"

const [home, session, tool, args = "{}", cwd] = process.argv.slice(2)
if (!home || !session || !tool) {
  console.error("usage: bun test/mcp-call.ts <home> <session> <tool> '<json>' [cwd]")
  process.exit(2)
}
const child = spawn("bun", [path.join(import.meta.dir, "..", "src", "server.ts")], {
  env: { ...process.env, CROSSTALK_HOME: home, CLAUDE_CODE_SESSION_ID: session, ...(cwd ? { CLAUDE_PROJECT_DIR: cwd } : {}) },
  stdio: ["pipe", "pipe", "ignore"],
})
let rest = ""
const replies = new Map<number, any>()
child.stdout.on("data", (b) => {
  rest += b.toString("utf8")
  let i
  while ((i = rest.indexOf("\n")) !== -1) {
    const line = rest.slice(0, i).trim()
    rest = rest.slice(i + 1)
    try {
      const m = JSON.parse(line)
      if (typeof m.id === "number") replies.set(m.id, m)
    } catch {}
  }
})
const send = (o: unknown) => child.stdin.write(JSON.stringify(o) + "\n")
const wait = async (id: number, ms: number) => {
  for (const until = Date.now() + ms; Date.now() < until; await new Promise((r) => setTimeout(r, 50))) if (replies.has(id)) return replies.get(id)
  return undefined
}
send({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2024-11-05", capabilities: {}, clientInfo: { name: "probe", version: "1" } } })
await wait(1, 10_000)
send({ jsonrpc: "2.0", method: "notifications/initialized" })
send({ jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: tool, arguments: JSON.parse(args) } })
const r = await wait(2, 200_000)
child.kill()
if (!r) {
  console.log("no answer")
  process.exit(1)
}
console.log((r.result?.content ?? []).map((c: any) => c.text).join("\n") || JSON.stringify(r.error ?? r))
process.exit(r.result?.isError || r.error ? 1 : 0)
