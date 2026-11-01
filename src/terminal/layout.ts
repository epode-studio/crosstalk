// One window per repository.
//
// A new tab, whether a spawned agent, a restored session or a gather that
// could not type into its old tab, goes into the window that already holds
// that repository's sessions, and into a new window when none does. Every
// worktree of a repository counts as that repository (src/terminal/repo.ts).
//
// Only new tabs are placed. Existing ones are never moved: Terminal.app,
// Ghostty and Windows Terminal cannot move a tab from a script at all, and in
// the others moving one under a person's hands would be a surprise.
//
//   tmux       a tmux session is the window, its windows the tabs:
//              `new-window -d` in the session holding the repo, else a new
//              detached session named after the repo
//   Terminal   that window brought to the front, Cmd-T, `do script` in it
//   iTerm2     `create tab` in the window holding a session on that tty
//   kitty      `launch --type=tab --match window_id:<a window in it>`
//   WezTerm    `spawn --pane-id <a pane in it>`: the same window
//   Ghostty    Cmd-T in the front window (no way to name a window)
//   Windows    `wt -w 0 nt`

import { spawnSync } from "node:child_process"
import * as R from "../restore.ts"
import type { Env, Kind, Rec, Step, Term } from "../restore.ts"
import { repoKey, repoName, type Git, git as liveGit } from "./repo.ts"

/** A tab to open: run `argv` in `cwd`. */
export type Tab = { cwd: string; argv: string[]; name?: string }

export type Opened = {
  kind: Kind | "manual"
  steps: Step[]
  needsAccessibility?: boolean
  /** Where it went, in words. */
  where: string
  /** What to paste, when nothing could open it. */
  typed: string[]
}

export const typedTab = (t: Tab) => `cd ${R.shq(t.cwd)} && ${t.argv.map(R.shq).join(" ")}`

export const anchorFor = R.anchorFor
export const appleIntoWindowScript = R.appleIntoWindowScript
export const itermIntoWindowScript = R.itermIntoWindowScript

const wtArg = (s: string) => s.replace(/;/g, "\\;")

function usable(k: Kind, e: Env, t: Term | undefined): boolean {
  switch (k) {
    case "tmux":
      return e.has("tmux")
    case "apple":
    case "iterm":
    case "ghostty":
      return e.platform === "darwin" && e.has("osascript")
    case "kitty":
      return e.has("kitten") && !!(t?.kitty?.listenOn ?? e.current.kitty?.listenOn)
    case "wezterm":
      return e.has("wezterm")
    case "wt":
      return e.platform === "win32" && e.has("wt")
  }
}

/**
 * How to open these tabs, all in one repository's window. `anchor` is a tab
 * already in that window, or null for a new one; `current` is the asking
 * session's terminal, used when the anchor's cannot be driven.
 */
