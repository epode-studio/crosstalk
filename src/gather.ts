// Gathering the sessions that were running before crosstalk was installed.
//
// Claude Code lists every running session in ~/.claude/sessions/<pid>.json,
// whether or not crosstalk is loaded in it. A session whose hooks never wrote a
// restore record (src/restore.ts) started before crosstalk did, so it has no
// crosstalk: no messages, no restore after a crash.
//
//   watch    every crosstalk hook, and the mod's watch, snapshot those sessions
//            (throttled) into restore records marked `adopted: "watched"`, so a
//            crash brings them back too.
//   offer    once: "4 Claude sessions started before crosstalk. Bring them in?"
//            as the mod's picker, or a systemMessage without it, answered in
//            plain words through crosstalk_work action "gather".
//   restart  after yes, each one in turn, only while the registry says it is
//            idle and nothing it started still runs (a dev server, a
//            watcher: src/services/postpone.ts): SIGTERM to its own verified pid, wait for it to exit, then
//            `claude --resume <id>` typed into the same tab, whose shell prompt
//            is back. Busy ones wait for idle, for up to two hours, in a
//            detached `crosstalk gather --finish`.
//
// The session that asks is never restarted, and nothing but a verified claude
// process is ever signalled, and never with SIGKILL.

import fs from "node:fs"
import path from "node:path"
import { spawn, spawnSync } from "node:child_process"
import { P } from "./config.ts"
import { rootFrom, shim } from "./paths.ts"
import * as R from "./restore.ts"
import type { Rec, Step, Term } from "./restore.ts"
import { refuseBot } from "./ui-extra/bots.ts"
import { sessionsDir } from "./registry.ts"
import { liveActivity } from "./services/postpone.ts"
import type { Activity } from "./services/procs.ts"

// --- the registry --------------------------------------------------------------

export type RegEntry = {
  pid: number
  sessionId: string
  cwd: string
  /** idle, busy, waiting … as Claude Code writes it. */
  status: string
  name?: string
  startedAt?: number
  kind?: string
}

/** Claude Code's own session registry. Tests point HOME elsewhere. */
export const registryDir = () => sessionsDir()

/** Every registry entry whose pid exists, socket or not. */
export function readRegistry(dir = registryDir(), alive: (pid: number) => boolean = (p) => R.pidAlive(p)): RegEntry[] {
  let files: string[]
  try {
    files = fs.readdirSync(dir).filter((f) => /^\d+\.json$/.test(f))
  } catch {
    return []
  }
  const out: RegEntry[] = []
  for (const f of files) {
    try {
      const e = JSON.parse(fs.readFileSync(path.join(dir, f), "utf8"))
      const pid = Number(e.pid ?? f.slice(0, -5))
      if (!pid || typeof e.sessionId !== "string" || !e.sessionId) continue
      if (!alive(pid)) continue
      out.push({
        pid,
        sessionId: e.sessionId,
        cwd: e.cwd ?? "",
        status: e.status ?? "unknown",
        name: e.name,
        startedAt: typeof e.startedAt === "number" ? e.startedAt : undefined,
        kind: e.kind,
      })
    } catch {}
  }
  return out
}

/** `ps -o etime` ([[dd-]hh:]mm:ss) in milliseconds, or null. The same on every locale, unlike lstart. */
export function etimeMs(etime: string | null | undefined): number | null {
  const m = /^\s*(?:(\d+)-)?(?:(\d+):)?(\d+):(\d+)\s*$/.exec(etime ?? "")
  if (!m) return null
  const [d, h, mi, se] = [m[1], m[2], m[3], m[4]].map((x) => Number(x ?? 0))
  return (((d * 24 + h) * 60 + mi) * 60 + se) * 1000
}

/** How far a process's start may be from the registry's startedAt and still be the same session. */
export const START_SLACK_MS = 10_000

/**
 * Whether the process now at `pid` is the one that wrote this registry entry:
 * it started within a few seconds of the entry's startedAt. A stale file
 * whose pid was reused by another process fails, and so does an entry with
 * no startedAt, since then nothing says which process it was.
 */
export function startMatches(e: Pick<RegEntry, "pid" | "startedAt">, sys: Pick<Sys, "ps" | "now">): boolean {
  if (typeof e.startedAt !== "number") return false
  const up = etimeMs(sys.ps(e.pid, "etime"))
  if (up === null) return false
  return Math.abs(sys.now() - up - e.startedAt) < START_SLACK_MS
}

/**
 * Whether a process's command line is Claude Code: its program is `claude`,
 * or an interpreter (node, bun …) running a script named `claude` or Claude
 * Code's cli.js. Not just any command that mentions claude ("vim claude.md").
 */
