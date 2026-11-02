// Whether Claude Code will actually deliver this server's channel notifications.
//
// Claude Code gives a channel server no signal either way. The initialize
// request is byte-for-byte the same with channels on and off (captured against
// 2.1.316), notifications are never acknowledged, and a session that did not
// opt this server in drops every notifications/claude/channel silently: its
// debug log says "Channel notifications skipped: server … not in --channels
// list for this session" and the server hears nothing. So the answer has to
// come from what decides it on Claude Code's side, which is the command line it
// was started with, plus the few things that veto it (-p and the SDK, a
// third-party provider, an organization policy).
//
// Every doubt resolves to "off". Off is not silence: the daemon then injects
// the notice through the session's inbox socket, or hands it over through the
// notices op, which the person sees either way. Wrongly saying "on" is the bug
// this exists to fix.

import fs from "node:fs"
import path from "node:path"
import { execFileSync } from "node:child_process"

export type ChannelVerdict = { on: boolean; why: string }

const SHELLS = new Set(["sh", "bash", "dash", "zsh", "env", "fish"])

/** A process's argv, or null when it cannot be read. */
export function argvOf(pid: number): string[] | null {
  if (!pid || pid <= 1) return null
  try {
    const raw = fs.readFileSync(`/proc/${pid}/cmdline`, "utf8")
    const a = raw.split("\0")
    if (a[a.length - 1] === "") a.pop()
    return a.length ? a : null
  } catch {}
  try {
    // macOS has no /proc. Values with spaces are split wrongly here, and the
    // entries that matter (plugin:x@y, server:x, flags) never contain one.
    const out = execFileSync("ps", ["-ww", "-o", "args=", "-p", String(pid)], { encoding: "utf8", timeout: 2000 })
    const line = out.trim()
    return line ? line.split(/\s+/) : null
  } catch {}
  return null
}

function parentOf(pid: number): number {
  try {
    const stat = fs.readFileSync(`/proc/${pid}/stat`, "utf8")
    return Number(stat.slice(stat.lastIndexOf(")") + 2).split(" ")[1]) || 0
  } catch {}
  try {
    return Number(execFileSync("ps", ["-o", "ppid=", "-p", String(pid)], { encoding: "utf8", timeout: 2000 }).trim()) || 0
  } catch {}
  return 0
}

/**
 * The Claude Code process that started this server: the given pid (from the
 * session registry) when there is one, otherwise the parent, stepping past a
 * shell wrapper that did not exec.
 */
export function hostArgv(registryPid?: number): string[] | null {
  if (registryPid) {
    const a = argvOf(registryPid)
    if (a) return a
  }
  let pid = process.ppid
  for (let i = 0; i < 3 && pid > 1; i++) {
    const a = argvOf(pid)
    if (!a) return null
    if (!SHELLS.has(path.basename(a[0] ?? ""))) return a
    pid = parentOf(pid)
  }
  return null
}

/** Values given to a variadic flag: `--flag a b`, `--flag=a`, repeated. */
export function flagValues(argv: string[], flag: string): string[] {
  const out: string[] = []
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]
    if (a === "--") break
    if (a.startsWith(flag + "=")) out.push(...a.slice(flag.length + 1).split(/[\s,]+/).filter(Boolean))
    else if (a === flag) {
      while (i + 1 < argv.length && !argv[i + 1].startsWith("-")) out.push(argv[++i])
    }
  }
  return out
}

/** Does one --channels entry name this server, the way Claude Code matches them? */
export function entryNamesUs(entry: string, o: { plugin: boolean; serverName: string; pluginName: string }): boolean {
  if (o.plugin) {
    // plugin:<name>@<marketplace>; Claude Code compares the name part.
    if (!entry.startsWith("plugin:")) return false
    return entry.slice(7).split("@")[0] === o.pluginName
  }
  return entry === `server:${o.serverName}`
}

function managedSettings(): Record<string, any> | null {
  const file =
    process.env.CROSSTALK_MANAGED_SETTINGS ??
    (process.platform === "darwin"
      ? "/Library/Application Support/ClaudeCode/managed-settings.json"
      : process.platform === "win32"
        ? "C:\\Program Files\\ClaudeCode\\managed-settings.json"
        : "/etc/claude-code/managed-settings.json")
  try {
    return JSON.parse(fs.readFileSync(file, "utf8"))
  } catch {
    return null
  }
}

const truthy = (v?: string) => !!v && v !== "0" && v.toLowerCase() !== "false"

export function channelVerdict(
  argv: string[] | null,
  env: NodeJS.ProcessEnv = process.env,
  policy: Record<string, any> | null = managedSettings(),
): ChannelVerdict {
  const forced = env.CROSSTALK_CHANNELS
  if (forced === "on" || forced === "1") return { on: true, why: "CROSSTALK_CHANNELS=on" }
  if (forced === "off" || forced === "0") return { on: false, why: "CROSSTALK_CHANNELS=off" }
  if (!argv) return { on: false, why: "could not read how Claude Code was started" }

  const o = {
    // Claude Code names a plugin's server plugin:<plugin>:<server> and sets
    // CLAUDE_PLUGIN_ROOT for it; a hand-configured one goes by its config key.
    plugin: !!env.CLAUDE_PLUGIN_ROOT,
    serverName: env.CROSSTALK_SERVER_NAME ?? "crosstalk",
    pluginName: "crosstalk",
  }
  const dev = flagValues(argv, "--dangerously-load-development-channels").filter((e) => entryNamesUs(e, o))
  // An entry in --channels alone registers only if it is on the approved
  // allowlist, which crosstalk is not, unless the organization put it on its own.
  const allow: any[] = Array.isArray(policy?.allowedChannelPlugins) ? policy!.allowedChannelPlugins : []
  const orgAllows = allow.some((a) => (typeof a === "string" ? a.split("@")[0] : a?.plugin) === o.pluginName)
  const listed = flagValues(argv, "--channels").filter((e) => entryNamesUs(e, o) && o.plugin && orgAllows)
  if (!dev.length && !listed.length) return { on: false, why: "not named in --channels or --dangerously-load-development-channels" }

  // The development flag is ignored outside an interactive session.
  if (argv.some((a) => a === "-p" || a === "--print" || a.startsWith("--sdk-url") || a.startsWith("--input-format") || a.startsWith("--output-format")))
    return { on: false, why: "non-interactive session (-p or the SDK)" }
  if ((env.CLAUDE_CODE_ENTRYPOINT ?? "").startsWith("sdk")) return { on: false, why: "started by the SDK" }
  if (truthy(env.CLAUDE_CODE_USE_BEDROCK) || truthy(env.CLAUDE_CODE_USE_VERTEX) || truthy(env.CLAUDE_CODE_USE_FOUNDRY))
    return { on: false, why: "channels are not available on third-party providers" }
  if (policy && policy.channelsEnabled !== true) return { on: false, why: "managed settings do not set channelsEnabled" }
  return { on: true, why: `named in ${dev.length ? "--dangerously-load-development-channels" : "--channels"}` }
}
