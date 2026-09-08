#!/usr/bin/env bun
// The MCP server is the only surface some clients ever touch, so it is checked
// against the protocol rather than against any one client: speak JSON-RPC over
// stdio, and see that it initializes, lists its tools, and answers a call.
//
// Usage: bun test/mcp.ts <crosstalk home>

import { spawn } from "node:child_process"

const home = process.argv[2]
if (!home) {
  console.error("usage: bun test/mcp.ts <crosstalk home>")
  process.exit(2)
}

const child = spawn("bun", ["src/server.ts"], {
  env: { ...process.env, CROSSTALK_HOME: home, CLAUDE_CODE_SESSION_ID: "mcp-probe" },
  stdio: ["pipe", "pipe", "ignore"],
})

const replies = new Map<number, any>()
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
      if (typeof m.id === "number") replies.set(m.id, m)
    } catch {}
  }
})

const send = (o: unknown) => child.stdin.write(JSON.stringify(o) + "\n")
const waitFor = async (id: number, ms = 8000) => {
  const until = Date.now() + ms
  while (Date.now() < until) {
    if (replies.has(id)) return replies.get(id)
    await new Promise((r) => setTimeout(r, 50))
  }
  return undefined
}

let failed = 0
const ok = (m: string) => console.log(`  PASS  ${m}`)
const bad = (m: string) => {
  console.log(`  FAIL  ${m}`)
  failed = 1
}

send({
  jsonrpc: "2.0", id: 1, method: "initialize",
  params: { protocolVersion: "2024-11-05", capabilities: {}, clientInfo: { name: "probe", version: "1" } },
})
const init = await waitFor(1)
init?.result?.serverInfo ? ok("initializes and names itself") : bad("no initialize result")
init?.result?.capabilities?.tools ? ok("advertises tools") : bad("does not advertise tools")

send({ jsonrpc: "2.0", method: "notifications/initialized" })

send({ jsonrpc: "2.0", id: 2, method: "tools/list", params: {} })
const list = await waitFor(2)
const names: string[] = (list?.result?.tools ?? []).map((t: any) => t.name)
names.length ? ok(`lists ${names.length} tools`) : bad("listed no tools")
for (const want of ["crosstalk_send", "crosstalk_read", "crosstalk_peers", "crosstalk_facts"])
  names.includes(want) ? ok(`offers ${want}`) : bad(`missing ${want}`)

const schemas = (list?.result?.tools ?? []).every((t: any) => t.inputSchema?.type === "object")
schemas ? ok("every tool carries an object input schema") : bad("a tool has no input schema")

send({ jsonrpc: "2.0", id: 3, method: "tools/call", params: { name: "crosstalk_peers", arguments: {} } })
const call = await waitFor(3)
const text = call?.result?.content?.[0]?.text
typeof text === "string" ? ok("answers a tool call with content") : bad("tool call returned no content")

send({ jsonrpc: "2.0", id: 4, method: "tools/call", params: { name: "no_such_tool", arguments: {} } })
const boom = await waitFor(4)
boom && (boom.error || boom.result?.isError) ? ok("refuses a tool it does not have") : bad("accepted an unknown tool")

child.kill()
process.exit(failed)