export function openTabs(tabs: Tab[], o: { anchor: Term | null; current: Term; env: Env; repo: string; tmuxSession?: (name: string) => boolean }): Opened {
  const { env: e } = o
  const typed = tabs.map(typedTab)
  if (!tabs.length) return { kind: "manual", steps: [], where: "nowhere", typed }
  if (tabs.some((t) => /[\n\r\0]/.test(t.cwd))) return { kind: "manual", steps: [], where: "nowhere", typed }
  const ak = R.kindOf(o.anchor ?? undefined)
  const ck = R.kindOf(o.current)
  let kind: Kind | null = null
  let anchor: Term | null = null
  if (ak && usable(ak, e, o.anchor!)) {
    kind = ak
    anchor = o.anchor
  } else if (ck && usable(ck, e, o.current)) kind = ck
  if (!kind) return { kind: "manual", steps: [], where: "nowhere", typed }
  const name = repoName(o.repo)
  const shell = (t: Tab) => t.argv.map(R.shq).join(" ")

  switch (kind) {
    case "tmux": {
      const sock = anchor?.tmux?.socket ?? o.current.tmux?.socket
      const S = sock ? ["-S", sock] : []
      let session = anchor?.tmux?.session
      const steps: Step[] = []
      if (!session) {
        // No tmux session holds this repo: one of its own, detached.
        session = name
        let exists = o.tmuxSession?.(session) ?? false
        for (const tab of tabs) {
          if (!exists) {
            exists = true
            steps.push({ cmd: "tmux", args: [...S, "new-session", "-d", "-s", session, "-c", tab.cwd, shell(tab)] })
          } else steps.push({ cmd: "tmux", args: [...S, "new-window", "-d", "-t", `=${session}:`, "-c", tab.cwd, shell(tab)] })
        }
        return { kind, steps, where: `tmux session "${session}"`, typed }
      }
      for (const tab of tabs) steps.push({ cmd: "tmux", args: [...S, "new-window", "-d", "-t", `=${session}:`, "-c", tab.cwd, shell(tab)] })
      return { kind, steps, where: `tmux session "${session}"`, typed }
    }
    case "apple": {
      const w = anchor?.apple?.window
      const many = e.tabs
      const input = w ? appleIntoWindowScript(typed, w, many) : R.appleTerminalScript(typed, many && typed.length > 1)
      return {
        kind,
        steps: [{ cmd: "osascript", args: ["-"], input }],
        needsAccessibility: many && (!!w || typed.length > 1),
        where: w ? `the Terminal window with ${name}` : `a new Terminal window`,
        typed,
      }
    }
    case "iterm":
      return { kind, steps: [{ cmd: "osascript", args: ["-"], input: itermIntoWindowScript(typed, anchor?.tty) }], where: anchor ? `the iTerm2 window with ${name}` : "a new iTerm2 window", typed }
    case "ghostty": {
      const L = R.ghosttyScript(typed)
      // With a Ghostty window already holding the repo, every one is a tab (Cmd-T) in the front window.
      const input = anchor ? L.replace(`keystroke "n" using command down`, `keystroke "t" using command down`) : L
      return { kind, steps: [{ cmd: "osascript", args: ["-"], input }], needsAccessibility: true, where: anchor ? "the front Ghostty window" : "a new Ghostty window", typed }
    }
    case "kitty": {
      const to = anchor?.kitty?.listenOn ?? o.current.kitty?.listenOn!
      const match = anchor?.kitty?.window ? ["--match", `window_id:${anchor.kitty.window}`] : []
      const steps = tabs.map((t, i) => ({
        cmd: "kitten",
        args: ["@", "--to", to, "launch", ...(anchor || i > 0 ? ["--type=tab"] : ["--type=os-window"]), ...match, "--cwd", t.cwd, ...t.argv],
      }))
      return { kind, steps, where: anchor ? `the kitty window with ${name}` : "a new kitty window", typed }
    }
    case "wezterm": {
      const pane = anchor?.wezterm?.pane
      const steps: Step[] = []
      tabs.forEach((t, i) => {
        if (pane) steps.push({ cmd: "wezterm", args: ["cli", "spawn", "--pane-id", pane, "--cwd", t.cwd, "--", ...t.argv] })
        else if (i === 0) steps.push({ cmd: "wezterm", args: ["cli", "spawn", "--new-window", "--cwd", t.cwd, "--", ...t.argv] })
        else steps.push({ cmd: "wezterm", args: ["cli", "spawn", "--cwd", t.cwd, "--", ...t.argv] })
      })
      return { kind, steps, where: pane ? `the WezTerm window with ${name}` : "a new WezTerm window", typed }
    }
    case "wt":
      return { kind, steps: tabs.map((t) => ({ cmd: "wt", args: ["-w", "0", "nt", "-d", wtArg(t.cwd), ...t.argv.map(wtArg)] })), where: "Windows Terminal", typed }
  }
}

export type LiveLayout = {
  env: Env
  keyOf: (cwd: string) => string
  recs: Rec[]
}

/** Open tabs for real, into the window for their repository. */
export function openForRepo(tabs: Tab[], o: { cwd: string; envVars?: NodeJS.ProcessEnv; git?: Git; by?: string }): { ok: boolean; opened: Opened; out: string } {
  const g = o.git ?? liveGit
  const env = R.liveEnv(o.envVars ?? process.env, true)
  const keyOf = (cwd: string) => repoKey(cwd, g)
  const repo = keyOf(o.cwd)
  // The asking session's own record knows its tab (its hook ran in it, with a
  // tty); an MCP server or a script asking has none of its own.
  const own = o.by ? R.readOne(o.by) : null
  const asking = own && R.kindOf(own.terminal) ? { cwd: own.cwd, terminal: own.terminal } : { cwd: o.cwd, terminal: env.current }
  const anchor = anchorFor(repo, { recs: R.readAll(), keyOf, asking, alive: R.recAlive })
  const opened = openTabs(tabs, { anchor, current: env.current, env, repo, tmuxSession: env.tmuxHasSession })
  let out = ""
  let ok = opened.kind !== "manual"
  for (const s of opened.steps) {
    const r = runStep(s, o.envVars)
    out += r.out + "\n"
    if (!r.ok) {
      ok = false
      break
    }
  }
  return { ok, opened, out: out.trim() }
}

function runStep(s: Step, env?: NodeJS.ProcessEnv): { ok: boolean; out: string } {
  const r = spawnSync(s.cmd, s.args, { input: s.input, encoding: "utf8", timeout: 60_000, env: env ?? process.env })
  return { ok: r.status === 0, out: `${r.stdout ?? ""}${r.stderr ?? ""}${r.error ? String(r.error) : ""}`.trim() }
}
