// Background agents where there is no tmux, notably native Windows.
//
// Claude Code has background sessions of its own: `claude --bg` starts one and
// prints its id, `claude attach <id|name>` opens it in a terminal, and
// `claude agents` lists them (all on 2.1.316's --help). So where tmux is
// missing, a background agent is `claude --bg -n <name> "<task>"` in its
// worktree, and "show me <name>" opens a tab running `claude attach <name>`.
//
// Detection is the binary's own help text, read once per process: `--bg` in
// `claude --help`, and an `attach` command. Without either, a background agent
// is refused as before ("install tmux").
//
// Every background agent, tmux or not, carries CROSSTALK_BG_AGENT=<name>, which
// is how crosstalk's PermissionRequest hook knows its prompts have nobody in
// front of them (permission.ts).

import { spawnSync } from "node:child_process"
import type { Step } from "../restore.ts"

export const BG_ENV = "CROSSTALK_BG_AGENT"

let cached: { bin: string; bg: boolean; attach: boolean } | null = null

/** What this claude can do in the background. CROSSTALK_CLAUDE_BG=0/1 overrides, for tests. */
export function claudeBackground(bin = "claude", env: NodeJS.ProcessEnv = process.env): { bg: boolean; attach: boolean } {
  if (env.CROSSTALK_CLAUDE_BG === "0") return { bg: false, attach: false }
  if (env.CROSSTALK_CLAUDE_BG === "1") return { bg: true, attach: true }
  if (cached && cached.bin === bin) return { bg: cached.bg, attach: cached.attach }
  const r = spawnSync(bin, ["--help"], { encoding: "utf8", timeout: 10_000, env })
  const help = `${r.stdout ?? ""}${r.stderr ?? ""}`
  cached = { bin, bg: /--bg\b|--background\b/.test(help), attach: /^\s+attach\b/m.test(help) }
  return { bg: cached.bg, attach: cached.attach }
}

/** `claude --bg -n <name> <task>`, in the worktree, marked as crosstalk's background agent. */
export const bgStep = (o: { claude: string; name: string; task: string; cwd: string }): Step & { cwd: string; env: Record<string, string> } => ({
  cmd: o.claude,
  args: ["--bg", "-n", o.name, o.task],
  cwd: o.cwd,
  env: { [BG_ENV]: o.name },
})

export const attachArgv = (claude: string, name: string) => [claude, "attach", name]

/** The tmux command line for a background agent, with its marker. */
export const tmuxArgv = (argv: string[], name: string) => ["env", `${BG_ENV}=${name}`, ...argv]