export function isClaudeArgs(args: string | null | undefined): boolean {
  const parts = (args ?? "").trim().split(/\s+/).filter(Boolean)
  if (!parts.length) return false
  const base = (x: string) => path.basename(x)
  if (base(parts[0]) === "claude") return true
  if (!/^(node|bun|deno|sh|bash|zsh)$/.test(base(parts[0]))) return false
  const script = parts.slice(1).find((a) => !a.startsWith("-"))
  return !!script && (base(script) === "claude" || /(^|\/)@anthropic-ai\/claude-code\/cli\.m?js$/.test(script))
}

/** Pids that still have a registry file, alive or not. */
function registryPids(dir = registryDir()): Set<number> {
  try {
    return new Set(
      fs
        .readdirSync(dir)
        .filter((f) => /^\d+\.json$/.test(f))
        .map((f) => Number(f.slice(0, -5))),
    )
  } catch {
    return new Set()
  }
}

// --- what the system is asked ----------------------------------------------------

export type Pane = { tty: string; pane: string; session: string; window: number; paneIndex: number; socket: string }

/** Everything gather asks the machine, so the logic can be tested without one. */
export type Sys = {
  platform: NodeJS.Platform
  now: () => number
  ps: (pid: number, field: string) => string | null
  alive: (pid: number, start?: string) => boolean
  /** Before a signal: "same" only when known to be the recorded process (restore.pidState); default from alive. */
  state?: (pid: number, start?: string) => "same" | "gone" | "unknown"
  /** Another process's environment, when the OS lets us read it. */
  env: (pid: number) => NodeJS.ProcessEnv | null
  tmuxPanes: () => Pane[]
  /** Terminal.app's window id and tab for a tty, only if Terminal is already running. */
  appleLocate: (tty: string) => { window: number; tab: number } | null
  kill: (pid: number, sig: NodeJS.Signals) => void
  run: (s: Step) => { ok: boolean; out: string }
  sleep: (ms: number) => Promise<void>
  /**
   * What the session started that is still running (a dev server, a
   * watcher), crosstalk's own services left out: while there is any, the
   * session is not ended (src/services/postpone.ts). Absent, nothing is.
   */
  activity?: (pid: number) => Activity[]
}

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

const ENV_KEYS = ["TERM_PROGRAM", "TERM_SESSION_ID", "TMUX", "TMUX_PANE", "KITTY_WINDOW_ID", "KITTY_LISTEN_ON", "WEZTERM_PANE", "ITERM_SESSION_ID", "WT_SESSION"]

/** The few variables that say where a process is showing. */
export function parseEnv(text: string, sep: RegExp): NodeJS.ProcessEnv {
  const out: NodeJS.ProcessEnv = {}
  for (const part of text.split(sep)) {
    const i = part.indexOf("=")
    if (i < 1) continue
    const k = part.slice(0, i)
    if (ENV_KEYS.includes(k)) out[k] = part.slice(i + 1)
  }
  return out
}

function procEnv(pid: number): NodeJS.ProcessEnv | null {
  try {
    return parseEnv(fs.readFileSync(`/proc/${pid}/environ`, "utf8"), /\0/)
  } catch {}
  if (process.platform !== "darwin") return null
  // macOS prints a process's environment after its command, for one's own processes.
  try {
    const r = spawnSync("ps", ["-wwE", "-o", "command=", "-p", String(pid)], { encoding: "utf8", timeout: 2000 })
    if (r.status !== 0) return null
    return parseEnv(r.stdout.trim(), /\s+/)
  } catch {
    return null
  }
}

function tmuxPanes(): Pane[] {
  const r = spawnSync(
    "tmux",
    ["list-panes", "-a", "-F", "#{pane_tty}\t#{pane_id}\t#{session_name}\t#{window_index}\t#{pane_index}\t#{socket_path}"],
    { encoding: "utf8", timeout: 2000 },
  )
  if (r.status !== 0) return []
  return r.stdout
    .trim()
    .split("\n")
    .filter(Boolean)
    .map((l) => {
      const [tty, pane, session, w, p, socket] = l.split("\t")
      return { tty, pane, session, window: Number(w), paneIndex: Number(p), socket }
    })
}

/** Like restore's locate script, but never launches Terminal just to ask it. */
export const appleLocateIfRunning = (tty: string) =>
  [`if application "Terminal" is running then`, ...R.appleLocateScript(tty).split("\n").slice(0, -1).map((l) => `\t${l}`), `end if`, `return ""`].join("\n")

