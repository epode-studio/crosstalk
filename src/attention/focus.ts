// Which session the person is looking at, and bringing one to the front.
//
// docs/design/next-generation.md, "Focus-aware". "In a session" means the one
// in front of the person, not the last one typed in, so crosstalk asks each
// terminal that can say:
//
//   tmux          `list-clients`: the client whose flags say `focused` (tmux
//                 3.3+, with focus-events on), else the most recently active
//                 one, and the pane it shows
//   Terminal.app  the selected tab of the front window, by its tty, only
//                 when Terminal is the frontmost app
//   iTerm2        the current session of the current window, by its tty,
//                 only when iTerm2 is frontmost
//   kitty         `kitten @ ls`: the focused window of the focused tab of the
//                 focused OS window
//   WezTerm       `wezterm cli list-clients`: the most recently active client's
//                 focused pane
//
// A terminal that cannot say (Windows Terminal, Ghostty, VS Code) falls back
// to the last session the person typed in (activity.ts).
//
// Focusing is the other direction, and only ever on the person's word ("show
// me api") or a click on crosstalk's notification:
//
//   tmux          switch-client to the pane's session, select its window and pane
//   Terminal.app  select the tab, raise its window, activate Terminal
//   iTerm2        select the session, its tab and window, activate iTerm2
//   kitty         `kitten @ focus-window --match id:<window>`
//   WezTerm       `wezterm cli activate-pane --pane-id <pane>`
//
// Nothing here writes to a tty or sends a terminal query: an answer would land
// in someone's prompt.

import { spawnSync } from "node:child_process"
import * as R from "../restore.ts"
import type { Rec, Step, Term } from "../restore.ts"

export type Sys = {
  platform: NodeJS.Platform
  run: (s: Step) => { ok: boolean; out: string }
  has: (bin: string) => boolean
}

export const liveSys = (env: NodeJS.ProcessEnv = process.env): Sys => ({
  platform: process.platform,
  run: (s) => {
    const r = spawnSync(s.cmd, s.args, { input: s.input, encoding: "utf8", timeout: 3000, env: cleanTmuxEnv(env) })
    return { ok: r.status === 0, out: (r.stdout ?? "").trim() }
  },
  has: (bin) => spawnSync("sh", ["-c", `command -v ${bin}`], { stdio: "ignore", timeout: 2000 }).status === 0,
})

/** A daemon started from inside tmux would otherwise ask its own server about every socket. */
function cleanTmuxEnv(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const e = { ...env }
  delete e.TMUX
  delete e.TMUX_PANE
  return e
}

/** What a terminal said is in front, in its own terms. */
export type Seen =
  | { kind: "tmux"; socket?: string; pane: string; focused: boolean; activity: number }
  | { kind: "tty"; app: "apple" | "iterm"; tty: string }
  | { kind: "kitty"; listenOn: string; window: string }
  | { kind: "wezterm"; pane: string }

export type Focus = { sessionId: string; how: string; sure: boolean }

// --- asking -----------------------------------------------------------------------

// tmux prints a tab inside a format as "_", so the fields are split on "|".
export const TMUX_CLIENTS_FORMAT = "#{client_flags}|#{client_activity}|#{pane_id}"

/** `list-clients` lines: the focused client, else the most recently active. */
export function parseTmuxClients(out: string, socket?: string): Seen | null {
  const rows = out
    .split("\n")
    .filter(Boolean)
    .map((l) => {
      const [flags, activity, pane] = l.split("|")
      return { flags: flags ?? "", activity: Number(activity) || 0, pane: pane ?? "" }
    })
    .filter((r) => r.pane.startsWith("%"))
  if (!rows.length) return null
  const focused = rows.filter((r) => /(^|,)focused(,|$)/.test(r.flags))
  const pick = (focused.length ? focused : rows).sort((a, b) => b.activity - a.activity)[0]
  return { kind: "tmux", socket, pane: pick.pane, focused: focused.length > 0, activity: pick.activity }
}

export const appleFrontTtyScript = [
  `if application "Terminal" is running then`,
  `\ttell application "Terminal"`,
  `\t\tif frontmost then return tty of selected tab of front window`,
  `\tend tell`,
  `end if`,
  `return ""`,
].join("\n")

export const itermFrontTtyScript = [
  `if application "iTerm2" is running then`,
  `\ttell application "iTerm2"`,
  `\t\tif frontmost then return tty of current session of current window`,
  `\tend tell`,
  `end if`,
  `return ""`,
].join("\n")

