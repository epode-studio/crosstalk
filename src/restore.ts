// Restore after a restart.
//
// Every open session leaves a small record of where it was: its id, folder,
// client, process and terminal tab. A session that ends normally says so
// through the SessionEnd hook. One whose process is gone without having said
// so was lost, to a restart or to its terminal dying, and the next session
// opened offers to bring all of them back, each in its own tab, as
// `claude --resume <id>` in its folder.
//
// The records are one file per session under <crosstalk home>/open/, written by
// the hook itself. They cannot live in the daemon's sessions.json: the daemon
// is not running after a restart, and the first thing it does on starting is
// drop every session whose process has gone, which is exactly the list wanted
// here. One file per session also means sessions starting together (as they
// do right after a restore) never overwrite each other.
//
// Nothing here needs an identity, a room or the daemon.

import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { spawn, spawnSync } from "node:child_process"
import { P } from "./config.ts"
import { rootFrom, shim } from "./paths.ts"
import { repoKey } from "./terminal/repo.ts"
import { refuseBot } from "./ui-extra/bots.ts"
import { sessionsDir } from "./registry.ts"

// --- records -------------------------------------------------------------------

/** Where a session's terminal tab was, in whatever terms its terminal uses. */
export type Term = {
  /** TERM_PROGRAM: Apple_Terminal, iTerm.app, ghostty, WezTerm, tmux, vscode … */
  program?: string
  /** The session's controlling tty, e.g. /dev/ttys003. */
  tty?: string
  /** `windowId` (`@3`) is looked up when a tab is to go right after this one. */
  tmux?: { pane: string; socket?: string; session?: string; window?: number; paneIndex?: number; windowId?: string }
  kitty?: { window?: string; listenOn?: string }
  wezterm?: { pane: string }
  /** ITERM_SESSION_ID, "w0t1p0:<uuid>": window, tab and pane by position. */
  iterm?: { id: string; window?: number; tab?: number }
  /** Terminal.app. `window` is the window's AppleScript id, `tab` its 1-based tab index. */
  apple?: { sessionId?: string; window?: number; tab?: number }
  wt?: { session: string }
  /** GNOME Terminal: GNOME_TERMINAL_SCREEN, its D-Bus path for this tab. */
  gnome?: { screen?: string }
  /** Konsole: KONSOLE_DBUS_SERVICE and KONSOLE_DBUS_SESSION. */
  konsole?: { service?: string; session?: string }
  /**
   * VTE_VERSION: a VTE terminal (GNOME Terminal, Tilix, xfce4-terminal,
   * Terminator…). Recorded, but not enough alone to know which app to ask.
   */
  vte?: string
  /** Alacritty (ALACRITTY_WINDOW_ID): it has no tabs, so only tmux or the commands to paste. */
  alacritty?: { window?: string }
}

export type Rec = {
  sessionId: string
  cwd: string
  /** "claude" or "codex"; anything else is recorded but cannot be resumed. */
  client: string
  name?: string
  pid: number
  /** The process's start time as ps prints it, so a reused pid is not mistaken for it. */
  pidStart?: string
  /** False for `claude -p` and the like, which have no tab to come back to. */
  interactive?: boolean
  startedAt: number
  seenAt: number
  terminal: Term
  endedAt?: number
  endReason?: string
  /** When the question about this session was put, so it is put once. */
  askedAt?: number
  /**
   * "watched": a session that started before crosstalk, recorded by
   * src/gather.ts from Claude Code's registry, not by its own hooks.
   */
  adopted?: "watched"
  /** When the watch last looked up its tab. */
  watchedAt?: number
  /** Being brought into crosstalk: queued until idle, restarting, done or failed. */
  gather?: { state: "queued" | "restarting" | "done" | "failed"; at: number }
  /** The crosstalk thread it is in (its first), as its hook last heard: tabs of a thread sit together. */
  thread?: string
  /**
   * Closed on purpose (crosstalk_work action "close", src/sessions/control.ts): never lost,
   * whatever its SessionEnd hook said, so restore does not offer it back.
   */
  archived?: number
}

const dir = () => path.join(P.root, "open")
const safe = (id: string) => id.replace(/[^A-Za-z0-9._-]/g, "_")
const fileOf = (id: string) => path.join(dir(), `${safe(id)}.json`)

export function readAll(): Rec[] {
  let names: string[]
  try {
    names = fs.readdirSync(dir()).filter((f) => f.endsWith(".json"))
  } catch {
    return []
  }
  const out: Rec[] = []
  for (const f of names) {
    try {
      const r = JSON.parse(fs.readFileSync(path.join(dir(), f), "utf8"))
      if (r && typeof r.sessionId === "string") out.push(r)
    } catch {}
  }
  return out
}

export function readOne(id: string): Rec | null {
  try {
    return JSON.parse(fs.readFileSync(fileOf(id), "utf8"))
  } catch {
    return null
  }
}

export function writeRec(r: Rec) {
  fs.mkdirSync(dir(), { recursive: true, mode: 0o700 })
  const tmp = `${fileOf(r.sessionId)}.${process.pid}.tmp`
  fs.writeFileSync(tmp, JSON.stringify(r, null, 2), { mode: 0o600 })
  fs.renameSync(tmp, fileOf(r.sessionId))
}

export function removeRec(id: string) {
  try {
    fs.unlinkSync(fileOf(id))
  } catch {}
}

/** Records nobody will ever ask about again: ended or seen over a week ago. */
export function prune(now = Date.now()) {
  for (const r of readAll())
    if ((r.endedAt && now - r.endedAt > DAY) || (!r.endedAt && now - r.seenAt > 7 * DAY && !recAlive(r))) removeRec(r.sessionId)
}

// --- small state ---------------------------------------------------------------

type State = {
  /** When System Settings was last opened for each pane, so it is not opened twice in a row. */
  settingsOpened?: { accessibility?: number; automation?: number }
  /** Set once Terminal has opened tabs through System Events, so the first-time note stops. */
  tabsWorked?: number
}
const stateFile = () => path.join(P.root, "restore-state.json")
export function loadState(): State {
  try {
    return JSON.parse(fs.readFileSync(stateFile(), "utf8"))
  } catch {
    return {}
  }
}
export function saveState(s: State) {
  fs.mkdirSync(P.root, { recursive: true, mode: 0o700 })
  fs.writeFileSync(stateFile(), JSON.stringify(s, null, 2), { mode: 0o600 })
}

// --- detection -----------------------------------------------------------------

const DAY = 24 * 60 * 60 * 1000
/** Only sessions seen this close to the restart count; ones lost weeks ago do not. */
export const WINDOW_MS = DAY
/** A SessionEnd this close before the boot came from the shutdown, not from the person. */
export const SHUTDOWN_MS = 10 * 60 * 1000
/** Two or more sessions ending this close together went down with their terminal. */
export const BURST_MS = 10 * 1000

/** When this machine booted. CROSSTALK_BOOT_TIME (ms since epoch) fakes it for tests. */
export function bootTime(env: NodeJS.ProcessEnv = process.env, now = Date.now()): number {
  const forced = Number(env.CROSSTALK_BOOT_TIME)
  if (forced > 0) return forced
  return now - os.uptime() * 1000
}

/**
 * Whether a session was ended on purpose.
 *
 * Claude Code names why a session ended. clear, logout and leaving at the
 * prompt are a person's choice. "other" is everything else, which includes a
 * terminal dying under it (SIGHUP), so it counts as a normal end only when it
 * stands alone: one tab closed. Several ending in the same few seconds, or any
 * ending in the minutes before a restart, is the terminal or the machine
 * going down.
 */
export function endedNormally(r: Rec, all: Rec[], boot: number): boolean {
  if (r.archived) return true
  if (!r.endedAt) return false
  if (r.endReason !== "other") return true
  if (r.endedAt < boot && boot - r.endedAt <= SHUTDOWN_MS) return false
  const burst = all.some(
    (o) =>
      o.sessionId !== r.sessionId &&
      o.endReason === "other" &&
      !!o.endedAt &&
      Math.abs(o.endedAt - r.endedAt!) <= BURST_MS,
  )
  return !burst
}

export type Ctx = {
  now: number
  boot: number
  all: Rec[]
  alive: (r: Rec) => boolean
  /** The sessions open when the machine went down, from the daemon's last note before the boot (noteOpen). */
  openAtDown?: Set<string>
}

const openFile = () => path.join(P.root, "open-now.json")

/** The daemon notes, every minute, which sessions are open: after a restart, exactly those come back. */
export function noteOpen(ids: string[], now = Date.now()) {
  try {
    fs.mkdirSync(P.root, { recursive: true, mode: 0o700 })
    const tmp = `${openFile()}.${process.pid}.tmp`
    fs.writeFileSync(tmp, JSON.stringify({ at: now, ids }), { mode: 0o600 })
    fs.renameSync(tmp, openFile())
  } catch {}
}

/** What was open when the machine went down: the last note before this boot, if it was taken within a day of it. */
export function openAtDown(boot: number): Set<string> | undefined {
  try {
    const o = JSON.parse(fs.readFileSync(openFile(), "utf8"))
    if (typeof o.at !== "number" || !Array.isArray(o.ids) || o.at >= boot || boot - o.at > WINDOW_MS) return undefined
    return new Set(o.ids.map(String))
  } catch {
    return undefined
  }
}

