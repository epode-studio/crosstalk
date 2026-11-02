// Regenerates docs/tools.md from the MCP server itself, so the reference cannot
// drift from what the server actually advertises. Run it after changing a tool.
//
//   bun scripts/tools-doc.ts

import fs from "node:fs"
import path from "node:path"
import { spawn } from "node:child_process"

const ROOT = path.resolve(import.meta.dir, "..")
const OUT = path.join(ROOT, "docs/tools.md")

type Tool = { name: string; description?: string; inputSchema?: { properties?: Record<string, any>; required?: string[] } }

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

type Prop = { type?: string; enum?: string[]; description?: string; items?: { type?: string } }

const typeOf = (p: Prop) => (p.enum ? p.enum.map((v) => `\`${v}\``).join(" \\| ") : p.type === "array" ? `${p.items?.type ?? "object"}[]` : (p.type ?? "object"))
const cell = (s: string) => s.replace(/\s*\n\s*/g, " ").replace(/\|/g, "\\|").trim()

const size = JSON.stringify(tools).length
const out: string[] = [
  "# Tools",
  "",
  "The MCP server advertises these. Every agent gets the same set, whether it",
  "reached crosstalk through the plugin or through MCP alone. There are eight,",
  "each with an `action`, rather than one per feature: every definition is in",
  "every session's context on every turn (docs/design/next-generation.md,",
  '"Three nouns").',
  "",
  "**Generated** by `bun scripts/tools-doc.ts`, from the server itself. Edit the",
  "tool (src/tools/), not this file.",
  "",
  `${tools.length} tools, ${tools.reduce((n, t: any) => n + (t.inputSchema?.properties?.action?.enum?.length ?? 0), 0)} actions, ${size.toLocaleString("en")} characters of definitions (about ${Math.round(size / 4).toLocaleString("en")} tokens).`,
  "",
  "| Tool | Actions |",
  "|---|---|",
  ...tools.map((t: any) => `| [\`${t.name}\`](#${t.name}) | ${(t.inputSchema?.properties?.action?.enum ?? []).join(", ")} |`),
  "",
]

for (const t of tools as any[]) {
  const props = Object.entries((t.inputSchema?.properties ?? {}) as Record<string, Prop>)
  out.push(`## ${t.name}`, "", (t.description ?? "").trim(), "", "| Argument | Type | For |", "|---|---|---|")
  for (const [name, p] of props) out.push(`| \`${name}\`${name === "action" ? "" : "?"} | ${cell(typeOf(p))} | ${cell(p.description ?? "")} |`)
  out.push("")
}

out.push("A `?` marks an optional argument. `action` is required on every tool.", "")
fs.writeFileSync(OUT, out.join("\n"))
console.log(`docs/tools.md: ${tools.length} tools, ${size} characters`)
