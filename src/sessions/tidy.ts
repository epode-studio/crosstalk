// Tidy up: "clean up my sessions", "close what I'm not using".
//
// One question for the lot instead of one per session. What is offered:
//
//   sessions   open, not this one, not the main session, idle in Claude Code's
//              own registry, untouched for a while (IDLE_MIN, default 20
//              minutes), with nothing of crosstalk's waiting on the person.
//              The person can name others ("close everything but auth"):
//              the agent passes `sessions`, and each still goes through the
//              same checks as a single close.
//   tabs       the shell left behind when a session ends ("…e Code — -zsh"):
//              in Terminal.app the tab whose tty a crosstalk session ended on
//              in the last day, which runs nothing now and shows Claude Code's
//              banner, closed with Cmd-W (appleCloseIdleTabScript); in tmux
//              the pane, when what runs in it is a bare shell; in kitty
//              (with remote control) and WezTerm the window or pane, when
//              only a shell is in the foreground of its tty. A tab running
//              anything is never closed. Other terminals (GNOME Terminal,
//              Konsole, Windows Terminal, …) keep their tabs, and the person
//              is told.
//   windows    with `merge`, Terminal.app's Window > Merge All Windows, so
//              every window becomes a tab of one (System Events, which
//              restore already needs).
//
// Closing is close() in control.ts: SIGTERM then SIGINT to the very process,
// archived so it can be resumed, services left running unless asked.

import * as R from "../restore.ts"
import type { Rec, Step, Term } from "../restore.ts"
import { readRegistry } from "../gather.ts"
import * as ui from "../uistate.ts"

export const IDLE_MIN = () => Math.max(1, Number(process.env.CROSSTALK_TIDY_IDLE_MIN ?? 20))

const SHELLS = new Set(["zsh", "-zsh", "bash", "-bash", "fish", "-fish", "sh", "-sh", "login", "nu", "pwsh", "dash", "-dash", "ksh", "-ksh"])

export type Offer = { id: string; name: string; idleMin: number; why: string }

/**
 * Which open sessions to offer closing. Pure: what it is handed decides.
 * `lives` are open sessions; `status` is Claude Code's word for each;
 * `waiting` how many of crosstalk's cards and questions wait for it.
 */
export function suggest(o: {
  lives: { id: string; name: string }[]
  recs: Pick<Rec, "sessionId" | "seenAt">[]
  status: (id: string) => string | undefined
  waiting: (id: string) => number
  self?: string
  main?: string
  now: number
  idleMin?: number
}): Offer[] {
  const min = o.idleMin ?? IDLE_MIN()
  const seen = new Map(o.recs.map((r) => [r.sessionId, r.seenAt]))
  const out: Offer[] = []
  for (const l of o.lives) {
    if (l.id === o.self || l.id === o.main) continue
    const st = o.status(l.id)
    if (st && st !== "idle") continue // busy, or waiting on a permission prompt: someone is using it
    if (o.waiting(l.id) > 0) continue // something of crosstalk's is waiting for the person there
    const at = seen.get(l.id)
    if (!at) continue
    const idleMin = Math.floor((o.now - at) / 60_000)
    if (idleMin < min) continue
    out.push({ id: l.id, name: l.name, idleMin, why: `idle ${ago(idleMin)}` })
  }
  return out.sort((a, b) => b.idleMin - a.idleMin)
}

export const ago = (min: number) => (min < 60 ? `${min} min` : min < 48 * 60 ? `${Math.round(min / 60)} h` : `${Math.round(min / 1440)} days`)

/** How many of crosstalk's cards and questions wait on a session. */
export function waitingFor(sessionId: string): number {
  try {
    return Object.values(ui.snapshot()).filter((i: any) => i.sessionId === sessionId && !["answered", "handed", "muted", "later"].includes(i.state)).length
  } catch {
    return 0
  }
}

export const statusOf = () => {
  const reg = new Map<string, string>()
  try {
    for (const e of readRegistry()) reg.set(e.sessionId, e.status)
  } catch {}
  return (id: string) => reg.get(id)
}

// --- tabs -----------------------------------------------------------------------------