/** `kitten @ ls`: the focused OS window's focused tab's focused window. */
export function parseKittyLs(out: string): string | null {
  let j: any
  try {
    j = JSON.parse(out)
  } catch {
    return null
  }
  if (!Array.isArray(j)) return null
  const osw = j.find((w: any) => w?.is_focused) ?? null
  if (!osw) return null
  const tab = (osw.tabs ?? []).find((t: any) => t?.is_focused) ?? (osw.tabs ?? []).find((t: any) => t?.is_active)
  const win = (tab?.windows ?? []).find((w: any) => w?.is_focused) ?? (tab?.windows ?? []).find((w: any) => w?.is_active)
  return win?.id !== undefined ? String(win.id) : null
}

/** `wezterm cli list-clients --format json`: the least idle client's focused pane. */
export function parseWeztermClients(out: string): string | null {
  let j: any
  try {
    j = JSON.parse(out)
  } catch {
    return null
  }
  if (!Array.isArray(j)) return null
  const idle = (c: any) => Number(c?.idle_time?.secs ?? c?.idle_time ?? 0) || 0
  const c = j.filter((c: any) => c?.focused_pane_id !== undefined).sort((a: any, b: any) => idle(a) - idle(b))[0]
  return c ? String(c.focused_pane_id) : null
}

/** Ask every terminal the live sessions are in what is in front. */
export function ask(recs: Rec[], sys: Sys): Seen[] {
  const out: Seen[] = []
  const kinds = new Set(recs.map((r) => R.kindOf(r.terminal)))
  // Every tmux server a live session is in, each asked once.
  const sockets = new Set<string>()
  for (const r of recs) if (r.terminal.tmux) sockets.add(r.terminal.tmux.socket ?? "")
  if (sockets.size && sys.has("tmux"))
    for (const s of sockets) {
      const r = sys.run({ cmd: "tmux", args: [...(s ? ["-S", s] : []), "list-clients", "-F", TMUX_CLIENTS_FORMAT] })
      const seen = r.ok ? parseTmuxClients(r.out, s || undefined) : null
      if (seen) out.push(seen)
    }
  if (sys.platform === "darwin") {
    if (kinds.has("apple")) {
      const r = sys.run({ cmd: "osascript", args: ["-"], input: appleFrontTtyScript })
      if (r.ok && r.out.startsWith("/dev/")) out.push({ kind: "tty", app: "apple", tty: r.out })
    }
    if (kinds.has("iterm")) {
      const r = sys.run({ cmd: "osascript", args: ["-"], input: itermFrontTtyScript })
      if (r.ok && r.out.startsWith("/dev/")) out.push({ kind: "tty", app: "iterm", tty: r.out })
    }
  }
  if (kinds.has("kitty") && sys.has("kitten")) {
    const sockets = new Set(recs.map((r) => r.terminal.kitty?.listenOn).filter((s): s is string => !!s))
    for (const to of sockets) {
      const r = sys.run({ cmd: "kitten", args: ["@", "--to", to, "ls"] })
      const w = r.ok ? parseKittyLs(r.out) : null
      if (w) out.push({ kind: "kitty", listenOn: to, window: w })
    }
  }
  if (kinds.has("wezterm") && sys.has("wezterm")) {
    const r = sys.run({ cmd: "wezterm", args: ["cli", "list-clients", "--format", "json"] })
    const p = r.ok ? parseWeztermClients(r.out) : null
    if (p) out.push({ kind: "wezterm", pane: p })
  }
  return out
}

/** The session a sighting points at. */
export function match(seen: Seen, recs: Rec[]): Rec | undefined {
  switch (seen.kind) {
    case "tmux":
      return recs.find((r) => r.terminal.tmux?.pane === seen.pane && (!seen.socket || !r.terminal.tmux.socket || r.terminal.tmux.socket === seen.socket))
    case "tty":
      return recs.find((r) => r.terminal.tty === seen.tty && !r.terminal.tmux)
    case "kitty":
      return recs.find((r) => r.terminal.kitty?.window === seen.window)
    case "wezterm":
      return recs.find((r) => r.terminal.wezterm?.pane === seen.pane)
  }
}

/**
 * The session in front, from what the terminals said. A GUI terminal's answer
 * (frontmost app, focused window) beats tmux's guess by activity; tmux's
 * `focused` flag counts as sure.
 */
export function pick(seen: Seen[], recs: Rec[]): Focus | null {
  const ranked = [...seen].sort((a, b) => rank(b) - rank(a))
  for (const s of ranked) {
    const r = match(s, recs)
    if (r) return { sessionId: r.sessionId, how: s.kind === "tty" ? s.app : s.kind, sure: s.kind !== "tmux" || s.focused }
  }
  return null
}

const rank = (s: Seen) => (s.kind === "tmux" ? (s.focused ? 3 : 1) : 2)

/** Live sessions with a terminal record: who could be in front. */
export const liveRecs = (all = R.readAll(), alive: (r: Rec) => boolean = R.recAlive) =>
  all.filter((r) => !r.endedAt && r.interactive !== false && alive(r))

