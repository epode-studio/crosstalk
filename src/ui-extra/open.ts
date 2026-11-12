// "Open auth in my editor": a thread's or a session's worktree in the person's
// editor, the crosstalk_sessions action "open" tool.
//
// The editor: the one named, else $VISUAL or $EDITOR when it is one that opens
// a window, else the first of code, cursor, zed and idea on PATH, else on a Mac
// `open -a` for those apps. A terminal editor (vim, nano, …) needs a terminal
// of its own, which the MCP server does not have, so it is said, not run.

import fs from "node:fs"
import path from "node:path"
import { spawn } from "node:child_process"

export const GUI = ["code", "cursor", "zed", "idea", "subl", "windsurf", "code-insiders", "webstorm", "fleet", "mate", "gvim", "mvim"]
const TERMINAL = /^(vi|vim|nvim|nano|pico|emacs|micro|hx|helix|kak|ne|joe|ed|mg)$/
const MAC_APPS: Record<string, string> = { code: "Visual Studio Code", cursor: "Cursor", zed: "Zed", idea: "IntelliJ IDEA" }

export type Launch = { cmd: string; args: string[]; name: string } | { terminal: string } | null

function onPath(cmd: string, env: NodeJS.ProcessEnv): string | undefined {
  if (cmd.includes("/")) return fs.existsSync(cmd) ? cmd : undefined
  for (const dir of (env.PATH ?? "").split(path.delimiter).filter(Boolean)) {
    const p = path.join(dir, cmd)
    try {
      fs.accessSync(p, fs.constants.X_OK)
      return p
    } catch {}
  }
  return undefined
}

/** How to open `dir`, or why it cannot be. */
export function chooseEditor(dir: string, o: { editor?: string; env?: NodeJS.ProcessEnv; platform?: NodeJS.Platform; exists?: (p: string) => boolean } = {}): Launch {
  const env = o.env ?? process.env
  const platform = o.platform ?? process.platform
  const exists = o.exists ?? fs.existsSync
  const split = (s: string) => s.trim().split(/\s+/).filter(Boolean)
  const tryOne = (spec: string, strict: boolean): Launch => {
    const [cmd, ...pre] = split(spec)
    if (!cmd) return null
    const base = path.basename(cmd).toLowerCase()
    if (TERMINAL.test(base)) return strict ? { terminal: spec } : null
    const found = onPath(cmd, env)
    if (found) return { cmd: found, args: [...pre, dir], name: base }
    if (platform === "darwin") {
      const app = MAC_APPS[base] ?? (strict ? spec : undefined)
      if (app && (exists(`/Applications/${app}.app`) || strict)) return { cmd: "open", args: ["-a", app, dir], name: app }
    }
    return null
  }
  if (o.editor) return tryOne(o.editor, true) ?? null
  let terminal: Launch = null
  for (const v of [env.VISUAL, env.EDITOR].filter((x): x is string => !!x)) {
    const l = tryOne(v, false)
    if (l) return l
    if (TERMINAL.test(path.basename(split(v)[0] ?? "").toLowerCase())) terminal ??= { terminal: v }
  }
  for (const c of ["code", "cursor", "zed", "idea"]) {
    const l = tryOne(c, false)
    if (l) return l
  }
  return terminal
}

export function launch(l: { cmd: string; args: string[] }, env: NodeJS.ProcessEnv = process.env): Promise<{ ok: boolean; error?: string }> {
  return new Promise((resolve) => {
    try {
      const p = spawn(l.cmd, l.args, { env, detached: true, stdio: "ignore" })
      p.on("error", (e) => resolve({ ok: false, error: e.message }))
      p.unref()
      setTimeout(() => resolve({ ok: true }), 300)
    } catch (e) {
      resolve({ ok: false, error: (e as Error).message })
    }
  })
}

export type Worktree = { dir: string; what: string }

/**
 * Where a thread's or a session's work is: a session's folder by its name, a
 * thread's session on this machine, else its repo's clone here.
 */
export function findWorktree(
  a: { thread?: string; session?: string },
  o: { sessions: { name: string; cwd: string; threads?: string[] }[]; roots: Record<string, string>; threadRepo?: (name: string) => { name: string; repo: string } | undefined },
): Worktree | { error: string } {
  if (a.session) {
    const want = a.session.toLowerCase()
    const s = o.sessions.find((x) => x.name.toLowerCase() === want) ?? o.sessions.find((x) => x.name.toLowerCase().includes(want))
    if (s?.cwd) return { dir: s.cwd, what: `the ${s.name} session's folder` }
    if (!a.thread) return { error: `no session called "${a.session}". Open: ${o.sessions.map((x) => x.name).join(", ") || "none"}` }
  }
  if (a.thread) {
    const t = o.threadRepo?.(a.thread)
    const name = t?.name ?? a.thread
    const s = o.sessions.find((x) => (x.threads ?? []).some((n) => n.toLowerCase() === name.toLowerCase()))
    if (s?.cwd) return { dir: s.cwd, what: `${name}, where the ${s.name} session works on it` }
    const root = t ? o.roots[t.repo] : undefined
    if (root) return { dir: root, what: `${name}'s repository (no session works on it here right now)` }
    return { error: t ? `no copy of ${t.repo} on this machine to open` : `no thread called "${a.thread}"` }
  }
  return { error: "say which thread or session to open" }
}