export function liveSys(): Sys {
  return {
    platform: process.platform,
    now: Date.now,
    ps,
    alive: R.pidAlive,
    state: R.pidState,
    env: procEnv,
    tmuxPanes,
    appleLocate: (tty) => {
      if (process.platform !== "darwin") return null
      const r = spawnSync("osascript", ["-"], { input: appleLocateIfRunning(tty), encoding: "utf8", timeout: 2500 })
      const [w, n] = (r.stdout ?? "").trim().split(" ").map(Number)
      return r.status === 0 && w && n ? { window: w, tab: n } : null
    },
    kill: (pid, sig) => process.kill(pid, sig),
    run: (s) => {
      const r = spawnSync(s.cmd, s.args, { input: s.input, encoding: "utf8", timeout: 30_000 })
      return { ok: r.status === 0, out: `${r.stdout ?? ""}${r.stderr ?? ""}${r.error ? String(r.error) : ""}`.trim() }
    },
    sleep: (ms) => new Promise((r) => setTimeout(r, ms)),
    activity: (pid) => liveActivity(pid),
  }
}

// --- watching --------------------------------------------------------------------

/** Where a process is showing, from its environment and its tty. */
export function terminalOf(tty: string | undefined, env: NodeJS.ProcessEnv, sys: Sys, panes?: () => Pane[]): Term {
  const t: Term = {}
  if (env.TERM_PROGRAM) t.program = env.TERM_PROGRAM
  if (tty) t.tty = tty
  const pane = tty ? (panes ?? sys.tmuxPanes)().find((p) => p.tty === tty) : undefined
  if (pane) t.tmux = { pane: pane.pane, socket: pane.socket, session: pane.session, window: pane.window, paneIndex: pane.paneIndex }
  else if (env.TMUX && env.TMUX_PANE) t.tmux = { pane: env.TMUX_PANE, socket: env.TMUX.split(",")[0] }
  if (env.KITTY_WINDOW_ID || env.KITTY_LISTEN_ON) t.kitty = { window: env.KITTY_WINDOW_ID, listenOn: env.KITTY_LISTEN_ON }
  if (env.WEZTERM_PANE) t.wezterm = { pane: env.WEZTERM_PANE }
  if (env.ITERM_SESSION_ID) {
    const m = /^w(\d+)t(\d+)p(\d+)/.exec(env.ITERM_SESSION_ID)
    t.iterm = { id: env.ITERM_SESSION_ID, ...(m ? { window: Number(m[1]), tab: Number(m[2]) } : {}) }
  }
  if (env.WT_SESSION) t.wt = { session: env.WT_SESSION }
  // Terminal.app: by the tty, which needs nothing from the environment. Asked
  // only when nothing else claims the tab, and never when tmux sits in between.
  const appleMaybe = env.TERM_PROGRAM === "Apple_Terminal" || (!env.TERM_PROGRAM && !t.iterm && !t.kitty && !t.wezterm)
  if (tty && !t.tmux && appleMaybe && sys.platform === "darwin") {
    const at = sys.appleLocate(tty)
    if (at) {
      t.program = "Apple_Terminal"
      t.apple = { sessionId: env.TERM_SESSION_ID, window: at.window, tab: at.tab }
    } else if (env.TERM_PROGRAM === "Apple_Terminal") t.apple = { sessionId: env.TERM_SESSION_ID }
  }
  return t
}

/** How long a watched session's tab is trusted before it is looked up again. */
export const RECHECK_MS = 10 * 60 * 1000

/**
 * What the watch writes, given the registry and the records: one record per
 * live session that has none of its own, refreshed when stale, and a watched
 * session that went away normally marked so.
 *
 * A session whose hooks wrote its record has crosstalk, and is left alone.
 */
export function snapshot(o: {
  self?: string
  registry: RegEntry[]
  records: Rec[]
  /** Pids that still have a registry file: Claude Code removes its own on a normal exit. */
  registryPids: Set<number>
  boot: number
  sys: Sys
}): Rec[] {
  const { sys } = o
  const now = sys.now()
  const byId = new Map(o.records.map((r) => [r.sessionId, r]))
  const out: Rec[] = []
  let panes: Pane[] | undefined
  const lazyPanes = () => (panes ??= sys.tmuxPanes())
  const live = new Set<string>()
  for (const e of o.registry) {
    live.add(e.sessionId)
    if (e.sessionId === o.self) continue
    const before = byId.get(e.sessionId)
    if (before && !before.adopted) continue // its hooks wrote it: it has crosstalk
    if (before?.endedAt && before.pid === e.pid) continue // being restarted, or ended
    const pidStart = sys.ps(e.pid, "lstart") ?? undefined
    if (!sys.alive(e.pid, pidStart)) continue
    // A registry file left behind, its pid since taken by something else: not a session.
    if (!startMatches(e, sys) || !isClaudeArgs(sys.ps(e.pid, "args"))) continue
    const rawTty = sys.ps(e.pid, "tty")
    const tty = rawTty && !/^\?+$/.test(rawTty) ? (rawTty.startsWith("/dev/") ? rawTty : `/dev/${rawTty}`) : undefined
    const same = before && before.pid === e.pid && before.pidStart === pidStart && before.terminal.tty === tty
    const fresh = same && now - (before!.watchedAt ?? 0) < RECHECK_MS
    out.push({
      ...(before ?? {}),
      sessionId: e.sessionId,
      cwd: e.cwd || before?.cwd || "",
      client: "claude",
      name: e.name ?? before?.name,
      pid: e.pid,
      pidStart,
      interactive: !!tty,
      startedAt: before?.startedAt ?? e.startedAt ?? now,
      seenAt: now,
      watchedAt: fresh ? before!.watchedAt : now,
      terminal: fresh ? before!.terminal : terminalOf(tty, sys.env(e.pid) ?? {}, sys, lazyPanes),
      adopted: "watched",
    })
  }
  // Watched, gone, and its registry file removed within this boot: it exited
  // the normal way, so it is not offered back as lost.
  for (const r of o.records) {
    if (r.adopted !== "watched" || r.endedAt || live.has(r.sessionId)) continue
    if (r.seenAt < o.boot || o.registryPids.has(r.pid)) continue
    if (sys.alive(r.pid, r.pidStart)) continue
    out.push({ ...r, endedAt: now, endReason: "exit" })
  }
  return out
}