/**
 * Terminal.app: close the tab on this tty, the way a person would: select it,
 * bring its window and Terminal to the front, and press Cmd-W.
 *
 * Typing `exit` to the shell is not enough: whether Terminal then closes the
 * tab is a profile setting ("When the shell exits"), and many keep it open.
 *
 * Only a tab that ran Claude: "claude" in its scrollback, the command line or
 * the banner (a tty can be reused by a new tab later; full-screen Claude Code
 * leaves no banner behind, so the command line is what is left). It waits up to three
 * seconds for what the session started (caffeinate, MCP servers) to go, and
 * leaves a tab still running anything, so Terminal never asks about closing
 * running processes. Cmd-W is sent only once Terminal is in front with that
 * very tab selected. Returns "closed", "busy", "not-claude", "not-front" or ""
 * when there is no such tab. Never launches Terminal.
 */
export function appleCloseIdleTabScript(tty: string, mark = "claude"): string {
  const q = R.asq(tty)
  return [
    `if application "Terminal" is not running then return ""`,
    `set found to false`,
    `tell application "Terminal"`,
    `\trepeat with w in windows`,
    `\t\trepeat with t in tabs of w`,
    `\t\t\tif (tty of t) is ${q} then`,
    `\t\t\t\trepeat 15 times`,
    `\t\t\t\t\tif not (busy of t) then exit repeat`,
    `\t\t\t\t\tdelay 0.2`,
    `\t\t\t\tend repeat`,
    `\t\t\t\tif busy of t then return "busy"`,
    // Case does not count in AppleScript: "claude --resume …" or Claude Code's banner.
    `\t\t\t\tif (history of t) does not contain ${R.asq(mark)} then return "not-claude"`,
    `\t\t\t\tset selected of t to true`,
    `\t\t\t\tset index of w to 1`,
    `\t\t\t\tset found to true`,
    `\t\t\t\texit repeat`,
    `\t\t\tend if`,
    `\t\tend repeat`,
    `\t\tif found then exit repeat`,
    `\tend repeat`,
    `\tif not found then return ""`,
    `\tactivate`,
    `end tell`,
    `repeat 10 times`,
    `\tif frontmost of application "Terminal" then exit repeat`,
    `\ttry`,
    `\t\ttell application "System Events" to set frontmost of process "Terminal" to true`,
    `\tend try`,
    `\tdelay 0.2`,
    `end repeat`,
    `tell application "Terminal"`,
    `\tif not frontmost then return "not-front"`,
    `\tif (tty of selected tab of front window) is not ${q} then return "not-front"`,
    `\tif busy of selected tab of front window then return "busy"`,
    `end tell`,
    // Key code 13 is the W key wherever it sits: keystroke "w" types whatever key makes a "w" on AZERTY or Dvorak.
    `tell application "System Events" to key code 13 using command down`,
    `delay 0.3`,
    `return "closed"`,
  ].join("\n")
}

/** Terminal.app: how many windows are open, without launching it. */
export const appleWindowCountScript = [`if application "Terminal" is running then`, `\ttell application "Terminal" to return (count of windows) as text`, `end if`, `return "0"`].join("\n")

/** Terminal.app's own Window > Merge All Windows. */
export const appleMergeScript = [
  `tell application "Terminal" to activate`,
  `delay 0.3`,
  `tell application "System Events" to tell process "Terminal"`,
  `\tclick menu item "Merge All Windows" of menu "Window" of menu bar 1`,
  `end tell`,
  `return "merged"`,
].join("\n")

const tmuxBase = (t: NonNullable<Term["tmux"]>) => (t.socket ? ["-S", t.socket] : [])