/**
 * Lost: not ended on purpose, its process gone, and seen recently.
 *
 * Before this boot, recently means within a day of the boot. Within this boot
 * (a force-quit or crashed terminal) it means within a day of now, and it only
 * applies to Claude Code: Codex has no SessionEnd hook, so a Codex session
 * that ended normally looks exactly like one that was lost, and is only
 * offered back across a restart.
 */
export function isLost(r: Rec, c: Ctx): boolean {
  if (r.interactive === false) return false
  if (endedNormally(r, c.all, c.boot)) return false
  const before = r.seenAt < c.boot
  const ref = before ? c.boot : c.now
  if (ref - r.seenAt > WINDOW_MS) return false
  // Across a restart: only what was open when it went down, not every session of the day before.
  if (before && c.openAtDown && !c.openAtDown.has(r.sessionId)) return false
  if (!before && r.client !== "claude") return false
  return !c.alive(r)
}

export function lostSessions(c: Ctx, self?: string): Rec[] {
  return order(c.all.filter((r) => r.sessionId !== self && isLost(r, c)))
}

/** Oldest first, which is the order they were opened in. */
const order = (rs: Rec[]) => [...rs].sort((a, b) => a.startedAt - b.startedAt)

// --- processes -----------------------------------------------------------------

function ps(pid: number, field: string): string | null {
  if (!pid || pid < 1) return null
  try {
    const r = spawnSync("ps", ["-o", `${field}=`, "-p", String(pid)], { encoding: "utf8", timeout: 2000 })
    if (r.status !== 0) return null
    return r.stdout.trim() || null
  } catch {
    return null
  }
}

/** Alive, and the same process: a pid reused since then has a different start time. */
export function pidAlive(pid: number, pidStart?: string): boolean {
  if (!pid || pid < 1) return false
  try {
    process.kill(pid, 0)
  } catch (e: any) {
    if (e?.code !== "EPERM") return false
  }
  if (!pidStart) return true
  const now = ps(pid, "lstart")
  return now === null ? true : now === pidStart
}

export const recAlive = (r: Rec) => pidAlive(r.pid, r.pidStart)

/**
 * For deciding whether to signal a process: "same" only when it is there and
 * its start time is known to match. pidAlive fails open (a ps that fails or
 * times out counts as the same process), which is right for "is it still
 * open" but never for a kill: here that is "unknown", and nothing is sent.
 */
export function pidState(pid: number, pidStart?: string): "same" | "gone" | "unknown" {
  if (!pid || pid < 1) return "gone"
  try {
    process.kill(pid, 0)
  } catch (e: any) {
    if (e?.code !== "EPERM") return "gone"
  }
  if (!pidStart) return "unknown"
  const now = ps(pid, "lstart")
  return now === null ? "unknown" : now === pidStart ? "same" : "gone"
}

export const SHELL = /^-?(sh|bash|zsh|dash|fish|ksh|tcsh|csh)$/

/**
 * The client's own process. Claude Code lists it in its session registry; for
 * anything else, walk up from the hook past the shells that ran it.
 */
export function sessionPid(sessionId: string): number {
  try {
    const reg = sessionsDir()
    for (const f of fs.readdirSync(reg)) {
      if (!f.endsWith(".json")) continue
      try {
        const e = JSON.parse(fs.readFileSync(path.join(reg, f), "utf8"))
        if (e.sessionId === sessionId && Number(e.pid) > 0) return Number(e.pid)
      } catch {}
    }
  } catch {}
  let pid = process.ppid
  for (let i = 0; i < 4; i++) {
    const comm = ps(pid, "comm")
    if (!comm || !SHELL.test(path.basename(comm))) break
    const up = Number(ps(pid, "ppid"))
    if (!up || up <= 1) break
    pid = up
  }
  return pid
}

// --- the terminal ----------------------------------------------------------------

/** Terminal.app's window id and tab index for a tty, by asking Terminal itself. */
export const appleLocateScript = (tty: string) =>
  [
    `tell application "Terminal"`,
    `\trepeat with w in windows`,
    `\t\tset n to 0`,
    `\t\trepeat with t in tabs of w`,
    `\t\t\tset n to n + 1`,
    `\t\t\tif (tty of t) is ${asq(tty)} then return ((id of w) as text) & " " & (n as text)`,
    `\t\tend repeat`,
    `\tend repeat`,
    `end tell`,
    `return ""`,
  ].join("\n")

/**
 * Everything the environment says about where this session is showing. With
 * `probe`, also ask tmux and Terminal.app for the window and tab, which costs
 * a process or two, so it is done when a session starts and at the end of a
 * turn, not on every tool call.
 */
export function captureTerminal(env: NodeJS.ProcessEnv, pid: number, probe: boolean): Term {
  const t: Term = {}
  if (env.TERM_PROGRAM) t.program = env.TERM_PROGRAM
  const tty = ps(pid, "tty")
  if (tty && !/^\?+$/.test(tty)) t.tty = tty.startsWith("/dev/") ? tty : `/dev/${tty}`
  if (env.TMUX && env.TMUX_PANE) {
    t.tmux = { pane: env.TMUX_PANE, socket: env.TMUX.split(",")[0] }
    if (probe) {
      const r = spawnSync(
        "tmux",
        ["display", "-p", "-t", env.TMUX_PANE, "#{session_name}\t#{window_index}\t#{pane_index}"],
        { encoding: "utf8", timeout: 2000, env },
      )
      const [s, w, p] = (r.stdout ?? "").trim().split("\t")
      if (r.status === 0 && s) Object.assign(t.tmux, { session: s, window: Number(w), paneIndex: Number(p) })
    }
  }
  if (env.KITTY_WINDOW_ID || env.KITTY_LISTEN_ON)
    t.kitty = { window: env.KITTY_WINDOW_ID, listenOn: env.KITTY_LISTEN_ON }
  if (env.WEZTERM_PANE) t.wezterm = { pane: env.WEZTERM_PANE }
  if (env.ITERM_SESSION_ID) {
    const m = /^w(\d+)t(\d+)p(\d+)/.exec(env.ITERM_SESSION_ID)
    t.iterm = { id: env.ITERM_SESSION_ID, ...(m ? { window: Number(m[1]), tab: Number(m[2]) } : {}) }
  }
  if (env.WT_SESSION) t.wt = { session: env.WT_SESSION }
  if (env.GNOME_TERMINAL_SCREEN || env.GNOME_TERMINAL_SERVICE) t.gnome = { ...(env.GNOME_TERMINAL_SCREEN ? { screen: env.GNOME_TERMINAL_SCREEN } : {}) }
  if (env.KONSOLE_DBUS_SESSION || env.KONSOLE_VERSION)
    t.konsole = { ...(env.KONSOLE_DBUS_SERVICE ? { service: env.KONSOLE_DBUS_SERVICE } : {}), ...(env.KONSOLE_DBUS_SESSION ? { session: env.KONSOLE_DBUS_SESSION } : {}) }
  if (env.VTE_VERSION) t.vte = env.VTE_VERSION
  if (env.ALACRITTY_WINDOW_ID || env.ALACRITTY_SOCKET || env.ALACRITTY_LOG) t.alacritty = { ...(env.ALACRITTY_WINDOW_ID ? { window: env.ALACRITTY_WINDOW_ID } : {}) }
  if (env.TERM_PROGRAM === "Apple_Terminal" || (env.TERM_SESSION_ID && !t.iterm)) {
    t.apple = { sessionId: env.TERM_SESSION_ID }
    if (probe && t.tty && process.platform === "darwin" && env.TERM_PROGRAM === "Apple_Terminal") {
      const r = spawnSync("osascript", ["-"], { input: appleLocateScript(t.tty), encoding: "utf8", timeout: 2500 })
      const [w, n] = (r.stdout ?? "").trim().split(" ").map(Number)
      if (r.status === 0 && w && n) Object.assign(t.apple, { window: w, tab: n })
    }
    if (env.TERM_PROGRAM !== "Apple_Terminal" && !t.apple.window) delete t.apple
  }
  return t
}

// --- what to run -----------------------------------------------------------------