/** Watch now: snapshot every pre-crosstalk session into a restore record. */
export function watch(self?: string, sys: Sys = liveSys()): Rec[] {
  const recs = snapshot({
    self,
    registry: readRegistry(registryDir(), (p) => sys.alive(p)),
    records: R.readAll(),
    registryPids: registryPids(),
    boot: R.bootTime(process.env, sys.now()),
    sys,
  })
  for (const r of recs) R.writeRec(r)
  return recs
}

export const WATCH_EVERY_MS = () => Number(process.env.CROSSTALK_WATCH_EVERY_MS ?? 60_000)
const stampFile = () => path.join(P.root, "watch-stamp")

/** Watch at most once a minute across every hook and mod on the machine. One stat when not due. */
export function watchThrottled(self?: string, now = Date.now()): boolean {
  try {
    if (now - fs.statSync(stampFile()).mtimeMs < WATCH_EVERY_MS()) return false
  } catch {}
  try {
    fs.mkdirSync(P.root, { recursive: true, mode: 0o700 })
    fs.writeFileSync(stampFile(), String(now), { mode: 0o600 })
    watch(self)
    return true
  } catch {
    return false
  }
}

// --- the offer -------------------------------------------------------------------

type GState = {
  /** Which sessions have been offered, so the question is put once. */
  offered?: { at: number; by?: string; ids: string[] }
  /** Receipts for the session that asked, taken once by the mod or the hook. */
  notes?: { id: string; session?: string; text: string; at: number }[]
}
const stateFile = () => path.join(P.root, "gather-state.json")
export function loadState(): GState {
  try {
    return JSON.parse(fs.readFileSync(stateFile(), "utf8"))
  } catch {
    return {}
  }
}
function saveState(s: GState) {
  fs.mkdirSync(P.root, { recursive: true, mode: 0o700 })
  const tmp = `${stateFile()}.${process.pid}.tmp`
  fs.writeFileSync(tmp, JSON.stringify(s, null, 2), { mode: 0o600 })
  fs.renameSync(tmp, stateFile())
}

const sleepSync = (ms: number) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms)
function locked<T>(fn: () => T): T | null {
  const lock = path.join(P.root, "gather.lock")
  fs.mkdirSync(P.root, { recursive: true, mode: 0o700 })
  let held = false
  for (let i = 0; i < 100 && !held; i++) {
    try {
      fs.mkdirSync(lock)
      held = true
    } catch {
      try {
        if (Date.now() - fs.statSync(lock).mtimeMs > 10_000) fs.rmdirSync(lock)
      } catch {}
      sleepSync(10)
    }
  }
  if (!held) return null
  try {
    return fn()
  } finally {
    try {
      fs.rmdirSync(lock)
    } catch {}
  }
}

/** Pids from this process up: the session asking, however it asks. */
export function ancestors(pid = process.pid, sys: Pick<Sys, "ps"> = { ps }): number[] {
  const out: number[] = []
  let p = pid
  for (let i = 0; i < 12 && p > 1; i++) {
    out.push(p)
    const up = Number(sys.ps(p, "ppid"))
    if (!up || up === p) break
    p = up
  }
  return out
}

/** Watched sessions that could be brought in now: alive, in a tab, not the asker. */
export function candidates(recs: Rec[], o: { self?: string; selfPids?: number[]; alive: (r: Rec) => boolean }): Rec[] {
  return recs
    .filter(
      (r) =>
        r.adopted === "watched" &&
        !r.endedAt &&
        r.interactive !== false &&
        r.sessionId !== o.self &&
        !(o.selfPids ?? []).includes(r.pid) &&
        r.gather?.state !== "done" &&
        o.alive(r),
    )
    .sort((a, b) => a.startedAt - b.startedAt)
}