/** What runs on a tty, with its state: `+` marks the foreground process group. */
export const ttyProbe = (tty: string): Step => ({ cmd: "ps", args: ["-o", "stat=,comm=", "-t", tty.replace(/^\/dev\//, "")] })

/** From ttyProbe's answer: the foreground of the tty is a shell and nothing else. */
export function onlyShell(out: string): boolean {
  const fg = out
    .split("\n")
    .map((l) => l.trim().split(/\s+/))
    .filter(([stat, comm]) => stat?.includes("+") && comm)
  return fg.length > 0 && fg.every(([, ...comm]) => SHELLS.has(comm.join(" ").split("/").pop()!))
}

/** The steps that close a tab left with only its shell, per terminal. Empty: this terminal keeps its tab. */
/**
 * `mark`: text the tab must show to be closed. A session that just ended is
 * known to be in its own tab ("claude"); a tab left by one that ended earlier
 * could be someone's own tab on a reused tty, so it must show that very
 * session's id (Claude Code prints it on exit, restore types it).
 */
export function closeTabSteps(t: Term, platform: NodeJS.Platform = process.platform, mark = "claude"): { probe?: Step; mark?: Step; close: Step; closesIf: (probeOut: string) => boolean }[] {
  if (t.tmux?.pane) {
    const base = tmuxBase(t.tmux)
    return [
      {
        probe: { cmd: "tmux", args: [...base, "display-message", "-p", "-t", t.tmux.pane, "#{pane_current_command}"] },
        ...(mark !== "claude" ? { mark: { cmd: "tmux", args: [...base, "capture-pane", "-p", "-t", t.tmux.pane, "-S", "-400"] } } : {}),
        close: { cmd: "tmux", args: [...base, "kill-pane", "-t", t.tmux.pane] },
        closesIf: (out) => SHELLS.has(out.trim()),
      },
    ]
  }
  const k = R.kindOf(t)
  if (k === "apple" && t.tty && platform === "darwin")
    return [{ close: { cmd: "osascript", args: ["-"], input: appleCloseIdleTabScript(t.tty, mark) }, closesIf: () => true }]
  // kitty and WezTerm close by their own CLI, after `ps` says only a shell is
  // left in front on the tty. kitty closes the window, not the whole tab, so
  // a split beside it is never taken along; a tab with one window goes with it.
  if (k === "kitty" && t.kitty?.window && t.kitty.listenOn && t.tty && platform !== "win32") {
    const to = ["@", "--to", t.kitty.listenOn]
    const id = `id:${t.kitty.window}`
    return [
      {
        probe: ttyProbe(t.tty),
        ...(mark !== "claude" ? { mark: { cmd: "kitten", args: [...to, "get-text", "--match", id, "--extent", "all"] } } : {}),
        close: { cmd: "kitten", args: [...to, "close-window", "--match", id] },
        closesIf: onlyShell,
      },
    ]
  }
  if (k === "wezterm" && t.wezterm?.pane && t.tty && platform !== "win32")
    return [
      {
        probe: ttyProbe(t.tty),
        ...(mark !== "claude" ? { mark: { cmd: "wezterm", args: ["cli", "get-text", "--pane-id", t.wezterm.pane, "--start-line", "-400"] } } : {}),
        close: { cmd: "wezterm", args: ["cli", "kill-pane", "--pane-id", t.wezterm.pane] },
        closesIf: onlyShell,
      },
    ]
  return []
}

/** Whether crosstalk can close this tab at all, here. */
export const closable = (t: Term, platform: NodeJS.Platform = process.platform) => closeTabSteps(t, platform).length > 0

/** Close a tab left with only its shell. True when it was closed. */
export function closeTab(t: Term, run: (s: Step) => { ok: boolean; out: string }, platform: NodeJS.Platform = process.platform): boolean {
  return closeTabWhy(t, run, platform) === "closed"
}

/** Why a tab stayed: "closed", or busy, not-claude, not-front, gone, no-shell, unsupported, or the error. */
export const WHY_OPEN: Record<string, string> = {
  busy: "something still runs in it",
  "not-claude": "it never ran Claude, so it may be someone's own tab",
  "not-front": "Terminal could not be brought to the front",
  gone: "it was already closed",
  "no-shell": "something other than a shell runs in it",
  unsupported: "this terminal cannot close a tab for crosstalk, so close it by hand",
}

export function closeTabWhy(t: Term, run: (s: Step) => { ok: boolean; out: string }, platform: NodeJS.Platform = process.platform, mark = "claude"): string {
  const steps = closeTabSteps(t, platform, mark)
  if (!steps.length) return "unsupported"
  for (const s of steps) {
    if (s.probe) {
      const p = run(s.probe)
      if (!p.ok) return "gone"
      if (!s.closesIf(p.out)) return "no-shell"
      if (s.mark) {
        const m = run(s.mark)
        if (!m.ok || !m.out.includes(mark)) return "not-claude"
      }
      return run(s.close).ok ? "closed" : "gone"
    }
    const r = run(s.close)
    if (!r.ok) return /1002|1719|assistive|not allowed/i.test(r.out) ? "accessibility" : r.out.split("\n").pop()?.slice(0, 120) || "error"
    const out = r.out.trim()
    return out === "" ? "gone" : out
  }
  return "unsupported"
}

/**
 * Tabs a crosstalk session ended in, in the last day, that may be left with
 * only their shell: the ended records, newest first, one per tab.
 */
export function leftoverTabs(recs: Rec[], liveTtys: Set<string>, platform: NodeJS.Platform = process.platform): Rec[] {
  const seen = new Set<string>()
  const out: Rec[] = []
  for (const r of [...recs].filter((r) => r.endedAt).sort((a, b) => (b.endedAt ?? 0) - (a.endedAt ?? 0))) {
    const key = r.terminal.tmux?.pane ? `tmux:${r.terminal.tmux.socket ?? ""}:${r.terminal.tmux.pane}` : r.terminal.tty
    if (!key || seen.has(key) || (r.terminal.tty && liveTtys.has(r.terminal.tty))) continue
    if (!r.terminal.tmux?.pane && R.kindOf(r.terminal) !== "apple" && !closable(r.terminal, platform)) continue
    seen.add(key)
    out.push(r)
  }
  return out
}

// --- similar sessions --------------------------------------------------------------

export type Fold = { id: string; name: string; into: string; intoName: string; why: string }

/**
 * Sessions doing the same work: in the same thread, or else in the same folder
 * (the same checkout and branch). Each group keeps one: this session when it
 * is in the group, else one someone is using, else the one used last. The
 * rest are offered folding into it, but only those idle with nothing waiting:
 * a busy session is never closed.
 */
export function similar(o: {
  lives: { id: string; name: string; cwd: string; threads: string[] }[]
  recs: Pick<Rec, "sessionId" | "seenAt">[]
  status: (id: string) => string | undefined
  waiting: (id: string) => number
  self?: string
  main?: string
  now?: number
  idleMin?: number
}): Fold[] {
  const seen = new Map(o.recs.map((r) => [r.sessionId, r.seenAt]))
  const groups = new Map<string, typeof o.lives>()
  for (const l of o.lives) {
    // Main does no thread's work (it left its threads): nothing is folded into it, and it is never folded.
    if (l.id === o.main || (l.id === o.self && !l.threads.length)) continue
    // The same work is the same thread in the same folder: parallel agents in
    // their own worktrees are separate lines of work, never folded together.
    const key = l.threads.length ? `thread:${l.threads[0]}|${l.cwd}` : `cwd:${l.cwd}`
    groups.set(key, [...(groups.get(key) ?? []), l])
  }
  const out: Fold[] = []
  for (const [key, g] of groups) {
    if (g.length < 2) continue
    const used = (l: (typeof g)[number]) => o.status(l.id) && o.status(l.id) !== "idle"
    const keep =
      g.find((l) => l.id === o.self) ??
      g.find((l) => l.id === o.main) ??
      g.find(used) ??
      [...g].sort((a, b) => (seen.get(b.id) ?? 0) - (seen.get(a.id) ?? 0))[0]
    const why = key.startsWith("thread:") ? `same thread, ${key.slice(7).split("|")[0]}` : "same folder"
    for (const l of g) {
      // Only one left alone a while: a session that finished a turn seconds ago is not done.
      const idleMin = Math.floor(((o.now ?? Date.now()) - (seen.get(l.id) ?? 0)) / 60_000)
      if (l.id === keep.id || l.id === o.self || l.id === o.main || used(l) || o.waiting(l.id) > 0 || idleMin < (o.idleMin ?? IDLE_MIN())) continue
      out.push({ id: l.id, name: l.name, into: keep.id, intoName: keep.name, why })
    }
  }
  return out
}

/** What the session kept is handed about one folded into it. */
export function foldNote(f: Pick<Fold, "name" | "why">, s: { recap?: string; title?: string; files?: string[] } | null): string {
  const where = (s?.recap || s?.title || "").replace(/\s+/g, " ").trim()
  const files = (s?.files ?? []).slice(-8)
  return [
    `${f.name} was folded into this session when tidying up (${f.why}).`,
    where ? `Where it had got to: ${where.length > 1200 ? where.slice(0, 1199) + "…" : where}` : "",
    files.length ? `Files it worked on: ${files.join(", ")}` : "",
    `Its conversation is archived; "resume ${f.name}" brings it back.`,
  ]
    .filter(Boolean)
    .join("\n")
}
