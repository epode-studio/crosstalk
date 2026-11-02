// Running crosstalk's own CLI from the MCP server or a hook: the source when
// running from source (tests, development), else the installed shim.

import fs from "node:fs"
import path from "node:path"
import { spawn } from "node:child_process"

/** argv for `crosstalk cli …`, without the subcommand. */
export function cliArgv(root: string, self = import.meta.url): string[] {
  const src = path.join(root, "src", "cli.ts")
  if (self.endsWith(".ts") && fs.existsSync(src)) return [process.execPath, src]
  return [path.join(root, "bin", "crosstalk"), "cli"]
}

/** Run a CLI command to the end; its output, and whether it exited 0. */
export function runCli(root: string, args: string[], o: { env?: NodeJS.ProcessEnv; timeoutMs?: number } = {}): Promise<{ ok: boolean; out: string }> {
  const [cmd, ...pre] = cliArgv(root)
  return new Promise((resolve) => {
    const p = spawn(cmd, [...pre, ...args], { env: o.env ?? process.env, stdio: ["ignore", "pipe", "pipe"] })
    let out = ""
    p.stdout.on("data", (d) => (out += d))
    p.stderr.on("data", (d) => (out += d))
    const timer = setTimeout(() => p.kill(), o.timeoutMs ?? 180_000)
    p.on("error", (e) => {
      clearTimeout(timer)
      resolve({ ok: false, out: e.message })
    })
    p.on("close", (code) => {
      clearTimeout(timer)
      resolve({ ok: code === 0, out: out.trim() })
    })
  })
}

/**
 * Start a CLI command that outlives this call (it waits for someone to type the
 * words in), and wait until its output matches `until`. The process keeps
 * running, writing to `log`.
 */
export async function startCli(
  root: string,
  args: string[],
  o: { log: string; until: RegExp; env?: NodeJS.ProcessEnv; waitMs?: number },
): Promise<{ ok: boolean; out: string; pid?: number; match?: RegExpExecArray }> {
  const [cmd, ...pre] = cliArgv(root)
  fs.mkdirSync(path.dirname(o.log), { recursive: true, mode: 0o700 })
  const fd = fs.openSync(o.log, "w", 0o600)
  const p = spawn(cmd, [...pre, ...args], { env: o.env ?? process.env, stdio: ["ignore", fd, fd], detached: true })
  fs.closeSync(fd)
  p.unref()
  let exited = false
  p.on("exit", () => (exited = true))
  const deadline = Date.now() + (o.waitMs ?? 30_000)
  for (;;) {
    const out = fs.readFileSync(o.log, "utf8")
    const m = o.until.exec(out)
    if (m) return { ok: true, out, pid: p.pid, match: m }
    if (exited || Date.now() > deadline) return { ok: false, out: out.trim(), pid: exited ? undefined : p.pid }
    await new Promise((r) => setTimeout(r, 200))
  }
}