export type Offer = { text: string; question: string; count: number; names: string[] }

export const offerQuestion = (n: number) =>
  `${n} Claude session${n === 1 ? "" : "s"} started before crosstalk. Bring ${n === 1 ? "it" : "them"} in? Idle ones restart in their tab with their conversation.`

/** The offer for this set of sessions, if it has not been put: only new sessions are asked about again. */
export function offerFor(cands: Rec[], state: GState): Offer | null {
  const asked = new Set(state.offered?.ids ?? [])
  if (!cands.length || cands.every((r) => asked.has(r.sessionId))) return null
  const n = cands.length
  const names = cands.slice(0, 4).map(label).concat(n > 4 ? ["…"] : [])
  return {
    count: n,
    names,
    question: offerQuestion(n),
    text: `◢ crosstalk: ${offerQuestion(n)} (${names.join(", ")}) Say "bring them in" to do it.`,
  }
}

const label = (r: Rec) => (r.name && !/^session-\d+$/.test(r.name) ? r.name : path.basename(r.cwd) || r.sessionId.slice(0, 8))

/** Put the offer once, under the lock, so two sessions starting together do not both ask. */
export function offerOnce(self?: string): Offer | null {
  const cands = candidates(R.readAll(), { self, selfPids: ancestors(), alive: R.recAlive })
  if (!offerFor(cands, loadState())) return null
  return locked(() => {
    const s = loadState()
    const offer = offerFor(cands, s)
    if (!offer) return null
    saveState({ ...s, offered: { at: Date.now(), by: self, ids: [...new Set([...(s.offered?.ids ?? []), ...cands.map((r) => r.sessionId)])] } })
    return offer
  })
}

/** Take this session's receipt, once. */
export function takeNote(session: string | undefined, id?: string): { id: string; text: string } | null {
  if (!loadState().notes?.some((n) => (!session || !n.session || n.session === session) && (!id || n.id === id))) return null
  return locked(() => {
    const s = loadState()
    const i = (s.notes ?? []).findIndex((n) => (!session || !n.session || n.session === session) && (!id || n.id === id))
    if (i === -1) return null
    const [n] = s.notes!.splice(i, 1)
    saveState(s)
    return { id: n.id, text: n.text }
  })
}

/** This session's receipt, without taking it. */
export function peekNote(session: string): { id: string; text: string } | null {
  const n = loadState().notes?.find((x) => !x.session || x.session === session)
  return n ? { id: n.id, text: n.text } : null
}

function addNote(session: string | undefined, text: string) {
  locked(() => {
    const s = loadState()
    const now = Date.now()
    const notes = (s.notes ?? []).filter((n) => now - n.at < 24 * 60 * 60 * 1000)
    notes.push({ id: `gather-note:${now.toString(36)}`, session, text, at: now })
    saveState({ ...s, notes })
  })
}

// --- restarting in place --------------------------------------------------------

/**
 * Terminal.app: type into the very tab the session was in, now back at its
 * shell prompt. With its tty, only if that tab still shows it: a tab number
 * can shift as tabs close, and the next tab may be another live session.
 */
export const appleInPlaceScript = (cmd: string, window: number, tab: number, tty?: string) =>
  tty
    ? [
        `tell application "Terminal"`,
        `\tif (tty of tab ${tab} of window id ${window}) is not ${R.asq(tty)} then error "that tab no longer shows ${tty.replace(/["\\]/g, "")}"`,
        `\tdo script ${R.asq(cmd)} in tab ${tab} of window id ${window}`,
        `end tell`,
      ].join("\n")
    : `tell application "Terminal" to do script ${R.asq(cmd)} in tab ${tab} of window id ${window}`

/** iTerm2: the session showing that tty, told to type the command. */
export const itermInPlaceScript = (cmd: string, tty: string) =>
  [
    `tell application "iTerm2"`,
    `\trepeat with w in windows`,
    `\t\trepeat with t in tabs of w`,
    `\t\t\trepeat with s in sessions of t`,
    `\t\t\t\tif (tty of s) is ${R.asq(tty)} then`,
    `\t\t\t\t\ttell s to write text ${R.asq(cmd)}`,
    `\t\t\t\t\treturn "done"`,
    `\t\t\t\tend if`,
    `\t\t\tend repeat`,
    `\t\tend repeat`,
    `\tend repeat`,
    `end tell`,
    `error "no iTerm2 session on ${tty.replace(/["\\]/g, "")}"`,
  ].join("\n")

export type InPlace = { kind: "tmux" | "apple" | "iterm" | "kitty" | "wezterm"; steps: Step[] }

/**
 * How to type `cmd` into the tab a session was in, or null when that terminal
 * cannot be typed into from outside (the session then reopens in a new tab).
 */