/**
 * The session the person is looking at, or, when no terminal can say, the one
 * typed in last (`lastTyped`). Null when nothing is known.
 */
export function focused(o: { recs: Rec[]; sys: Sys; lastTyped?: string }): Focus | null {
  const f = pick(ask(o.recs, o.sys), o.recs)
  if (f) return f
  return o.lastTyped ? { sessionId: o.lastTyped, how: "last typed", sure: false } : null
}

// --- bringing to the front ------------------------------------------------------------

export const appleFocusScript = (tty: string) =>
  [
    `tell application "Terminal"`,
    `\trepeat with w in windows`,
    `\t\trepeat with t in tabs of w`,
    `\t\t\tif (tty of t) is ${R.asq(tty)} then`,
    `\t\t\t\tset selected of t to true`,
    `\t\t\t\tset index of w to 1`,
    `\t\t\t\tactivate`,
    `\t\t\t\treturn "done"`,
    `\t\t\tend if`,
    `\t\tend repeat`,
    `\tend repeat`,
    `end tell`,
    `return ""`,
  ].join("\n")

export const itermFocusScript = (tty: string) =>
  [
    `tell application "iTerm2"`,
    `\trepeat with w in windows`,
    `\t\trepeat with t in tabs of w`,
    `\t\t\trepeat with s in sessions of t`,
    `\t\t\t\tif (tty of s) is ${R.asq(tty)} then`,
    `\t\t\t\t\ttell s to select`,
    `\t\t\t\t\ttell t to select`,
    `\t\t\t\t\tset index of w to 1`,
    `\t\t\t\t\tactivate`,
    `\t\t\t\t\treturn "done"`,
    `\t\t\t\tend if`,
    `\t\t\tend repeat`,
    `\t\tend repeat`,
    `\tend repeat`,
    `end tell`,
    `return ""`,
  ].join("\n")

/** How to bring a session's tab to the front, or null when its terminal cannot be told. */
export function focusSteps(t: Term, platform: NodeJS.Platform = process.platform): { kind: string; steps: Step[] } | null {
  if (t.tmux?.pane) {
    const S = t.tmux.socket ? ["-S", t.tmux.socket] : []
    return {
      kind: "tmux",
      steps: [
        { cmd: "tmux", args: [...S, "switch-client", "-t", t.tmux.pane] },
        { cmd: "tmux", args: [...S, "select-window", "-t", t.tmux.pane] },
        { cmd: "tmux", args: [...S, "select-pane", "-t", t.tmux.pane] },
      ],
    }
  }
  const k = R.kindOf(t)
  if (k === "apple" && platform === "darwin" && t.tty) return { kind: "apple", steps: [{ cmd: "osascript", args: ["-"], input: appleFocusScript(t.tty) }] }
  if (k === "iterm" && platform === "darwin" && t.tty) return { kind: "iterm", steps: [{ cmd: "osascript", args: ["-"], input: itermFocusScript(t.tty) }] }
  if (k === "kitty" && t.kitty?.window && t.kitty.listenOn)
    return { kind: "kitty", steps: [{ cmd: "kitten", args: ["@", "--to", t.kitty.listenOn, "focus-window", "--match", `id:${t.kitty.window}`] }] }
  if (k === "wezterm" && t.wezterm?.pane) return { kind: "wezterm", steps: [{ cmd: "wezterm", args: ["cli", "activate-pane", "--pane-id", t.wezterm.pane] }] }
  return null
}

/**
 * Bring one session to the front. A tmux switch-client fails with no client
 * attached, and that is fine as long as its window and pane were selected.
 */
export function focusTerm(t: Term, sys: Sys): { ok: boolean; kind?: string } {
  const plan = focusSteps(t, sys.platform)
  if (!plan) return { ok: false }
  let ok = false
  for (const s of plan.steps) {
    const r = sys.run(s)
    if (r.ok) ok = true
    else if (plan.kind !== "tmux") return { ok: false, kind: plan.kind }
  }
  return { ok, kind: plan.kind }
}

/** A live session by name or id, from the open records. */
export function findRec(nameOrId: string, recs: Rec[]): Rec | undefined {
  const n = nameOrId.trim().toLowerCase()
  if (!n) return undefined
  // Its name or its thread ("the one on login"), exact before partial; of several, the one used last.
  const newest = (xs: Rec[]) => [...xs].sort((a, b) => b.seenAt - a.seenAt)[0]
  const words = (r: Rec) => [(r.name ?? "").toLowerCase(), (r.thread ?? "").toLowerCase()]
  return (
    recs.find((r) => r.sessionId === nameOrId) ??
    newest(recs.filter((r) => words(r).includes(n))) ??
    newest(recs.filter((r) => words(r).some((w) => w && w.includes(n)))) ??
    newest(recs.filter((r) => r.cwd.toLowerCase().endsWith("/" + n)))
  )
}
