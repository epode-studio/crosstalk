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
//              the pane, when what runs in it is a bare shell. A tab running
//              anything is never closed. Other terminals keep their tabs.
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

const SHELLS = new Set(["zsh", "-zsh", "bash", "-bash", "fish", "-fish", "sh", "-sh", "login", "nu", "pwsh"])

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
    return Object.values(ui.snapshot()).filter((i: any) => i.sessionId === sessionId && !["answered", "handed", "muted"].includes(i.state)).length
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
 * Only a tab that is a Claude session's: it shows Claude Code's banner in its
 * scrollback (a tty can be reused by a new tab later). It waits up to three
 * seconds for what the session started (caffeinate, MCP servers) to go, and
 * leaves a tab still running anything, so Terminal never asks about closing
 * running processes. Cmd-W is sent only once Terminal is in front with that
 * very tab selected. Returns "closed", "busy", "not-claude", "not-front" or ""
 * when there is no such tab. Never launches Terminal.
 */
export function appleCloseIdleTabScript(tty: string): string {
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
    `\t\t\t\tif (history of t) does not contain "Claude Code" then return "not-claude"`,
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
    `tell application "System Events" to keystroke "w" using command down`,
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

/** The steps that close a tab left with only its shell, per terminal. Empty: this terminal keeps its tab. */
export function closeTabSteps(t: Term, platform: NodeJS.Platform = process.platform): { probe?: Step; close: Step; closesIf: (probeOut: string) => boolean }[] {
  if (t.tmux?.pane) {
    const base = tmuxBase(t.tmux)
    return [
      {
        probe: { cmd: "tmux", args: [...base, "display-message", "-p", "-t", t.tmux.pane, "#{pane_current_command}"] },
        close: { cmd: "tmux", args: [...base, "kill-pane", "-t", t.tmux.pane] },
        closesIf: (out) => SHELLS.has(out.trim()),
      },
    ]
  }
  if (R.kindOf(t) === "apple" && t.tty && platform === "darwin")
    return [{ close: { cmd: "osascript", args: ["-"], input: appleCloseIdleTabScript(t.tty) }, closesIf: () => true }]
  return []
}

/** Close a tab left with only its shell. True when it was closed. */
export function closeTab(t: Term, run: (s: Step) => { ok: boolean; out: string }, platform: NodeJS.Platform = process.platform): boolean {
  let closed = false
  for (const s of closeTabSteps(t, platform)) {
    if (s.probe) {
      const p = run(s.probe)
      if (!p.ok || !s.closesIf(p.out)) continue
    }
    const r = run(s.close)
    if (r.ok && (s.probe || /closed/.test(r.out))) closed = true
  }
  return closed
}

/**
 * Tabs a crosstalk session ended in, in the last day, that may be left with
 * only their shell: the ended records, newest first, one per tab.
 */
export function leftoverTabs(recs: Rec[], liveTtys: Set<string>): Rec[] {
  const seen = new Set<string>()
  const out: Rec[] = []
  for (const r of [...recs].filter((r) => r.endedAt).sort((a, b) => (b.endedAt ?? 0) - (a.endedAt ?? 0))) {
    const key = r.terminal.tmux?.pane ? `tmux:${r.terminal.tmux.socket ?? ""}:${r.terminal.tmux.pane}` : r.terminal.tty
    if (!key || seen.has(key) || (r.terminal.tty && liveTtys.has(r.terminal.tty))) continue
    if (!r.terminal.tmux?.pane && R.kindOf(r.terminal) !== "apple") continue
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
}): Fold[] {
  const seen = new Map(o.recs.map((r) => [r.sessionId, r.seenAt]))
  const groups = new Map<string, typeof o.lives>()
  for (const l of o.lives) {
    const key = l.threads.length ? `thread:${l.threads[0]}` : `cwd:${l.cwd}`
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
    const why = key.startsWith("thread:") ? `same thread, ${key.slice(7)}` : "same folder"
    for (const l of g) {
      if (l.id === keep.id || l.id === o.self || l.id === o.main || used(l) || o.waiting(l.id) > 0) continue
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