export function inPlaceSteps(t: Term, cmd: string, platform: NodeJS.Platform = process.platform): InPlace | null {
  if (/[\n\r\0]/.test(cmd)) return null
  if (t.tmux?.pane) {
    const S = t.tmux.socket ? ["-S", t.tmux.socket] : []
    return {
      kind: "tmux",
      steps: [
        { cmd: "tmux", args: [...S, "send-keys", "-t", t.tmux.pane, "-l", cmd] },
        { cmd: "tmux", args: [...S, "send-keys", "-t", t.tmux.pane, "Enter"] },
      ],
    }
  }
  if (platform === "darwin" && t.program === "Apple_Terminal" && t.apple?.window && t.apple.tab)
    return { kind: "apple", steps: [{ cmd: "osascript", args: ["-"], input: appleInPlaceScript(cmd, t.apple.window, t.apple.tab, t.tty) }] }
  if (platform === "darwin" && (t.program === "iTerm.app" || t.iterm) && t.tty)
    return { kind: "iterm", steps: [{ cmd: "osascript", args: ["-"], input: itermInPlaceScript(cmd, t.tty) }] }
  if (t.kitty?.window && t.kitty.listenOn)
    return { kind: "kitty", steps: [{ cmd: "kitten", args: ["@", "--to", t.kitty.listenOn, "send-text", "--match", `id:${t.kitty.window}`, `${cmd}\r`] }] }
  if (t.wezterm?.pane)
    return { kind: "wezterm", steps: [{ cmd: "wezterm", args: ["cli", "send-text", "--pane-id", t.wezterm.pane, "--no-paste", `${cmd}\r`] }] }
  return null
}

/**
 * End a claude process the way a person would: SIGTERM, then SIGINT twice.
 * Never SIGKILL. Before every signal the pid is checked to still be the very
 * process recorded (same start time), so a reused pid is never touched.
 */
export async function endGracefully(pid: number, pidStart: string | undefined, sys: Sys, waits = [10_000, 5_000, 5_000]): Promise<boolean> {
  const sigs: NodeJS.Signals[] = ["SIGTERM", "SIGINT", "SIGINT"]
  // Strict: a ps that fails is "unknown", never "same", so no signal goes to a pid that may be someone else's.
  const state = (): "same" | "gone" | "unknown" => (sys.state ? sys.state(pid, pidStart) : sys.alive(pid, pidStart) ? "same" : "gone")
  for (let i = 0; i < sigs.length; i++) {
    const st = state()
    if (st === "gone") return true
    if (st === "unknown") return false
    try {
      sys.kill(pid, sigs[i])
    } catch {
      return state() === "gone"
    }
    for (let waited = 0; waited < waits[i]; waited += 100) {
      if (state() === "gone") return true
      await sys.sleep(100)
    }
  }
  return state() === "gone"
}

const job = () => path.join(P.root, "gather-job.json")
export type Job = {
  by?: string
  /** Every pid from the asker up, never restarted. */
  selfPids: number[]
  pending: string[]
  until: number
  done: string[]
  newTab: string[]
  failed: { id: string; why: string }[]
}
function loadJob(): Job | null {
  try {
    return JSON.parse(fs.readFileSync(job(), "utf8"))
  } catch {
    return null
  }
}
function saveJob(j: Job) {
  fs.mkdirSync(P.root, { recursive: true, mode: 0o700 })
  const tmp = `${job()}.${process.pid}.tmp`
  fs.writeFileSync(tmp, JSON.stringify(j, null, 2), { mode: 0o600 })
  fs.renameSync(tmp, job())
}

export const UNTIL_MS = () => Number(process.env.CROSSTALK_GATHER_UNTIL_MS ?? 2 * 60 * 60 * 1000)
const POLL_MS = () => Number(process.env.CROSSTALK_GATHER_POLL_MS ?? 2000)

export type StepResult = "wait" | "done" | "newTab" | "gone" | { failed: string }

/**
 * One watched session, if it is idle: end it, and bring it back with its
 * conversation in the same tab. Busy, it waits for the next pass.
 */
