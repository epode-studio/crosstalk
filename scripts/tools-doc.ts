// Regenerates docs/tools.md from the MCP server itself, so the reference cannot
// drift from what the server actually advertises. Run it after changing a tool.
//
//   bun scripts/tools-doc.ts

import fs from "node:fs"
import path from "node:path"
import { spawn } from "node:child_process"

const ROOT = path.resolve(import.meta.dir, "..")
const OUT = path.join(ROOT, "docs/tools.md")

type Tool = { name: string; description?: string; inputSchema?: { properties?: Record<string, unknown>; required?: string[] } }

const tools = await new Promise<Tool[]>((resolve, reject) => {
  const p = spawn("bun", [path.join(ROOT, "src/server.ts")], {
    cwd: ROOT,
    env: { ...process.env, CROSSTALK_HOME: fs.mkdtempSync("/tmp/ct-doc-") },
    stdio: ["pipe", "pipe", "ignore"],
  })
  const say = (o: unknown) => p.stdin.write(JSON.stringify(o) + "\n")
  say({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2024-11-05", capabilities: {}, clientInfo: { name: "tools-doc", version: "1" } } })
  say({ jsonrpc: "2.0", id: 2, method: "tools/list", params: {} })
  let buf = ""
  const timer = setTimeout(() => { p.kill(); reject(new Error("server did not answer tools/list")) }, 20_000)
  p.stdout.on("data", (d) => {
    buf += d
    const lines = buf.split("\n")
    buf = lines.pop() ?? ""
    for (const l of lines) {
      try {
        const m = JSON.parse(l)
        if (m.id === 2) { clearTimeout(timer); p.kill(); resolve(m.result.tools) }
      } catch {}
    }
  })
})

/** The order they are grouped in below; anything unlisted lands in "Other". */
const GROUPS: [string, string, string[]][] = [
  ["Messages", "Moving something between two people mid-task.", ["crosstalk_send", "crosstalk_read", "crosstalk_read_slice", "crosstalk_ask", "crosstalk_answer", "crosstalk_handoff"]],
  ["Presence", "Who is around and what they are touching.", ["crosstalk_peers", "crosstalk_rooms"]],
  ["Tasks", "Work a room has agreed, and who took it.", ["crosstalk_tasks", "crosstalk_task_add", "crosstalk_task_claim", "crosstalk_task_done"]],
  ["Facts", "What the room keeps deriving and would rather not derive again.", ["crosstalk_facts", "crosstalk_remember", "crosstalk_confirm", "crosstalk_correct"]],
  ["Decisions", "What was settled, written where the code lives.", ["crosstalk_decide"]],
]

const byName = new Map(tools.map((t) => [t.name, t]))
const placed = new Set(GROUPS.flatMap(([, , names]) => names))
const leftover = tools.filter((t) => !placed.has(t.name)).map((t) => t.name)
if (leftover.length) GROUPS.push(["Other", "Not yet grouped.", leftover])

const args = (t: Tool) => {
  const props = Object.keys(t.inputSchema?.properties ?? {})
  if (!props.length) return "none"
  const req = new Set(t.inputSchema?.required ?? [])
  return props.map((p) => (req.has(p) ? `\`${p}\`` : `\`${p}\`?`)).join(", ")
}

const out: string[] = [
  "# Tools",
  "",
  "The MCP server advertises these. Every agent in a room gets the same set,",
  "whether it reached crosstalk through the plugin or through MCP alone.",
  "",
  "**Generated** by `bun scripts/tools-doc.ts`, from the server itself. Edit the",
  "tool, not this file.",
  "",
  `${tools.length} tools.`,
  "",
]

for (const [title, blurb, names] of GROUPS) {
  const rows = names.map((n) => byName.get(n)).filter(Boolean) as Tool[]
  if (!rows.length) continue
  out.push(`## ${title}`, "", blurb, "", "| Tool | Arguments | What it does |", "|---|---|---|")
  for (const t of rows) {
    const desc = (t.description ?? "").replace(/\s*\n\s*/g, " ").replace(/\|/g, "\\|").trim()
    out.push(`| \`${t.name}\` | ${args(t)} | ${desc} |`)
  }
  out.push("")
}

out.push("A `?` marks an optional argument.", "")
fs.writeFileSync(OUT, out.join("\n"))
console.log(`docs/tools.md: ${tools.length} tools`)