/** One POSIX shell word. */
export const shq = (s: string) => (/^[A-Za-z0-9_@%+=:,./-]+$/.test(s) ? s : `'${s.replace(/'/g, `'\\''`)}'`)
/** One AppleScript string literal. */
export const asq = (s: string) => `"${s.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`

/** The command that brings a session back, or null for a client that cannot resume. */
export function resumeArgv(r: Rec, bin?: string): string[] | null {
  if (r.client === "claude") return [bin ?? "claude", "--resume", r.sessionId]
  if (r.client === "codex") return [bin ?? "codex", "resume", r.sessionId]
  return null
}

/** What a person would type: go to the folder, resume. */
export const typed = (r: Rec) => `cd ${shq(r.cwd)} && ${resumeArgv(r)!.map(shq).join(" ")}`

export type Kind = "tmux" | "apple" | "iterm" | "ghostty" | "kitty" | "wezterm" | "wt" | "gnome" | "konsole"

/**
 * Which terminal a tab is in, from what its environment said. tmux first:
 * inside tmux the tabs are tmux's windows, whatever terminal shows them.
 * Alacritty, xterm and VTE terminals other than GNOME Terminal have no tab a
 * script can open: null, so the commands to paste (or tmux, when inside it).
 */
export function kindOf(t: Term | undefined): Kind | null {
  if (!t) return null
  if (t.tmux) return "tmux"
  if (t.program === "Apple_Terminal") return "apple"
  if (t.program === "iTerm.app" || t.iterm) return "iterm"
  if (t.program === "ghostty") return "ghostty"
  if (t.kitty) return "kitty"
  if (t.wezterm || t.program === "WezTerm") return "wezterm"
  if (t.wt) return "wt"
  if (t.gnome) return "gnome"
  if (t.konsole) return "konsole"
  if (t.apple) return "apple"
  return null
}

/** The app macOS asks about: the one the hook runs inside. */
export function appName(t: Term | undefined): string {
  switch (t?.program) {
    case "Apple_Terminal":
      return "Terminal"
    case "iTerm.app":
      return "iTerm"
    case "ghostty":
      return "Ghostty"
    case "WezTerm":
      return "WezTerm"
    case "vscode":
      return "Visual Studio Code"
    default:
      return "the app crosstalk runs in"
  }
}

/**
 * One command to run. `detach`: started and left running, not waited for:
 * `konsole --new-tab` stays in the foreground for as long as its window is
 * open when no Konsole was running to take the tab.
 */
export type Step = { cmd: string; args: string[]; input?: string; detach?: boolean }
export type Plan = {
  kind: Kind | "manual"
  sessions: Rec[]
  steps: Step[]
  /** Opening tabs in this terminal types keys through System Events, which needs Accessibility. */
  needsAccessibility?: boolean
}

export type Env = {
  platform: NodeJS.Platform
  /** The asking session's terminal, used for any session whose own cannot be reached. */
  current: Term
  has: (bin: string) => boolean
  /** Absolute path of a binary, so terminals that exec directly need no PATH. */
  which: (bin: string) => string | undefined
  /** Whether a tmux session exists; `socket` names crosstalk's own server (`-L crosstalk`). */
  tmuxHasSession: (name: string, socket?: string) => boolean
  /** False to open one window per session instead of tabs (no Accessibility). */
  tabs: boolean
  /**
   * The repository a folder belongs to (every worktree of it the same one).
   * With it, restored tabs are grouped one window per repository, in their
   * original order; without it, one window per old window.
   */
  repoOf?: (cwd: string) => string
  /** A live tab already in that repository's window, to open the restored ones beside. */
  anchorFor?: (repo: string) => Term | null
  /** The last live tab of a thread in that repository, to open the thread's restored tabs right after. */
  threadAnchor?: (repo: string, thread: string, near: Term | null) => Term | null
}

/** crosstalk's own tmux server, for agents it runs in the background (src/spawn.ts). */
export const CROSSTALK_TMUX = "crosstalk"
const isCrosstalkSocket = (s?: string) => !!s && path.basename(s) === CROSSTALK_TMUX

/**
 * The tab whose window holds a repository's sessions: the asking session when
 * it is in the repo, else the most recently seen live session in it.
 */
export function anchorFor(
  repo: string,
  o: { recs: Rec[]; keyOf: (cwd: string) => string; asking?: { cwd: string; terminal: Term }; alive: (r: Rec) => boolean },
): Term | null {
  if (o.asking && kindOf(o.asking.terminal) && o.keyOf(o.asking.cwd) === repo) return o.asking.terminal
  const live = o.recs
    .filter((r) => !r.endedAt && r.interactive !== false && kindOf(r.terminal) && !isCrosstalkSocket(r.terminal.tmux?.socket) && o.keyOf(r.cwd) === repo && o.alive(r))
    .sort((a, b) => b.seenAt - a.seenAt)
  // No window of this repository's: the window the person is in, never a new window.
  return live[0]?.terminal ?? (o.asking && kindOf(o.asking.terminal) ? o.asking.terminal : null)
}

/** Whether two tabs are in the same window, as far as their terminal says. */
export function sameWindow(a: Term, b: Term): boolean {
  if (a.tmux || b.tmux) return !!a.tmux && !!b.tmux && (a.tmux.socket ?? "") === (b.tmux.socket ?? "") && !!a.tmux.session && a.tmux.session === b.tmux.session
  if (a.apple || b.apple) return a.apple?.window !== undefined && a.apple.window === b.apple?.window
  if (a.iterm || b.iterm) return a.iterm?.window !== undefined && a.iterm.window === b.iterm?.window
  if (a.kitty || b.kitty) return !!a.kitty && !!b.kitty && (a.kitty.listenOn ?? "") === (b.kitty.listenOn ?? "")
  return kindOf(a) === kindOf(b)
}

/**
 * The tab a thread's new tab goes right after: the last live tab of that
 * thread in the repository, in the same window as `near` (the window the new
 * tabs go into) when there is one. Last is the highest tmux window index
 * (`indexOf` asks tmux for it now; the recorded one may have moved), else the
 * most recently started. The asking session counts as one of the thread's
 * tabs when it is in the thread, even before its record says so.
 */
export function threadAnchorFor(
  repo: string,
  thread: string,
  o: {
    recs: Rec[]
    keyOf: (cwd: string) => string
    alive: (r: Rec) => boolean
    near?: Term | null
    asking?: { sessionId?: string; cwd: string; terminal: Term; inThread?: boolean }
    indexOf?: (t: Term) => number | undefined
  },
): Term | null {
  if (!thread) return null
  const a = o.asking
  const cands: { t: Term; startedAt: number }[] = []
  for (const r of o.recs) {
    const mine = !!a?.sessionId && r.sessionId === a.sessionId
    if (r.thread !== thread && !(mine && a?.inThread)) continue
    if (r.endedAt || r.interactive === false || isCrosstalkSocket(r.terminal.tmux?.socket)) continue
    const t = mine && kindOf(a!.terminal) ? a!.terminal : r.terminal
    if (!kindOf(t) || o.keyOf(r.cwd) !== repo || !(mine || o.alive(r))) continue
    cands.push({ t, startedAt: r.startedAt })
  }
  if (a && a.inThread && kindOf(a.terminal) && o.keyOf(a.cwd) === repo && !cands.some((c) => c.t === a.terminal)) cands.push({ t: a.terminal, startedAt: Infinity })
  const here = o.near ? cands.filter((c) => sameWindow(c.t, o.near!)) : cands
  if (!here.length) return null
  const idx = (t: Term) => (t.tmux ? (o.indexOf?.(t) ?? t.tmux.window ?? -1) : -1)
  here.sort((x, y) => idx(y.t) - idx(x.t) || y.startedAt - x.startedAt)
  return here[0].t
}

/**
 * Tabs that all go right after the same tab are opened last first: each new
 * one lands directly after that tab, pushing the ones before it along, so
 * they end up in order. Runs of the same key are reversed; the rest stay.
 */
export function lastFirst<T>(xs: T[], key: (x: T) => string | undefined): T[] {
  const out: T[] = []
  let run: T[] = []
  let k: string | undefined
  const end = () => {
    out.push(...run.reverse())
    run = []
  }
  for (const x of xs) {
    const kx = key(x)
    if (kx === undefined) {
      end()
      out.push(x)
      k = undefined
      continue
    }
    if (kx !== k) end()
    k = kx
    run.push(x)
  }
  end()
  return out
}

/**
 * Repository, then thread, then the order given: a thread's tabs together
 * where its first one was. Tabs in no thread stay where they are.
 */
export function byRepoThread<T extends { cwd: string; sessionId: string; thread?: string }>(rs: T[], repoOf?: (cwd: string) => string): T[] {
  const rank = new Map<string, number>()
  const key = (r: T) => `${repoOf ? repoOf(r.cwd) : ""}\t${r.thread ? `t:${r.thread}` : `s:${r.sessionId}`}`
  const repoRank = new Map<string, number>()
  rs.forEach((r, i) => {
    const rk = repoOf ? repoOf(r.cwd) : ""
    if (!repoRank.has(rk)) repoRank.set(rk, i)
    if (!rank.has(key(r))) rank.set(key(r), i)
  })
  return rs
    .map((r, i) => ({ r, i }))
    .sort((x, y) => repoRank.get(repoOf ? repoOf(x.r.cwd) : "")! - repoRank.get(repoOf ? repoOf(y.r.cwd) : "")! || rank.get(key(x.r))! - rank.get(key(y.r))! || x.i - y.i)
    .map((x) => x.r)
}

/**
 * Terminal.app, into a window by its AppleScript id: brought to the front, then
 * a tab per command. Terminal cannot move a tab between windows, so this only
 * places new ones. Falls back to a window each if System Events refuses.
 */
export function appleIntoWindowScript(cmds: string[], window: number, tabs: boolean): string {
  // That window gone: one new window, the rest tabs in it (appleTerminalScript).
  const L = [
    `set crosstalkFallback to ""`,
    `set crosstalkOpened to 0`,
    `set crosstalkNew to false`,
    `tell application "Terminal"`,
    `\tif not (exists window id ${window}) then`,
    `\t\tset crosstalkNew to true`,
    `\telse`,
    `\t\tset index of window id ${window} to 1`,
    `\t\tactivate`,
    `\tend if`,
    `end tell`,
  ]
  cmds.forEach((c, i) => {
    if (!tabs) {
      L.push(`tell application "Terminal" to do script ${asq(c)}`, `set crosstalkOpened to crosstalkOpened + 1`)
      return
    }
    if (i === 0) L.push(`if crosstalkNew then`, `\ttell application "Terminal"`, `\t\tactivate`, `\t\tdo script ${asq(c)}`, `\tend tell`, `\tset crosstalkOpened to 1`, `else`, ...tabTry(c), `end if`)
    else L.push(...tabTry(c))
  })
  L.push(`return "done " & crosstalkFallback & " " & crosstalkOpened`)
  return L.join("\n")
}

/**
 * One new tab, only while every one before it opened. A tab that cannot open
 * (Terminal not in front, or no permission) stops the rest: they stay closed,
 * to open as tabs next time, never a window each.
 */
function tabTry(c: string): string[] {
  return [
    `if crosstalkFallback is "" then`,
    `\ttry`,
    ...appleNewTabLines(c),
    `\t\tset crosstalkOpened to crosstalkOpened + 1`,
    `\ton error errMsg number errNum`,
    `\t\tset crosstalkFallback to (errNum as text)`,
    `\tend try`,
    `end if`,
  ]
}

/** iTerm2: tabs in the window showing that tty, else a new window. */
export function itermIntoWindowScript(cmds: string[], tty: string | undefined): string {
  const L = [`tell application "iTerm2"`, `\tset w to missing value`]
  if (tty)
    L.push(
      `\trepeat with aw in windows`,
      `\t\trepeat with t in tabs of aw`,
      `\t\t\trepeat with s in sessions of t`,
      `\t\t\t\tif (tty of s) is ${asq(tty)} then set w to aw`,
      `\t\t\tend repeat`,
      `\t\tend repeat`,
      `\tend repeat`,
    )
  L.push(
    `\tif w is missing value then`,
    `\t\tset w to (create window with default profile)`,
    `\t\ttell current session of w to write text ${asq(cmds[0])}`,
    `\telse`,
    `\t\ttell w`,
    `\t\t\tset t to (create tab with default profile)`,
    `\t\t\ttell current session of t to write text ${asq(cmds[0])}`,
    `\t\tend tell`,
    `\tend if`,
  )
  for (const c of cmds.slice(1)) L.push(`\ttell w`, `\t\tset t to (create tab with default profile)`, `\t\ttell current session of t to write text ${asq(c)}`, `\tend tell`)
  L.push(`end tell`, `return "done "`)
  return L.join("\n")
}

const unixLike = (p: NodeJS.Platform) => p !== "darwin" && p !== "win32"

/**
 * Whether crosstalk can open a tab in this terminal from here. The macOS
 * terminals go through osascript, so never anywhere else; kitty only with
 * remote control listening on a socket (KITTY_LISTEN_ON).
 */
export function canDrive(k: Kind, e: Env, t: Term | undefined): boolean {
  switch (k) {
    case "tmux":
      return e.has("tmux")
    case "apple":
    case "iterm":
    case "ghostty":
      return e.platform === "darwin" && e.has("osascript")
    case "kitty":
      return (e.has("kitten") || e.has("kitty")) && !!(t?.kitty?.listenOn ?? e.current.kitty?.listenOn)
    case "wezterm":
      return e.has("wezterm")
    case "wt":
      return e.platform === "win32" && e.has("wt")
    case "gnome":
      return unixLike(e.platform) && e.has("gnome-terminal")
    case "konsole":
      return unixLike(e.platform) && e.has("konsole")
  }
}

// --- new tabs on Linux and Windows: one command each, built here so they can be checked as data ---

/** kitty's remote-control client: `kitten`, or `kitty` itself where kitten is not installed. */
export const kittyBin = (e: Pick<Env, "has">) => (e.has("kitten") ? "kitten" : "kitty")

/** Windows Terminal reads `;` as its own command separator. */
const wtArg = (s: string) => s.replace(/;/g, "\\;")

/** Windows Terminal: a new tab in the current window (`-w 0`), in `cwd`. */
export const wtTabStep = (cwd: string, argv: string[]): Step => ({ cmd: "wt.exe", args: ["-w", "0", "new-tab", "-d", wtArg(cwd), ...argv.map(wtArg)] })

/** GNOME Terminal: a tab in its most recent window; the client returns once the server has opened it. */
export const gnomeTabStep = (cwd: string, argv: string[]): Step => ({ cmd: "gnome-terminal", args: ["--tab", `--working-directory=${cwd}`, "--", ...argv] })

/** Konsole: a tab in the running Konsole; `-e` takes the rest as the command. Detached, see Step. */
export const konsoleTabStep = (cwd: string, argv: string[]): Step => ({ cmd: "konsole", args: ["--new-tab", "--workdir", cwd, "-e", ...argv], detach: true })

const usable = canDrive

/** Which adapter a session goes to: its own terminal, else the asking one's, else none. */
export function adapterFor(r: Rec, e: Env): Kind | "manual" {
  if (/[\n\r\0]/.test(r.cwd) || !r.cwd) return "manual"
  const own = kindOf(r.terminal)
  if (own && usable(own, e, r.terminal)) return own
  const cur = kindOf(e.current)
  if (cur && usable(cur, e, e.current)) return cur
  return "manual"
}

const groupBy = <T>(xs: T[], key: (x: T) => string) => {
  const m = new Map<string, T[]>()
  for (const x of xs) m.set(key(x), [...(m.get(key(x)) ?? []), x])
  return m
}
const num = (n: number | undefined) => (n === undefined || Number.isNaN(n) ? Infinity : n)

/**
 * Cmd-T in Terminal.app, then the command in the tab it opened. Cmd-T goes to
 * whatever is in front, so it is sent only while Terminal is, and the command
 * is typed only once the front window has one tab more and its selected tab
 * shows a new tty: otherwise focus moved, and typing "in selected tab" could
 * land in a tab that is already running something (another claude). Then it
 * gets a window of its own instead (`do script` alone), and the script
 * reports why.
 */
export function appleNewTabLines(c: string): string[] {
  return [
    `\t\tdelay 0.3`,
    // Bring Terminal to the front first: after System Settings, or from a
    // detached waiter, macOS may not let \`activate\` alone take focus.
    `\t\trepeat 10 times`,
    `\t\t\tif frontmost of application "Terminal" then exit repeat`,
    `\t\t\ttell application "Terminal" to activate`,
    `\t\t\ttry`,
    `\t\t\t\ttell application "System Events" to set frontmost of process "Terminal" to true`,
    `\t\t\tend try`,
    `\t\t\tdelay 0.3`,
    `\t\tend repeat`,
    `\t\ttell application "Terminal"`,
    `\t\t\tif not frontmost then error "Terminal is not in front" number 1001`,
    `\t\t\tset crosstalkWin to id of front window`,
    `\t\t\tset crosstalkTabs to count of tabs of front window`,
    `\t\t\tset crosstalkTty to tty of selected tab of front window`,
    `\t\tend tell`,
    `\t\ttell application "System Events" to key code 17 using command down`,
    `\t\tdelay 0.6`,
    `\t\ttell application "Terminal"`,
    `\t\t\tif (id of front window) is not crosstalkWin or (count of tabs of front window) is not (crosstalkTabs + 1) or (tty of selected tab of front window) is crosstalkTty then error "the new tab did not open where expected" number 1001`,
    `\t\t\tdo script ${asq(c)} in selected tab of front window`,
    `\t\tend tell`,
  ]
}

/**
 * Terminal.app, one window. The first session opens the window; each next one
 * is a new tab (Cmd-T through System Events, the only way Terminal opens a tab
 * from a script) running its command. If a tab cannot open, the rest stay
 * closed (never a window each), and the script returns the error number and
 * how many opened: `done <error> <opened>`.
 */
export function appleTerminalScript(cmds: string[], tabs: boolean): string {
  const L: string[] = [`set crosstalkFallback to ""`, `set crosstalkOpened to 1`, `tell application "Terminal"`, `\tactivate`, `\tdo script ${asq(cmds[0])}`, `end tell`]
  for (const c of cmds.slice(1)) {
    if (!tabs) L.push(`tell application "Terminal" to do script ${asq(c)}`, `set crosstalkOpened to crosstalkOpened + 1`)
    else L.push(...tabTry(c))
  }
  L.push(`return "done " & crosstalkFallback & " " & crosstalkOpened`)
  return L.join("\n")
}

/** iTerm2 opens tabs through its own scripting, so it needs no Accessibility. */
export function itermScript(cmds: string[]): string {
  const L = [`tell application "iTerm2"`, `\tactivate`, `\tset w to (create window with default profile)`, `\ttell current session of w to write text ${asq(cmds[0])}`]
  for (const c of cmds.slice(1))
    L.push(`\ttell w`, `\t\tset t to (create tab with default profile)`, `\t\ttell current session of t to write text ${asq(c)}`, `\tend tell`)
  L.push(`end tell`, `return "done "`)
  return L.join("\n")
}

/** Ghostty has no tab scripting: a new window, then Cmd-T and the command typed. */
export function ghosttyScript(cmds: string[]): string {
  const L = [`set crosstalkFallback to ""`, `tell application "Ghostty" to activate`, `delay 0.5`, `try`]
  cmds.forEach((c, i) => {
    // Ghostty in front before every keystroke: otherwise the command would be typed into another app.
    const front = [
      `\trepeat 10 times`,
      `\t\tif frontmost of application "Ghostty" then exit repeat`,
      `\t\ttell application "Ghostty" to activate`,
      `\t\tdelay 0.2`,
      `\tend repeat`,
      `\tif not (frontmost of application "Ghostty") then error "Ghostty is not in front" number 1001`,
    ]
    L.push(
      ...front,
      `\ttell application "System Events" to key code ${i === 0 ? 45 : 17} using command down`,
      `\tdelay 0.8`,
      ...front,
      `\ttell application "System Events"`,
      `\t\tkeystroke ${asq(c)}`,
      `\t\tkey code 36`,
      `\tend tell`,
    )
  })
  L.push(`on error errMsg number errNum`, `\tset crosstalkFallback to (errNum as text)`, `end try`, `return "done " & crosstalkFallback`)
  return L.join("\n")
}

export function plan(recs: Rec[], e: Env): { plans: Plan[]; skipped: Rec[] } {
  const skipped = recs.filter((r) => !resumeArgv(r))
  const ok = order(recs.filter((r) => resumeArgv(r)))
  const byKind = groupBy(ok, (r) => adapterFor(r, e))
  const plans: Plan[] = []
  const exec = (r: Rec) => resumeArgv(r, e.which(r.client === "codex" ? "codex" : "claude"))!

  // One window per repository, repositories in the order their first session
  // was opened, tabs in their old order. Without repoOf, one window per old window.
  const repoOf = e.repoOf
  const repoFirst = new Map<string, number>()
  if (repoOf) for (const r of ok) if (!repoFirst.has(repoOf(r.cwd))) repoFirst.set(repoOf(r.cwd), r.startedAt)
  const byRepo = <T extends Rec>(rs: T[], oldWindow: (r: T) => string) => {
    const groups = groupBy(rs, (r) => (repoOf ? repoOf(r.cwd) : oldWindow(r)))
    const keys = [...groups.keys()].sort((a, b) => (repoOf ? repoFirst.get(a)! - repoFirst.get(b)! : num(Number(a)) - num(Number(b))))
    return keys.map((k) => ({ key: k, recs: groups.get(k)!, anchor: repoOf ? (e.anchorFor?.(k) ?? null) : null }))
  }
  const inRepoOrder = (rs: Rec[]) => byRepo(rs, () => "").flatMap((x) => x.recs)

  for (const [kind, rs] of byKind) {
    if (kind === "tmux") {
      // One group per tmux session, windows in their old order. Agents crosstalk
      // ran in its own server go back there, each in its tmux session.
      const groups = groupBy(rs, (r) => `${isCrosstalkSocket(r.terminal.tmux?.socket) ? "L" : ""}\t${r.terminal.tmux?.session ?? e.current.tmux?.session ?? "crosstalk"}`)
      for (const [key, g] of groups) {
        const [own, name] = key.split("\t")
        const S = own ? ["-L", CROSSTALK_TMUX] : []
        const sorted = byRepoThread(
          [...g].sort(
            (a, b) =>
              num(a.terminal.tmux?.window) - num(b.terminal.tmux?.window) ||
              num(a.terminal.tmux?.paneIndex) - num(b.terminal.tmux?.paneIndex) ||
              a.startedAt - b.startedAt,
          ),
          repoOf,
        )
        let exists = own ? e.tmuxHasSession(name, CROSSTALK_TMUX) : e.tmuxHasSession(name)
        // A thread with a live tab in this tmux session: its restored tabs right after that one.
        const near: Term = { tmux: { pane: "", session: name, socket: g.find((r) => r.terminal.tmux?.socket)?.terminal.tmux?.socket } }
        const after = (r: Rec) => {
          if (own || !exists || !r.thread || !repoOf) return undefined
          return e.threadAnchor?.(repoOf(r.cwd), r.thread, near)?.tmux?.windowId || undefined
        }
        const items = sorted.map((r) => ({ r, after: after(r) }))
        const steps: Step[] = []
        for (const { r, after: at } of lastFirst(items, (x) => x.after)) {
          const cmd = exec(r).map(shq).join(" ")
          if (!exists) {
            exists = true
            steps.push({ cmd: "tmux", args: [...S, "new-session", "-d", "-s", name, "-c", r.cwd, cmd] })
          } else if (at) steps.push({ cmd: "tmux", args: [...S, "new-window", "-d", "-a", "-t", at, "-c", r.cwd, cmd] })
          else steps.push({ cmd: "tmux", args: [...S, "new-window", "-d", "-t", `=${name}:`, "-c", r.cwd, cmd] })
        }
        plans.push({ kind: "tmux", sessions: sorted, steps })
      }
    } else if (kind === "apple") {
      // One window for all of them, never a window per repository: the window
      // already holding one of their repositories (else the one asking), tabs
      // grouped by repository, then thread. Terminal.app only adds tabs at the end.
      const groups = byRepo(rs, (r) => String(r.terminal.apple?.window ?? "?"))
      const g = groups.flatMap(({ recs }) =>
        byRepoThread([...recs].sort((a, b) => num(a.terminal.apple?.window) - num(b.terminal.apple?.window) || num(a.terminal.apple?.tab) - num(b.terminal.apple?.tab) || a.startedAt - b.startedAt)),
      )
      const into = groups.find((x) => x.anchor?.apple?.window)?.anchor?.apple?.window ?? e.current.apple?.window
      const tabs = e.tabs && (g.length > 1 || !!into)
      plans.push({
        kind: "apple",
        sessions: g,
        needsAccessibility: tabs,
        steps: [{ cmd: "osascript", args: ["-"], input: into ? appleIntoWindowScript(g.map(typed), into, e.tabs) : appleTerminalScript(g.map(typed), tabs) }],
      })
    } else if (kind === "iterm") {
      // iTerm2 too: one window, tabs at its end, grouped by repository then thread.
      const groups = byRepo(rs, (r) => String(r.terminal.iterm?.window ?? "?"))
      const g = groups.flatMap(({ recs }) =>
        byRepoThread([...recs].sort((a, b) => num(a.terminal.iterm?.window) - num(b.terminal.iterm?.window) || num(a.terminal.iterm?.tab) - num(b.terminal.iterm?.tab) || a.startedAt - b.startedAt)),
      )
      const tty = groups.find((x) => x.anchor?.tty)?.anchor?.tty ?? e.current.tty
      plans.push({ kind: "iterm", sessions: g, steps: [{ cmd: "osascript", args: ["-"], input: tty ? itermIntoWindowScript(g.map(typed), tty) : itermScript(g.map(typed)) }] })
    } else if (kind === "ghostty") {
      const g = byRepoThread(inRepoOrder(rs), repoOf)
      if (e.tabs) plans.push({ kind: "ghostty", sessions: g, needsAccessibility: true, steps: [{ cmd: "osascript", args: ["-"], input: ghosttyScript(g.map(typed)) }] })
      else plans.push({ kind: "manual", sessions: g, steps: [] })
    } else if (kind === "kitty") {
      const to = e.current.kitty?.listenOn ?? rs[0].terminal.kitty?.listenOn!
      for (const { key, recs: unordered, anchor } of byRepo(rs, () => "")) {
        const recs = byRepoThread(unordered)
        const match = anchor?.kitty?.window ? ["--match", `window_id:${anchor.kitty.window}`] : []
        // A thread with a live tab: right after it (--location=after, the matched tab's neighbour).
        const after = (r: Rec) => (r.thread && repoOf ? e.threadAnchor?.(key, r.thread, anchor)?.kitty?.window : undefined) || undefined
        const items = recs.map((r) => ({ r, after: after(r) }))
        plans.push({
          kind: "kitty",
          sessions: recs,
          steps: lastFirst(items, (x) => x.after).map(({ r, after: w }) => ({
            cmd: kittyBin(e),
            args: ["@", "--to", to, "launch", "--type=tab", ...(w ? ["--location=after", "--match", `window_id:${w}`] : match), "--cwd", r.cwd, ...exec(r)],
          })),
        })
      }
    } else if (kind === "wezterm") {
      for (const { key, recs: unordered, anchor } of byRepo(rs, () => "")) {
        const recs = byRepoThread(unordered)
        // `wezterm cli` has no way to move a tab: into the thread's window, at its end.
        const at = (r: Rec) => {
          const p = (r.thread && repoOf ? e.threadAnchor?.(key, r.thread, anchor)?.wezterm?.pane : undefined) ?? anchor?.wezterm?.pane
          return p ? ["--pane-id", p] : []
        }
        plans.push({
          kind: "wezterm",
          sessions: recs,
          steps: recs.map((r) => ({ cmd: "wezterm", args: ["cli", "spawn", ...at(r), "--cwd", r.cwd, "--", ...exec(r)] })),
        })
      }
    } else if (kind === "wt" || kind === "gnome" || kind === "konsole") {
      // No window to aim at: each a tab of the window in front, by repository, then thread.
      const step = kind === "wt" ? wtTabStep : kind === "gnome" ? gnomeTabStep : konsoleTabStep
      const g = byRepoThread(inRepoOrder(rs), repoOf)
      plans.push({ kind, sessions: g, steps: g.map((r) => step(r.cwd, exec(r))) })
    } else {
      plans.push({ kind: "manual", sessions: rs, steps: [] })
    }
  }
  return { plans, skipped }
}

// --- permissions (macOS) -------------------------------------------------------

export type Pane = "accessibility" | "automation"

export const SETTINGS_URL: Record<Pane, string> = {
  accessibility: "x-apple.systempreferences:com.apple.preference.security?Privacy_Accessibility",
  automation: "x-apple.systempreferences:com.apple.preference.security?Privacy_Automation",
}

/** What an osascript failure was about, from its error number or text. */
export function classifyOsaError(text: string): Pane | null {
  if (/-1743\b|not authori[sz]ed to send apple events/i.test(text)) return "automation"
  // 1002 is what System Events answers a keystroke with when it may not type.
  if (/-25211\b|-1719\b|^1002$|\(1002\)|assistive access|not allowed to send keystrokes|accessibility/i.test(text.trim()))
    return "accessibility"
  return null
}

/** Settings is only ever opened because the person just asked to restore, and not twice in a row. */
export const REOPEN_SETTINGS_MS = 2 * 60 * 1000
export function shouldOpenSettings(o: { pane: Pane; userAction: boolean; state: State; now: number }): boolean {
  if (!o.userAction) return false
  const last = o.state.settingsOpened?.[o.pane]
  return !(last && o.now - last < REOPEN_SETTINGS_MS)
}

/** The steps, in words, for turning a permission on. */
export function permissionSteps(pane: Pane, app: string): string[] {
  return pane === "accessibility"
    ? [
        `System Settings → Privacy & Security → Accessibility → turn on ${app}`,
        `open "${SETTINGS_URL.accessibility}"`,
      ]
    : [
        `System Settings → Privacy & Security → Automation → ${app} → turn on System Events`,
        `open "${SETTINGS_URL.automation}"`,
      ]
}

const JXA_AX = `ObjC.import("ApplicationServices"); var f; try { f = $.AXIsProcessTrusted() } catch (e) { ObjC.bindFunction("AXIsProcessTrusted", ["bool", []]); f = $.AXIsProcessTrusted() } f ? "yes" : "no"`
/**
 * Whether the app crosstalk runs in may type keys, asked without asking the
 * person: AXIsProcessTrusted only reports, it never prompts. null when unknown.
 */
export function accessibilityGranted(): boolean | null {
  if (process.platform !== "darwin") return null
  const forced = process.env.CROSSTALK_FAKE_ACCESSIBILITY
  if (forced) return forced === "yes"
  const r = spawnSync("osascript", ["-l", "JavaScript", "-e", JXA_AX], { encoding: "utf8", timeout: 3000 })
  const out = (r.stdout ?? "").trim()
  return out === "yes" ? true : out === "no" ? false : null
}

const JXA_AUTOMATION = `ObjC.import("Foundation"); ObjC.import("CoreServices");
var d = $.NSAppleEventDescriptor.descriptorWithBundleIdentifier("com.apple.systemevents");
String($.AEDeterminePermissionToAutomateTarget(d.aeDesc, 0x2A2A2A2A, 0x2A2A2A2A, false))`
/**
 * Whether the app crosstalk runs in may control System Events, without
 * prompting: AEDeterminePermissionToAutomateTarget with askUserIfNeeded false.
 * "ask" means macOS has not been asked yet and will ask on the first restore.
 */
export function automationGranted(): "yes" | "no" | "ask" | null {
  if (process.platform !== "darwin") return null
  const r = spawnSync("osascript", ["-l", "JavaScript", "-e", JXA_AUTOMATION], { encoding: "utf8", timeout: 3000 })
  const code = Number((r.stdout ?? "").trim())
  if (r.status !== 0 || Number.isNaN(code)) return null
  if (code === 0) return "yes"
  if (code === -1743) return "no"
  if (code === -1744) return "ask"
  return null
}

function openSettings(pane: Pane) {
  if (process.env.CROSSTALK_NO_OPEN) return
  spawnSync("open", [SETTINGS_URL[pane]], { timeout: 5000 })
}

function notify(text: string) {
  if (process.platform !== "darwin" || process.env.CROSSTALK_NO_OPEN) return
  spawnSync("osascript", ["-e", `display notification ${asq(text)} with title "crosstalk"`], { timeout: 5000 })
}

// --- doing it --------------------------------------------------------------------

/**
 * A binary on PATH. On Windows by PATHEXT (`wt` is wt.exe, `claude` is
 * claude.exe or npm's claude.cmd): the bare name there is npm's sh script,
 * which nothing on Windows can run.
 */
export function which(bin: string, env: NodeJS.ProcessEnv = process.env, platform: NodeJS.Platform = process.platform, exists: (p: string) => boolean = executable): string | undefined {
  const win = platform === "win32"
  const exts = win && !path.extname(bin) ? (env.PATHEXT ?? ".COM;.EXE;.BAT;.CMD").split(";").filter(Boolean) : [""]
  const join = win ? path.win32.join : path.posix.join
  for (const d of (env.PATH ?? env.Path ?? "").split(win ? ";" : ":")) {
    if (!d) continue
    for (const x of exts) {
      const p = join(d, bin + x.toLowerCase())
      if (exists(p)) return p
    }
  }
  return undefined
}

function executable(p: string): boolean {
  try {
    fs.accessSync(p, fs.constants.X_OK)
    return true
  } catch {
    return false
  }
}

export function liveEnv(env: NodeJS.ProcessEnv, tabs: boolean): Env {
  return {
    platform: process.platform,
    current: captureTerminal(env, process.pid, true),
    has: (b) => !!which(b),
    which: (b) => which(b),
    tmuxHasSession: (name, socket) =>
      spawnSync("tmux", [...(socket ? ["-L", socket] : []), "has-session", "-t", `=${name}`], { stdio: "ignore", timeout: 2000, env: socket ? { ...env, TMUX: "" } : env }).status === 0,
    tabs,
    repoOf: (cwd) => repoKey(cwd),
    anchorFor: (repo) => anchorFor(repo, { recs: readAll(), keyOf: (cwd) => repoKey(cwd), alive: recAlive }),
    threadAnchor: (repo, thread, near) =>
      withWindowId(threadAnchorFor(repo, thread, { recs: readAll(), keyOf: (cwd) => repoKey(cwd), alive: recAlive, near, indexOf: (t) => tmuxWindowIndex(t, env) }), env),
  }
}

/** A tmux pane's window now, from tmux itself: its index and id (`@3`). */
export function tmuxWindowOf(t: Term, env: NodeJS.ProcessEnv = process.env): { index: number; id: string } | undefined {
  if (!t.tmux?.pane) return undefined
  const r = spawnSync("tmux", [...(t.tmux.socket ? ["-S", t.tmux.socket] : []), "display-message", "-p", "-t", t.tmux.pane, "#{window_index}\t#{window_id}"], { encoding: "utf8", timeout: 2000, env })
  const [i, id] = (r.status === 0 ? String(r.stdout).trim() : "").split("\t")
  const n = Number(i)
  return i && Number.isFinite(n) && id?.startsWith("@") ? { index: n, id } : undefined
}

export const tmuxWindowIndex = (t: Term, env: NodeJS.ProcessEnv = process.env) => tmuxWindowOf(t, env)?.index

/** A thread's tab, with its tmux window id looked up now: what `new-window -a -t` takes (a pane id it refuses). */
export function withWindowId(t: Term | null, env: NodeJS.ProcessEnv = process.env): Term | null {
  if (!t?.tmux || t.tmux.windowId) return t
  const w = tmuxWindowOf(t, env)
  return w ? { ...t, tmux: { ...t.tmux, windowId: w.id, window: w.index } } : t
}

/** The thread a session is in, as its hook heard from the daemon: kept on its record, written only when it changes. */
export function noteThread(sessionId: string, thread: string | undefined) {
  const r = readOne(sessionId)
  if (!r || (r.thread ?? "") === (thread ?? "")) return
  const { thread: _old, ...rest } = r
  writeRec(thread ? { ...rest, thread } : rest)
}

const label = (r: Rec) => r.name && !/^session-\d+$/.test(r.name) ? r.name : path.basename(r.cwd) || r.sessionId.slice(0, 8)
export const names = (rs: Rec[], max = 4) =>
  rs.slice(0, max).map(label).join(", ") + (rs.length > max ? ", …" : "")

export const commandsFile = () => path.join(P.root, "restore-commands.sh")

export function ctxNow(): Ctx {
  const now = Date.now()
  const boot = bootTime(process.env, now)
  const down = openAtDown(boot)
  return { now, boot, all: readAll(), alive: recAlive, ...(down ? { openAtDown: down } : {}) }
}

/** The question, for the first session opened. Null when there is nothing to ask. */
export function question(lost: Rec[], boot: number, current: Term): string | null {
  if (!lost.length) return null
  const n = lost.length
  const restart = lost.some((r) => r.seenAt < boot)
  const what = `${n} session${n === 1 ? " was" : "s were"} open ${restart ? "before the restart" : "when they were cut off"}`
  const k = kindOf(current)
  const firstTime =
    (k === "apple" || k === "ghostty") && process.platform === "darwin" && !loadState().tabsWorked && n > 1
      ? ` The first time, macOS asks whether ${appName(current)} may control System Events: allow it, so they open as tabs.`
      : ""
  return `◢ crosstalk: ${what} (${names(lost)}). Say "restore them" to bring ${n === 1 ? "it" : "them"} back.${firstTime}`
}

/**
 * Put the question once. Marks each lost session as asked, under a lock so two
 * sessions opened at the same moment do not both ask.
 */
export function askOnce(self: string, current: Term): string | null {
  return askOnceOffer(self, current)?.text ?? null
}

/** The question as askOnce puts it, with what the mod's picker needs to put it its own way. */
export type Offer = { text: string; count: number; names: string[]; restart: boolean; /** How many were used in the last few hours before the newest: offered alone as "Only the recent N". */ recent?: number }

/** How long before the most recently used lost session the others still count as recent. */
export const RECENT_MS = () => Number(process.env.CROSSTALK_RESTORE_RECENT_MS ?? 4 * 3600_000)

/** The lost sessions used close to the last one: the work in hand when it stopped. */
export function recentOf<T extends Pick<Rec, "seenAt">>(lost: T[], ms = RECENT_MS()): T[] {
  if (!lost.length) return []
  const newest = Math.max(...lost.map((r) => r.seenAt))
  return lost.filter((r) => newest - r.seenAt <= ms)
}

/** askOnce, keeping what it claimed, for a surface that phrases the question itself. */
export function askOnceOffer(self: string, current: Term): Offer | null {
  const c = ctxNow()
  const lost = lostSessions(c, self)
  if (!lost.some((r) => !r.askedAt)) return null
  const lock = path.join(dir(), ".asking")
  try {
    fs.mkdirSync(dir(), { recursive: true, mode: 0o700 })
    try {
      if (Date.now() - fs.statSync(lock).mtimeMs > 30_000) fs.rmdirSync(lock)
    } catch {}
    fs.mkdirSync(lock)
  } catch {
    return null
  }
  try {
    const fresh = lostSessions(ctxNow(), self)
    if (!fresh.some((r) => !r.askedAt)) return null
    for (const r of fresh) if (!r.askedAt) writeRec({ ...r, askedAt: Date.now() })
    const text = question(fresh, c.boot, current)
    if (!text) return null
    return {
      text,
      count: fresh.length,
      names: fresh.slice(0, 4).map(label).concat(fresh.length > 4 ? ["…"] : []),
      restart: fresh.some((r) => r.seenAt < c.boot),
      recent: recentOf(fresh).length,
    }
  } finally {
    try {
      fs.rmdirSync(lock)
    } catch {}
  }
}

export type Outcome = { ok: boolean; text: string; lost: Rec[]; restored: Rec[] }

/** What would be reopened, without doing it. */
export function describe(self: string | undefined, env: NodeJS.ProcessEnv = process.env, dry = false): Outcome {
  const lost = lostSessions(ctxNow(), self)
  if (!lost.length) return { ok: true, text: "◢ crosstalk: nothing to restore.", lost, restored: [] }
  const lines = [`◢ crosstalk: ${lost.length} session${lost.length === 1 ? "" : "s"} to restore:`]
  for (const r of lost) lines.push(`  ${label(r).padEnd(16)} ${r.cwd}  (${r.client}${resumeArgv(r) ? "" : ", cannot resume"})`)
  if (dry) {
    const { plans } = plan(lost, liveEnv(env, true))
    for (const p of plans) {
      lines.push("", `  ${p.kind}: ${p.sessions.map(label).join(", ")}${p.needsAccessibility ? "  (tabs need Accessibility)" : ""}`)
      if (p.kind === "manual") for (const r of p.sessions) lines.push(`    ${typed(r)}`)
      for (const s of p.steps) {
        lines.push(`    $ ${[s.cmd, ...s.args].map(shq).join(" ")}`)
        if (s.input) lines.push(...s.input.split("\n").map((l) => `      ${l}`))
      }
    }
  }
  return { ok: true, text: lines.join("\n"), lost, restored: [] }
}

/** Forget the lost sessions: the person said no. */
export function forget(self: string | undefined): Outcome {
  const lost = lostSessions(ctxNow(), self)
  for (const r of lost) removeRec(r.sessionId)
  return {
    ok: true,
    text: lost.length ? `◢ crosstalk: left ${lost.length} session${lost.length === 1 ? "" : "s"} closed.` : "◢ crosstalk: nothing to restore.",
    lost,
    restored: [],
  }
}

const pendingFile = () => path.join(P.root, "restore-pending.json")
type Pending = { ids: string[]; current: Term; until: number; self?: string; tabs?: false }

/**
 * Take the pending restore for this process, atomically, so the background
 * waiter and a person asking again never both run it.
 */
function claimPending(): Pending | null {
  const mine = `${pendingFile()}.${process.pid}`
  try {
    fs.renameSync(pendingFile(), mine)
  } catch {
    return null
  }
  try {
    return JSON.parse(fs.readFileSync(mine, "utf8"))
  } catch {
    return null
  } finally {
    try {
      fs.unlinkSync(mine)
    } catch {}
  }
}

export type RunOpts = {
  self?: string
  env?: NodeJS.ProcessEnv
  /** False opens one window per session, needing no Accessibility. */
  tabs?: boolean
  /** True when a person just asked for this; only then may System Settings be opened. */
  userAction: boolean
  /** Where the plugin lives, for starting the background waiter. */
  root?: string
  /**
   * The waiter finishing a restore a person asked for minutes ago: tabs as
   * they asked, each Cmd-T only after Terminal is checked to be in front.
   */
  asked?: boolean
  /** Only the sessions used close to the last one (recentOf); the others stay to restore later. */
  recentOnly?: boolean
  /** The peer this is done for, if any: an agent (a bot) is refused. */
  peer?: string
}

/** Tabs only when a person just asked: an unattended restore opens a window per session. */
export const tabsFor = (o: Pick<RunOpts, "tabs" | "userAction" | "asked">): boolean => (o.userAction || o.asked ? (o.tabs ?? true) : false)

/** Start a detached Step and leave it: ok unless it could not be started at all. */
export function startDetached(s: Step, env?: NodeJS.ProcessEnv): { ok: boolean; out: string } {
  try {
    const c = spawn(s.cmd, s.args, { detached: true, stdio: "ignore", ...(env ? { env } : {}) })
    c.on("error", () => {})
    c.unref()
    return { ok: !!c.pid, out: c.pid ? "" : `${s.cmd} could not be started` }
  } catch (e) {
    return { ok: false, out: String(e) }
  }
}

function runStep(s: Step): { ok: boolean; out: string } {
  if (s.detach) return startDetached(s)
  const r = spawnSync(s.cmd, s.args, { input: s.input, encoding: "utf8", timeout: 60_000 })
  return { ok: r.status === 0, out: `${r.stdout ?? ""}${r.stderr ?? ""}${r.error ? String(r.error) : ""}`.trim() }
}

/**
 * Reopen every lost session.
 *
 * The records are removed before anything opens, since a resumed session
 * registers again under the same id within a second and must not find itself
 * listed as lost; any that fail to open are written back.
 */
export function restore(o: RunOpts, only?: Rec[]): Outcome {
  const bot = refuseBot(o.peer, "resume a session on this machine")
  if (bot) return { ok: false, text: `◢ crosstalk: ${bot}`, lost: [], restored: [] }
  const env = o.env ?? process.env
  // Those handed in were lost when someone asked; any that came back since
  // (another restore, the person by hand) are running again and left alone.
  const all = only ? only.filter((r) => !recAlive(r)) : lostSessions(ctxNow(), o.self)
  // "Only the recent N": the rest stay listed, for "restore them" later.
  // A session whose folder is gone (a worktree cleaned up) cannot reopen there: kept listed, and said.
  const picked = o.recentOnly ? recentOf(all) : all
  const folderGone = picked.filter((r) => r.cwd && !fs.existsSync(r.cwd))
  const lost = picked.filter((r) => !folderGone.includes(r))
  if (!lost.length) return { ok: true, text: "◢ crosstalk: nothing to restore.", lost, restored: [] }
  claimPending() // anything waiting in the background is superseded by this

  // Unattended, with nobody having asked: one window per session through
  // `do script`, never keystrokes through System Events. The waiter finishing
  // a restore someone asked for at most a few minutes ago (`asked`) uses
  // tabs, and each Cmd-T is sent only after Terminal is checked to be in
  // front, so no keystroke lands in another app. Ghostty, without a person or
  // an ask, is left to the person.
  const e = liveEnv(env, tabsFor(o))
  let { plans, skipped } = plan(lost, e)
  const app = appName(e.current)
  const notes: string[] = []
  if (folderGone.length) notes.push(`Not reopened: ${names(folderGone)}, whose folder${folderGone.length === 1 ? " is" : "s are"} gone. "Resume <name>" opens one in its repository.`)
  const state = loadState()

  // Tabs in Terminal.app and Ghostty are typed through System Events. Check
  // before opening anything, so the restore is not half done when it stops.
  if (plans.some((p) => p.needsAccessibility) && accessibilityGranted() === false) {
    const opened = shouldOpenSettings({ pane: "accessibility", userAction: o.userAction, state, now: Date.now() })
    if (opened) {
      openSettings("accessibility")
      saveState({ ...state, settingsOpened: { ...state.settingsOpened, accessibility: Date.now() } })
    }
    const p: Pending = { ids: lost.map((r) => r.sessionId), current: e.current, until: Date.now() + WAIT_MS(), self: o.self, ...(o.tabs === false ? { tabs: false } : {}) }
    fs.mkdirSync(P.root, { recursive: true, mode: 0o700 })
    fs.writeFileSync(pendingFile(), JSON.stringify(p), { mode: 0o600 })
    startWaiter(o.root)
    const [steps, cmd] = permissionSteps("accessibility", app)
    return {
      ok: true,
      text: [
        `◢ crosstalk needs permission to open tabs in ${app}.`,
        opened ? `  Opened System Settings. Turn on the switch next to ${app} itself (crosstalk runs inside ${app}, so it is not listed on its own); crosstalk will finish restoring by itself.` : `  ${steps}`,
        ...(opened ? [] : [`  ${cmd}`, `  crosstalk will finish restoring by itself once it is on.`]),
      ].join("\n"),
      lost,
      restored: [],
    }
  }

  for (const r of lost) removeRec(r.sessionId)
  const restored: Rec[] = []
  const failed: Rec[] = []
  const manual: Rec[] = []
  let missing: Pane | null = null

  for (const p of plans) {
    if (p.kind === "manual") {
      manual.push(...p.sessions)
      continue
    }
    let ok = true
    let out = ""
    for (const s of p.steps) {
      const r = runStep(s)
      out += r.out + "\n"
      if (!r.ok) {
        ok = false
        break
      }
    }
    // `done <error> <opened>`: a tab that would not open stopped the rest, which stay closed for next time.
    const stopped = /done (-?\d+) (\d+)/.exec(out)
    if (ok && stopped && Number(stopped[2]) < p.sessions.length) {
      const opened = Math.min(p.sessions.length, Number(stopped[2]))
      const left = p.sessions.slice(opened)
      restored.push(...p.sessions.slice(0, opened))
      for (const r of left) writeRec(r)
      if (stopped[1] === "1001") notes.push(`Opened ${opened} of ${p.sessions.length}: ${app} was not in front when the next tab was due, so crosstalk stopped rather than open windows. ${left.length} wait: say "restore them" to open them as tabs.`)
      else {
        missing = classifyOsaError(stopped[1]) ?? "automation"
        notes.push(`Opened ${opened} of ${p.sessions.length}: ${app} ${missing === "accessibility" ? "may not type keys (Accessibility)" : "may not control System Events (Automation)"}, which tabs need. ${left.length} wait, to open as tabs once that is allowed.`)
      }
      continue
    } else if (ok && stopped) missing ??= classifyOsaError(stopped[1])
    else if (ok && p.needsAccessibility) saveState({ ...loadState(), tabsWorked: Date.now() })
    if (ok) restored.push(...p.sessions)
    else {
      missing ??= classifyOsaError(out)
      failed.push(...p.sessions)
      notes.push(`${p.kind} could not open ${names(p.sessions)}: ${out.trim().split("\n").pop()}`)
    }
  }
  // Whatever could not be opened, the person can paste in one go.
  const rest = [...manual, ...failed]
  for (const r of failed) writeRec(r)
  if (rest.length) {
    const lines = rest.map(typed)
    fs.mkdirSync(P.root, { recursive: true, mode: 0o700 })
    fs.writeFileSync(commandsFile(), `#!/bin/sh\n# Sessions crosstalk could not reopen by itself. Each line is one tab.\n${lines.join("\n")}\n`, { mode: 0o700 })
    notes.push(`Paste each line into its own tab (also in ${commandsFile()}):`, ...lines.map((l) => `  ${l}`))
  }
  if (skipped.length) notes.push(`Skipped ${names(skipped)}: ${[...new Set(skipped.map((r) => r.client))].join(", ")} cannot resume a session.`)
  for (const r of skipped) removeRec(r.sessionId)
  if (missing && process.platform === "darwin") {
    const opened = shouldOpenSettings({ pane: missing, userAction: o.userAction, state: loadState(), now: Date.now() })
    if (opened) {
      openSettings(missing)
      const s = loadState()
      saveState({ ...s, settingsOpened: { ...s.settingsOpened, [missing]: Date.now() } })
    }
    const [steps, cmd] = permissionSteps(missing, app)
    notes.push(opened ? `Opened System Settings, so next time they open as tabs: ${steps}` : `For tabs next time: ${steps}`, `  ${cmd}`)
  }
  const head = restored.length
    ? `◢ crosstalk: reopened ${restored.length} session${restored.length === 1 ? "" : "s"} (${names(restored)}).`
    : `◢ crosstalk: reopened nothing.`
  return { ok: !failed.length, text: [head, ...notes.map((n) => `  ${n}`)].join("\n"), lost, restored }
}

// --- waiting for Accessibility ---------------------------------------------------

const WAIT_MS = () => Number(process.env.CROSSTALK_RESTORE_WAIT_MS ?? 2 * 60 * 1000)
const POLL_MS = 2000

function startWaiter(root?: string) {
  if (process.env.CROSSTALK_NO_WAITER) return
  try {
    const child = spawn(shim(root ?? rootFrom(import.meta.url)), ["restore", "--finish"], {
      detached: true,
      stdio: "ignore",
    })
    child.unref()
  } catch {}
}

/**
 * Runs detached after a restore stopped for Accessibility: checks every two
 * seconds, without side effects, and finishes the restore with tabs as soon
 * as the permission is on. If it never comes, nothing opens by surprise
 * minutes later; the sessions stay listed and a notification says so.
 */
export async function finishWhenPermitted(): Promise<string> {
  let p: Pending | null = null
  try {
    p = JSON.parse(fs.readFileSync(pendingFile(), "utf8"))
  } catch {}
  if (!p) return "nothing pending"
  while (Date.now() < p.until) {
    if (accessibilityGranted() === true) break
    await new Promise((r) => setTimeout(r, POLL_MS))
    if (!fs.existsSync(pendingFile())) return "taken over"
  }
  const mine = claimPending()
  if (!mine) return "taken over"
  if (accessibilityGranted() !== true) {
    notify(`No Accessibility permission yet, so nothing was reopened. Say "restore them" in any session to try again.`)
    return "timed out"
  }
  const recs = mine.ids.map(readOne).filter((r): r is Rec => !!r)
  const env = { ...process.env, ...termEnv(mine.current) }
  const out = restore({ self: mine.self, env, userAction: false, asked: true, ...(mine.tabs === false ? { tabs: false } : {}) }, recs)
  notify(out.restored.length ? `Reopened ${out.restored.length} session${out.restored.length === 1 ? "" : "s"}.` : out.text)
  return out.text
}

/** Enough of an environment for captureTerminal to see the terminal it was asked from. */
function termEnv(t: Term): NodeJS.ProcessEnv {
  const e: NodeJS.ProcessEnv = {}
  if (t.program) e.TERM_PROGRAM = t.program
  if (t.apple?.sessionId) e.TERM_SESSION_ID = t.apple.sessionId
  return e
}

// --- the hook's part -------------------------------------------------------------

/** `@restore`, `@restore no`, `@restore windows`: a shortcut nobody has to know. */
export function parseShortcut(prompt: string): "yes" | "no" | "windows" | null {
  const m = /^@restore(?:\s+(\S+))?$/i.exec(prompt.trim())
  if (!m) return null
  const w = (m[1] ?? "").toLowerCase()
  if (!w || w === "yes" || w === "y") return "yes"
  if (w === "no" || w === "n") return "no"
  if (w === "windows") return "windows"
  return null
}

/**
 * Keep this session's record current. Called by the hook on every event that
 * is cheap enough: a session start captures everything, the end of a turn
 * refreshes the tab position, a prompt only says the session is alive.
 */
export function note(o: {
  event: string
  sessionId: string
  cwd: string
  client: string
  name?: string
  env: NodeJS.ProcessEnv
  source?: string
  reason?: string
}) {
  const now = Date.now()
  const read = readOne(o.sessionId)
  // A record the watch wrote is replaced whole by the session's own hooks.
  const before = read?.adopted ? null : read
  if (/^SessionEnd$/i.test(o.event)) {
    if (before) writeRec({ ...before, endedAt: now, endReason: o.reason ?? "other", seenAt: now })
    return
  }
  const start = /^SessionStart$/i.test(o.event)
  const turnEnd = /^Stop$/i.test(o.event)
  if (!start && before && !turnEnd) {
    // A prompt or tool call: only that it is still here, at most once a minute.
    if (now - before.seenAt > 60_000) writeRec({ ...before, seenAt: now, cwd: o.cwd || before.cwd })
    return
  }
  const pid = start || !before ? sessionPid(o.sessionId) : before.pid
  const args = start || !before ? ps(pid, "args") ?? "" : ""
  const rec: Rec = {
    sessionId: o.sessionId,
    cwd: o.cwd,
    client: o.client,
    name: o.name ?? before?.name,
    pid,
    pidStart: start || !before ? ps(pid, "lstart") ?? undefined : before.pidStart,
    interactive: start || !before ? !/(^|\s)(-p|--print)(\s|$)/.test(args) : before.interactive,
    // A resumed session keeps its id, and is the same piece of work.
    startedAt: read?.startedAt ?? now,
    seenAt: now,
    terminal: captureTerminal(o.env, pid, true),
    ...(before?.thread ? { thread: before.thread } : {}),
  }
  writeRec(rec)
  if (start) prune(now)
}