export async function restartOne(
  id: string,
  o: { self?: string; selfPids: number[]; sys: Sys; registry: RegEntry[]; reopen: (r: Rec) => boolean },
): Promise<StepResult> {
  const { sys } = o
  const rec = R.readOne(id)
  if (!rec || rec.adopted !== "watched") return "gone" // it has its own record now: crosstalk is in
  if (id === o.self || o.selfPids.includes(rec.pid)) return { failed: "it is the session asking" }
  const reg = o.registry.find((e) => e.sessionId === id)
  if (!reg || reg.pid !== rec.pid || !sys.alive(rec.pid, rec.pidStart)) return "gone"
  if (reg.status !== "idle") return "wait"
  // Idle, but something it started still runs: ending it would end that too.
  if (sys.activity?.(rec.pid).length) return "wait"
  const args = sys.ps(rec.pid, "args") ?? ""
  if (!isClaudeArgs(args)) return { failed: "its process is not claude" }
  const parent = Number(sys.ps(rec.pid, "ppid"))
  const parentComm = path.basename(sys.ps(parent, "comm") ?? "")
  const inShell = R.SHELL.test(parentComm)
  const cmd = R.typed(rec)

  // Look the tab up again: it may have moved since the last watch. Not
  // found, the old tab number may now be another session's: never typed
  // into, the session reopens in a new tab instead.
  let term = rec.terminal
  if (sys.platform === "darwin" && term.program === "Apple_Terminal") {
    const at = term.tty ? sys.appleLocate(term.tty) : null
    term = at ? { ...term, apple: { ...term.apple, ...at } } : { ...term, apple: { sessionId: term.apple?.sessionId } }
  }
  const how = inShell ? inPlaceSteps(term, cmd, sys.platform) : null

  // Ended on purpose: restore must not take this exit for a crash.
  const ending: Rec = { ...rec, terminal: term, endedAt: sys.now(), endReason: "gather", gather: { state: "restarting", at: sys.now() } }
  R.writeRec(ending)
  if (!(await endGracefully(rec.pid, rec.pidStart, sys))) {
    const { endedAt, endReason, ...back } = ending
    R.writeRec({ ...back, gather: { state: "failed", at: sys.now() } })
    return { failed: "it did not exit" }
  }
  await sys.sleep(400) // the shell prints its prompt
  if (how) {
    let ok = true
    for (const s of how.steps) if (!(ok = sys.run(s).ok)) break
    if (ok) {
      R.writeRec({ ...ending, gather: { state: "done", at: sys.now() } })
      return "done"
    }
  }
  // Its tab cannot be typed into: a new tab, through restore's adapters.
  const back: Rec = { ...ending, endedAt: undefined, endReason: undefined }
  if (o.reopen(back)) {
    R.writeRec({ ...ending, gather: { state: "done", at: sys.now() } })
    return "newTab"
  }
  return { failed: "it could not be reopened" }
}

function startWaiter(root?: string) {
  if (process.env.CROSSTALK_NO_WAITER) return
  try {
    const child = spawn(shim(root ?? rootFrom(import.meta.url)), ["gather", "--finish"], { detached: true, stdio: "ignore" })
    child.unref()
  } catch {}
}

export type Outcome = { ok: boolean; text: string; sessions: Rec[] }

/** What would be brought in, without doing it. */
export function describe(self?: string): Outcome {
  watch(self)
  const cands = candidates(R.readAll(), { self, selfPids: ancestors(), alive: R.recAlive })
  if (!cands.length) return { ok: true, text: "◢ crosstalk: every running Claude session already has crosstalk.", sessions: [] }
  const reg = new Map(readRegistry().map((e) => [e.sessionId, e]))
  const lines = [`◢ crosstalk: ${cands.length} Claude session${cands.length === 1 ? "" : "s"} started before crosstalk:`]
  for (const r of cands) lines.push(`  ${label(r).padEnd(16)} ${r.cwd}  (${reg.get(r.sessionId)?.status ?? "unknown"})`)
  lines.push(`Bringing them in restarts each one in its own tab with its conversation, once it is idle.`)
  return { ok: true, text: lines.join("\n"), sessions: cands }
}

/**
 * Yes: queue every candidate and start the waiter, which restarts the idle
 * ones now and the busy ones once they go idle.
 */
export function start(o: { self?: string; root?: string; peer?: string }): Outcome {
  const bot = refuseBot(o.peer, "restart sessions on this machine")
  if (bot) return { ok: false, text: `◢ crosstalk: ${bot}`, sessions: [] }
  watch(o.self)
  const selfPids = ancestors()
  const cands = candidates(R.readAll(), { self: o.self, selfPids, alive: R.recAlive })
  if (!cands.length) return { ok: true, text: "◢ crosstalk: every running Claude session already has crosstalk.", sessions: [] }
  const before = loadJob()
  const pending = [...new Set([...(before && before.until > Date.now() ? before.pending : []), ...cands.map((r) => r.sessionId)])]
  saveJob({
    by: o.self,
    selfPids: [...new Set([...selfPids, ...(before?.selfPids ?? [])])],
    pending,
    until: Date.now() + UNTIL_MS(),
    done: before?.until && before.until > Date.now() ? before.done : [],
    newTab: before?.until && before.until > Date.now() ? before.newTab : [],
    failed: [],
  })
  for (const r of cands) R.writeRec({ ...r, gather: { state: "queued", at: Date.now() } })
  locked(() => {
    const s = loadState()
    saveState({ ...s, offered: { at: Date.now(), by: o.self, ids: [...new Set([...(s.offered?.ids ?? []), ...pending])] } })
  })
  startWaiter(o.root)
  const reg = new Map(readRegistry().map((e) => [e.sessionId, e]))
  const busy = cands.filter((r) => reg.get(r.sessionId)?.status !== "idle")
  const n = cands.length
  const idle = n - busy.length
  const parts = [`◢ crosstalk: bringing ${n} session${n === 1 ? "" : "s"} into crosstalk (${names(cands)}).`]
  if (idle) parts.push(`${idle === n ? (n === 1 ? "It is" : "They are") : `${idle} ${idle === 1 ? "is" : "are"}`} idle and restart${idle === 1 ? "s" : ""} in ${idle === 1 ? "its" : "their"} tab now, with ${idle === 1 ? "its" : "their"} conversation.`)
  if (busy.length) parts.push(`${busy.length === n ? (n === 1 ? "It is" : "They are") : `${busy.length} ${busy.length === 1 ? "is" : "are"}`} busy (${names(busy)}) and restart${busy.length === 1 ? "s" : ""} when ${busy.length === 1 ? "it goes" : "they go"} idle.`)
  return { ok: true, text: parts.join(" "), sessions: cands }
}

const names = (rs: Rec[], max = 4) => rs.slice(0, max).map(label).join(", ") + (rs.length > max ? ", …" : "")

/** The receipt, in plain words. */
export function receipt(j: Pick<Job, "done" | "newTab" | "failed">): string {
  const n = j.done.length + j.newTab.length
  const parts: string[] = []
  if (n) parts.push(`${n} session${n === 1 ? " is" : "s are"} now in crosstalk.`)
  if (j.newTab.length) parts.push(`${j.newTab.length} could not be typed into ${j.newTab.length === 1 ? "its" : "their"} old tab, so ${j.newTab.length === 1 ? "it" : "they"} opened in a new one.`)
  if (j.failed.length) parts.push(`${j.failed.length} left as ${j.failed.length === 1 ? "it was" : "they were"}: ${j.failed.map((f) => f.why).join("; ")}.`)
  return parts.join(" ") || "No session needed bringing in."
}

/**
 * The detached waiter. Polls the registry every two seconds, restarts each
 * queued session the moment it is idle, and gives up on the rest after two
 * hours. One runs at a time; a second one leaves at once.
 */
export async function finish(sys: Sys = liveSys()): Promise<string> {
  const lock = path.join(P.root, "gather-runner.pid")
  try {
    const other = Number(fs.readFileSync(lock, "utf8"))
    if (other && other !== process.pid && R.pidAlive(other)) return "already running"
  } catch {}
  fs.mkdirSync(P.root, { recursive: true, mode: 0o700 })
  fs.writeFileSync(lock, String(process.pid), { mode: 0o600 })
  try {
    for (;;) {
      const j = loadJob()
      if (!j) return "nothing queued"
      if (!j.pending.length || sys.now() > j.until) {
        const left = j.pending
        for (const id of left) {
          const r = R.readOne(id)
          if (r?.gather?.state === "queued") R.writeRec({ ...r, gather: undefined })
        }
        const text = receipt({ ...j, failed: [...j.failed, ...(left.length ? [{ id: "", why: `${left.length} never went idle` }] : [])] })
        if (j.done.length || j.newTab.length || j.failed.length || left.length) {
          addNote(j.by, `◢ crosstalk: ${text}`)
          notify(text)
        }
        try {
          fs.unlinkSync(job())
        } catch {}
        return text
      }
      const registry = readRegistry(registryDir(), (p) => sys.alive(p))
      for (const id of [...j.pending]) {
        const r = await restartOne(id, {
          self: j.by,
          selfPids: j.selfPids,
          sys,
          registry,
          // The person said "bring them in": as tabs, the way they asked, never a window each.
          reopen: (rec) => R.restore({ self: j.by, userAction: false, asked: true, tabs: true }, [rec]).restored.length > 0,
        })
        if (r === "wait") continue
        const cur = loadJob() ?? j
        cur.pending = cur.pending.filter((x) => x !== id)
        if (r === "done") cur.done.push(id)
        else if (r === "newTab") cur.newTab.push(id)
        else if (typeof r === "object") cur.failed.push({ id, why: r.failed })
        saveJob(cur)
        Object.assign(j, cur)
      }
      if (loadJob()?.pending.length) await sys.sleep(POLL_MS())
    }
  } finally {
    try {
      if (Number(fs.readFileSync(lock, "utf8")) === process.pid) fs.unlinkSync(lock)
    } catch {}
  }
}

function notify(text: string) {
  if (process.platform !== "darwin" || process.env.CROSSTALK_NO_OPEN) return
  spawnSync("osascript", ["-e", `display notification ${R.asq(text)} with title "crosstalk"`], { timeout: 5000 })
}
