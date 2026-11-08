// Status on tabs: each session shows on its own tab whether it is working,
// waiting on the person, or done.
//
// Who says so: the session itself. With crosstalk's mod, its turn and watch
// hooks; without it, the classic hooks (UserPromptSubmit working, Stop done or
// waiting when something of crosstalk's is pending for it, Notification for a
// permission prompt waiting, SessionEnd off). Both go through `want()` here,
// which only writes the state wanted and starts a detached applier when it
// changed, so a hook pays one small file write and, at most, one fork.
//
// How it shows, per terminal (src/restore.ts says which terminal a session is
// in, from its hook):
//
//   every hook        OSC 9;4 progress through the hook's `terminalSequence`,
//                     the one status sequence Claude Code lets a hook emit,
//                     for terminals that draw it (Ghostty, WezTerm, iTerm2 3.6+,
//                     Windows Terminal, tmux 3.7+)
//   tmux              a window option, `@crosstalk_state`, set with
//                     `set-option -w`. Nothing of the person's status line is
//                     touched; `crosstalk term tmux-snippet` prints the format
//                     to add if they want to see it.
//   Terminal.app      nothing, by default: Terminal.app has no tab badge, only
//                     the tab's background colour, and changing that is too
//                     much to do unasked. With CROSSTALK_TAB_COLOUR=1 the
//                     background is tinted through AppleScript, on the tab
//                     whose tty is the session's, from the original, which is
//                     put back when the session is done or ends. With it off,
//                     a colour crosstalk changed earlier is put back.
//   iTerm2            OSC 6 tab colour and a user var, written to the tty
//   kitty             `kitten @ set-tab-color` and `set-user-vars`
//   WezTerm           a user var, `crosstalk_state`, written to the tty, for a
//                     `format-tab-title` handler (docs/terminal.md)
//
// The title is never set: Claude Code owns it. Names go through sessionTitle.
// Nothing here queries the terminal: an answer would land in the prompt.

import fs from "node:fs"
import path from "node:path"
import { spawn, spawnSync } from "node:child_process"
import { P } from "../config.ts"
import { shim } from "../paths.ts"
import * as R from "../restore.ts"
import type { Step, Term } from "../restore.ts"
import * as osc7501 from "../attention/osc7501.ts"

/**
 * `broken`: a service of the session's crashed or stopped answering
 * (src/urls/health/). Red, and like waiting it needs someone; while it is
 * marked, done and waiting show as broken, working still as working.
 */
export type TabState = "working" | "waiting" | "done" | "broken" | "off"

/** What a terminal draws for each state, as 8-bit RGB. */
export const COLOUR: Record<Exclude<TabState, "off">, [number, number, number]> = {
  working: [47, 111, 214],
  waiting: [229, 140, 10],
  done: [46, 160, 67],
  broken: [214, 48, 49],
}
export const hex = ([r, g, b]: [number, number, number]) => `#${[r, g, b].map((n) => n.toString(16).padStart(2, "0")).join("")}`

// --- what state ------------------------------------------------------------------

/**
 * The state a classic hook event means, or null for "no change".
 *
 *   UserPromptSubmit   working
 *   Stop               waiting if something of crosstalk's is pending, else done
 *   Notification       waiting, for a permission prompt or a question; the
 *                      60-second idle reminder changes nothing
 *   PostToolUse        working again, after a permission prompt was answered
 *   SessionEnd         off
 */
export function stateForEvent(o: { event: string; pending: number; current?: TabState; notificationType?: string; message?: string }): TabState | null {
  switch (o.event) {
    case "UserPromptSubmit":
      return "working"
    case "Stop":
      return o.pending > 0 ? "waiting" : "done"
    case "Notification": {
      const t = o.notificationType ?? ""
      if (/idle/i.test(t)) return o.pending > 0 && o.current !== "working" ? "waiting" : null
      if (!t && !/permission|waiting|needs|approve|input/i.test(o.message ?? "")) return null
      return "waiting"
    }
    case "PostToolUse":
    case "PreToolUse":
      return o.current === "waiting" ? "working" : null
    case "SessionEnd":
      return "off"
    default:
      return null
  }
}

/**
 * The state from Claude Code's session registry and crosstalk's pending items,
 * for a refresh with no event: the mod's watch, after its items changed.
 */
export function stateFromRegistry(o: { status?: string; pending: number; current?: TabState }): TabState | null {
  const s = (o.status ?? "").toLowerCase()
  if (/^(busy|running|working|thinking)$/.test(s)) return "working"
  if (/^(waiting|blocked|permission|needs.?input)$/.test(s)) return "waiting"
  if (o.current === "working" && s !== "idle") return null
  if (o.pending > 0) return o.current === "off" && s !== "idle" ? null : "waiting"
  if (o.current === "waiting" || (s === "idle" && o.current === "working")) return "done"
  return null
}

// --- the hook's sequence -----------------------------------------------------------

const ST = "\x1b\\"

/** OSC 9;4: 3 is indeterminate (working), 4 paused (waiting), 2 error (broken), 0 clears. */
export function progressSequence(state: TabState): string {
  if (state === "working") return `\x1b]9;4;3${ST}`
  if (state === "broken") return `\x1b]9;4;2;100${ST}`
  if (state === "waiting") return `\x1b]9;4;4;100${ST}`
  return `\x1b]9;4;0${ST}`
}

/**
 * Whether this terminal draws OSC 9;4. Elsewhere it is left out: older iTerm2
 * and kitty read OSC 9 as a notification and would pop "4;3" up.
 */
export function drawsProgress(env: NodeJS.ProcessEnv): boolean {
  if (env.TMUX) return true // 3.7 forwards it; older tmux drops it silently
  if (env.WT_SESSION) return true
  const p = env.TERM_PROGRAM ?? ""
  if (p === "ghostty" || p === "WezTerm") return true
  if (p === "iTerm.app") {
    const [maj, min] = (env.TERM_PROGRAM_VERSION ?? "0").split(".").map(Number)
    return maj > 3 || (maj === 3 && min >= 6)
  }
  return false
}

// --- per terminal ----------------------------------------------------------------

export type Action =
  | { kind: "run"; step: Step; optional?: boolean }
  | { kind: "tty"; path: string; data: string }
  | { kind: "apple"; tty: string }

const b64 = (s: string) => Buffer.from(s, "utf8").toString("base64")

/** iTerm2's tab colour, OSC 6, one channel per sequence; reset with `*;default`. */
export function itermTabColour(state: TabState): string {
  if (state === "off") return `\x1b]6;1;bg;*;default\x07`
  const [r, g, b] = COLOUR[state]
  return `\x1b]6;1;bg;red;brightness;${r}\x07\x1b]6;1;bg;green;brightness;${g}\x07\x1b]6;1;bg;blue;brightness;${b}\x07`
}

/** A user var, for iTerm2 badges and WezTerm's tab title handler. Empty unsets. */
export const userVar = (state: TabState) => `\x1b]1337;SetUserVar=crosstalk_state=${state === "off" ? "" : b64(state)}\x07`

export const TMUX_OPTION = "@crosstalk_state"

/** tmux, the person's own or crosstalk's: one window option, and a redraw if a client is attached. */
export function tmuxActions(t: NonNullable<Term["tmux"]>, state: TabState): Action[] {
  const S = t.socket ? ["-S", t.socket] : []
  const set =
    state === "off"
      ? ["set-option", "-w", "-u", "-t", t.pane, TMUX_OPTION]
      : ["set-option", "-w", "-t", t.pane, TMUX_OPTION, state]
  return [
    { kind: "run", step: { cmd: "tmux", args: [...S, ...set] } },
    { kind: "run", step: { cmd: "tmux", args: [...S, "refresh-client", "-S"] }, optional: true },
  ]
}

/** kitty, by its remote control: the tab holding the session's window. */
export function kittyActions(k: NonNullable<Term["kitty"]>, state: TabState): Action[] {
  if (!k.window || !k.listenOn) return []
  const c = state === "off" ? "NONE" : hex(COLOUR[state])
  return [
    { kind: "run", step: { cmd: "kitten", args: ["@", "--to", k.listenOn, "set-tab-color", "--match", `window_id:${k.window}`, `active_bg=${c}`, `inactive_bg=${c}`] } },
    { kind: "run", step: { cmd: "kitten", args: ["@", "--to", k.listenOn, "set-user-vars", "--match", `id:${k.window}`, `crosstalk_state=${state === "off" ? "" : state}`] }, optional: true },
  ]
}

/**
 * Everything to do to show `state` on this session's tab. tmux comes first and
 * alone: inside tmux the outer terminal's tab is the tmux client, shared by
 * every window in it.
 */
export function actionsFor(t: Term, state: TabState, platform: NodeJS.Platform = process.platform): Action[] {
  if (t.tmux?.pane) return tmuxActions(t.tmux, state)
  const out: Action[] = []
  const k = R.kindOf(t)
  if (k === "kitty" && t.kitty) out.push(...kittyActions(t.kitty, state))
  else if (k === "iterm" && t.tty) out.push({ kind: "tty", path: t.tty, data: itermTabColour(state) + userVar(state) })
  else if (k === "wezterm" && t.tty) out.push({ kind: "tty", path: t.tty, data: userVar(state) })
  else if (k === "apple" && t.tty && platform === "darwin") out.push({ kind: "apple", tty: t.tty })
  // The Program Status Protocol, opt-in, for the terminals that read it (src/attention/osc7501.ts).
  if (osc7501.enabled() && osc7501.reads7501(t) && t.tty) out.push({ kind: "tty", path: t.tty, data: osc7501.sequence(state) })
  return out
}

// --- Terminal.app ----------------------------------------------------------------

/** Terminal.app colours are 16-bit. */
export type RGB16 = [number, number, number]

const appleTab = (tty: string, body: string[]) =>
  [
    `if application "Terminal" is running then`,
    `\ttell application "Terminal"`,
    `\t\trepeat with w in windows`,
    `\t\t\trepeat with t in tabs of w`,
    `\t\t\t\tif (tty of t) is ${R.asq(tty)} then`,
    ...body.map((l) => `\t\t\t\t\t${l}`),
    `\t\t\t\tend if`,
    `\t\t\tend repeat`,
    `\t\tend repeat`,
    `\tend tell`,
    `end if`,
    `return ""`,
  ].join("\n")

/** The tab's background colour now, as "r,g,b", so it can be put back. Never launches Terminal. */
export const appleReadBgScript = (tty: string) =>
  appleTab(tty, [`set c to background color of t`, `return ((item 1 of c) as text) & "," & ((item 2 of c) as text) & "," & ((item 3 of c) as text)`])

export const appleSetBgScript = (tty: string, c: RGB16) =>
  appleTab(tty, [`set background color of t to {${c.map((n) => Math.round(n)).join(", ")}}`, `return "done"`])

export function parseRgb16(s: string): RGB16 | null {
  const m = /^(\d+),(\d+),(\d+)$/.exec(s.trim())
  return m ? [Number(m[1]), Number(m[2]), Number(m[3])] : null
}

/**
 * The tint for a state: the original background moved a quarter of the way
 * toward the state's colour, so a light or a dark profile both stay readable.
 * Done is the original: Terminal.app shows only what needs a look.
 */
export function appleTint(original: RGB16, state: TabState, amount = 0.25): RGB16 {
  if (state === "off" || state === "done") return original
  const target = COLOUR[state].map((n) => n * 257)
  return original.map((o, i) => Math.round(o + (target[i] - o) * amount)) as RGB16
}

// --- the want file and the applier ---------------------------------------------------

export type TabFile = {
  sessionId: string
  want: TabState
  wantAt: number
  applied?: TabState
  appliedAt?: number
  /** Terminal.app: the tab's own background, put back on done and exit. */
  appleOriginal?: string
  /** What of this session's is broken (src/urls/health/); while set, done and waiting show as broken. */
  broken?: string
  /** The state last asked for, before `broken` was laid over it. */
  base?: TabState
  /** Terminal.app: the title last given to the tab (nameTab). */
  title?: string
}

/** What a tab shows for a state asked for, with `broken` laid over it. */
export const overlay = (state: TabState, broken: string | undefined): TabState => (broken && (state === "done" || state === "waiting") ? "broken" : state)

/** The state a hook should draw: the one asked for, with this session's broken mark laid over it. */
export function shownState(sessionId: string, state: TabState): TabState {
  return overlay(state, readTab(sessionId)?.broken)
}

const dir = () => path.join(P.root, "tabs")
const safe = (id: string) => id.replace(/[^A-Za-z0-9._-]/g, "_")
const fileOf = (id: string) => path.join(dir(), `${safe(id)}.json`)

export function readTab(id: string): TabFile | null {
  try {
    return JSON.parse(fs.readFileSync(fileOf(id), "utf8"))
  } catch {
    return null
  }
}

function writeTab(f: TabFile) {
  fs.mkdirSync(dir(), { recursive: true, mode: 0o700 })
  const tmp = `${fileOf(f.sessionId)}.${process.pid}.tmp`
  fs.writeFileSync(tmp, JSON.stringify(f), { mode: 0o600 })
  fs.renameSync(tmp, fileOf(f.sessionId))
}

const sleepSync = (ms: number) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms)

/** A short lock around one session's file: the hook and the applier both write it. */
function withFile<T>(id: string, fn: (f: TabFile | null) => T): T {
  fs.mkdirSync(dir(), { recursive: true, mode: 0o700 })
  const lock = `${fileOf(id)}.lock`
  let held = false
  for (let i = 0; i < 50 && !held; i++) {
    try {
      fs.mkdirSync(lock)
      held = true
    } catch {
      try {
        if (Date.now() - fs.statSync(lock).mtimeMs > 5000) fs.rmdirSync(lock)
      } catch {}
      sleepSync(5)
    }
  }
  try {
    return fn(readTab(id))
  } finally {
    if (held)
      try {
        fs.rmdirSync(lock)
      } catch {}
  }
}

/** At most one change per tab this often; the last state asked for always lands. */
export const MIN_GAP_MS = () => Number(process.env.CROSSTALK_TAB_GAP_MS ?? 750)

export type Decision = { act: "apply" } | { act: "wait"; ms: number } | { act: "idle" }

/** The applier's throttle: apply now, wait out the gap, or stop because it shows what is wanted. */
export function decide(f: TabFile | null, now: number, gap = MIN_GAP_MS()): Decision {
  if (!f || f.applied === f.want) return { act: "idle" }
  if (f.appliedAt !== undefined && now - f.appliedAt < gap) return { act: "wait", ms: gap - (now - f.appliedAt) }
  return { act: "apply" }
}

/**
 * Ask for a state. Writes it, and starts the applier when the tab does not
 * already show it. Cheap enough for any hook: one read, at most one write and
 * one fork. Returns whether anything changed.
 */
export function want(o: { sessionId: string; state: TabState; root: string; now?: number }): boolean {
  const now = o.now ?? Date.now()
  const changed = withFile(o.sessionId, (f) => {
    // Nothing was ever shown, so there is nothing to clear.
    if (!f && o.state === "off") return false
    // A session that ends takes its broken mark with it.
    const broken = o.state === "off" ? undefined : f?.broken
    const shown = overlay(o.state, broken)
    if (f && f.want === shown && (f.base ?? f.want) === o.state) return f.applied !== shown && now - f.wantAt > 5000
    const next: TabFile = { ...(f ?? { sessionId: o.sessionId }), sessionId: o.sessionId, want: shown, wantAt: f?.want === shown ? f.wantAt : now, base: o.state }
    if (!broken) delete next.broken
    writeTab(next)
    return f?.want !== shown
  })
  if (changed) startApplier(o.sessionId, o.root)
  return changed
}

/**
 * Mark a session's tab broken (`what`, for the record), or with null, not any
 * more. Marked, it shows red at once; cleared, it goes back to the state last
 * asked for.
 */
export function setBroken(o: { sessionId: string; what: string | null; root: string; now?: number }): boolean {
  const now = o.now ?? Date.now()
  const changed = withFile(o.sessionId, (f) => {
    if (!o.what && !f?.broken) return false
    const base: TabState = f?.base ?? (f?.want && f.want !== "broken" ? f.want : "done")
    if (o.what) {
      if (f?.broken === o.what && f.want === "broken") return false
      writeTab({ ...(f ?? { sessionId: o.sessionId }), sessionId: o.sessionId, broken: o.what.slice(0, 200), base, want: "broken", wantAt: now })
      return f?.want !== "broken"
    }
    const next: TabFile = { ...f!, base, want: base, wantAt: now }
    delete next.broken
    writeTab(next)
    return f!.want !== base
  })
  if (changed) startApplier(o.sessionId, o.root)
  return changed
}

function startApplier(id: string, root: string) {
  if (process.env.CROSSTALK_TERM_SYNC) {
    void applyLoop(id)
    return
  }
  try {
    const child = spawn(shim(root), ["term", "apply", "--session", id], { detached: true, stdio: "ignore" })
    child.on("error", () => {})
    child.unref()
  } catch {}
}

export type Sys = {
  platform: NodeJS.Platform
  run: (s: Step) => { ok: boolean; out: string }
  writeTty: (p: string, data: string) => boolean
  term: (id: string) => Term | null
}

export const liveSys = (): Sys => ({
  platform: process.platform,
  run: (s) => {
    const r = spawnSync(s.cmd, s.args, { input: s.input, encoding: "utf8", timeout: 5000 })
    return { ok: r.status === 0, out: `${r.stdout ?? ""}${r.stderr ?? ""}`.trim() }
  },
  writeTty: (p, data) => {
    // One write() of the whole sequence, so it cannot be split by a redraw, and
    // never blocking: a tty nobody reads would otherwise hold the applier.
    let fd = -1
    try {
      fd = fs.openSync(p, fs.constants.O_WRONLY | fs.constants.O_NOCTTY | fs.constants.O_NONBLOCK)
      return fs.writeSync(fd, data) === Buffer.byteLength(data)
    } catch {
      return false
    } finally {
      if (fd >= 0) fs.closeSync(fd)
    }
  },
  term: (id) => R.readOne(id)?.terminal ?? null,
})

/** Show one state on one tab. */
export function applyOnce(id: string, state: TabState, f: TabFile | null, sys: Sys): { ok: boolean; appleOriginal?: string; restored?: boolean } {
  const t = sys.term(id)
  if (!t) return { ok: false }
  let ok = true
  let restored = false
  let appleOriginal = f?.appleOriginal
  for (const a of actionsFor(t, state, sys.platform)) {
    if (a.kind === "run") {
      const r = sys.run(a.step)
      if (!r.ok && !a.optional) ok = false
    } else if (a.kind === "tty") ok = sys.writeTty(a.path, a.data) && ok
    else {
      if (!appleTintOn()) {
        // Off: a tab crosstalk once tinted goes back to its profile's own
        // background. Never to a remembered colour: one read while the tab
        // was already tinted, or for a tty a new tab has taken since, paints.
        if (!appleOriginal) continue
        const back = sys.run({ cmd: "osascript", args: ["-"], input: appleProfileBgScript(a.tty) }).ok
        if (back) restored = true
        ok = back && ok
        continue
      }
      if (!appleOriginal && (state === "working" || state === "waiting" || state === "broken")) {
        const r = sys.run({ cmd: "osascript", args: ["-"], input: appleReadBgScript(a.tty) })
        if (r.ok && parseRgb16(r.out)) appleOriginal = r.out.trim()
      }
      const orig = appleOriginal ? parseRgb16(appleOriginal) : null
      if (!orig) continue // never seen its own colour: nothing safe to set or put back
      ok = sys.run({ cmd: "osascript", args: ["-"], input: appleSetBgScript(a.tty, appleTint(orig, state)) }).ok && ok
    }
  }
  if (restored) return { ok, restored }
  return { ok, appleOriginal }
}

/**
 * Terminal.app: the tab's own title, so the tab says what the session is
 * (`🟣 auth · auth-1`) instead of the command it was started with. Only the
 * title crosstalk sets is shown in it; whether Terminal also adds the running
 * command is the profile's own Tab setting. Never launches Terminal.
 */
export const appleTitleScript = (tty: string, title: string) =>
  appleTab(tty, [
    `set custom title of t to ${R.asq(title.replace(/[\u0000-\u001f\u007f-\u009f]/g, " ").slice(0, 120))}`,
    `set title displays custom title of t to true`,
    `set title displays device name of t to false`,
    `set title displays shell path of t to false`,
    `set title displays window size of t to false`,
    `set title displays file name of t to false`,
    `return "done"`,
  ])

/**
 * Name the session's Terminal.app tab, when the title changed since last
 * time: one detached osascript, so the hook never waits on Terminal.
 */
export function nameTab(sessionId: string, title: string, o: { platform?: NodeJS.Platform; spawnIt?: (input: string) => void } = {}): boolean {
  if ((o.platform ?? process.platform) !== "darwin" || process.env.CROSSTALK_NO_TERM) return false
  const t = R.readOne(sessionId)?.terminal
  if (!t?.tty || R.kindOf(t) !== "apple") return false
  const f = readTab(sessionId)
  if (f?.title === title) return false
  withFile(sessionId, (cur) => writeTab({ ...(cur ?? { sessionId, want: "off", wantAt: Date.now() }), title }))
  const input = appleTitleScript(t.tty, title)
  try {
    ;(o.spawnIt ?? ((inp: string) => {
      const c = spawn("osascript", ["-"], { detached: true, stdio: ["pipe", "ignore", "ignore"] })
      c.stdin?.end(inp)
      c.unref()
    }))(input)
  } catch {}
  return true
}

/** Terminal.app's background tint is opt-in: CROSSTALK_TAB_COLOUR=1. */
export const appleTintOn = (env: NodeJS.ProcessEnv = process.env) => /^(1|true|yes|on)$/i.test(env.CROSSTALK_TAB_COLOUR ?? env.CROSSTALK_TAB_COLOR ?? "")

/**
 * Terminal.app: the tab on this tty back to its profile's own background (the
 * saved profile of the same name). Never launches Terminal.
 */
export const appleProfileBgScript = (tty: string) =>
  appleTab(tty, [`set n to name of current settings of t`, `set background color of t to background color of settings set n`, `return "done"`])

/**
 * Terminal.app: every tab whose background is not its profile's goes back to
 * it. Returns how many changed. Never launches Terminal.
 */
export const appleProfileBgAllScript = [
  `if application "Terminal" is not running then return "0"`,
  `set c to 0`,
  `tell application "Terminal"`,
  `\trepeat with w in windows`,
  `\t\trepeat with t in tabs of w`,
  `\t\t\ttry`,
  `\t\t\t\tset want to background color of settings set (name of current settings of t)`,
  `\t\t\t\tif (background color of t) is not want then`,
  `\t\t\t\t\tset background color of t to want`,
  `\t\t\t\t\tset c to c + 1`,
  `\t\t\t\tend if`,
  `\t\t\tend try`,
  `\t\tend repeat`,
  `\tend repeat`,
  `end tell`,
  `return c as text`,
].join("\n")

/**
 * With tints off: every Terminal.app tab back to its profile's background, and
 * every remembered colour forgotten, so nothing is ever painted from one.
 */
export function resetColours(sys: Sys = liveSys()): { reset: number; ok: boolean } {
  let reset = 0
  let ok = true
  if (sys.platform === "darwin") {
    const r = sys.run({ cmd: "osascript", args: ["-"], input: appleProfileBgAllScript })
    ok = r.ok
    reset = r.ok ? Number(r.out.trim()) || 0 : 0
  }
  let names: string[] = []
  try {
    names = fs.readdirSync(dir()).filter((n) => n.endsWith(".json"))
  } catch {}
  for (const n of names) {
    const id = n.slice(0, -5)
    try {
      withFile(id, (cur) => {
        if (!cur?.appleOriginal) return
        const { appleOriginal: _, ...rest } = cur
        writeTab(rest)
      })
    } catch {}
  }
  return { reset, ok }
}

/**
 * The applier: one per session at a time. Applies the wanted state, waits out
 * the gap, and goes round again while the wanted state keeps changing.
 */
export async function applyLoop(id: string, sys: Sys = liveSys(), sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))): Promise<string> {
  const lock = `${fileOf(id)}.applier`
  const take = () => {
    try {
      fs.mkdirSync(dir(), { recursive: true, mode: 0o700 })
      fs.writeFileSync(lock, String(process.pid), { flag: "wx", mode: 0o600 })
      return true
    } catch {
      try {
        const other = Number(fs.readFileSync(lock, "utf8"))
        if (other && R.pidAlive(other) && other !== process.pid) return false
        fs.unlinkSync(lock)
        fs.writeFileSync(lock, String(process.pid), { flag: "wx", mode: 0o600 })
        return true
      } catch {
        return false
      }
    }
  }
  let last = "idle"
  for (let round = 0; round < 3; round++) {
    if (!take()) return "already applying"
    try {
      for (let i = 0; i < 200; i++) {
        const f = readTab(id)
        const d = decide(f, Date.now())
        if (d.act === "idle") break
        if (d.act === "wait") {
          await sleep(d.ms)
          continue
        }
        const state = f!.want
        const r = applyOnce(id, state, f, sys)
        last = `${state}${r.ok ? "" : " (partly)"}`
        withFile(id, (cur) => {
          if (!cur) return
          if (state === "off" && cur.want === "off") {
            try {
              fs.unlinkSync(fileOf(id))
            } catch {}
            return
          }
          const next: TabFile = { ...cur, applied: state, appliedAt: Date.now(), ...(r.appleOriginal ? { appleOriginal: r.appleOriginal } : {}) }
          if (r.restored) delete next.appleOriginal
          writeTab(next)
        })
      }
    } finally {
      try {
        if (Number(fs.readFileSync(lock, "utf8")) === process.pid) fs.unlinkSync(lock)
      } catch {}
    }
    // A want written between the last look and letting go would have found the
    // lock held and left: look once more.
    if (decide(readTab(id), Date.now(), 0).act === "idle") break
  }
  return last
}

// --- what the person adds to their own tmux ---------------------------------------

/**
 * The person's own tmux is never reconfigured. This is what to add to
 * ~/.tmux.conf to see the state in the window list; it appends to the format
 * they already have.
 */
export const TMUX_SNIPPET = [
  `# crosstalk: show each agent's state in the window list`,
  `set -ga window-status-format ' #{?#{==:#{@crosstalk_state},broken},#[fg=colour160]● broken#[default],#{?#{==:#{@crosstalk_state},waiting},#[fg=colour208]● waiting#[default],#{?#{==:#{@crosstalk_state},working},#[fg=colour33]● working#[default],#{?#{==:#{@crosstalk_state},done},#[fg=colour34]✓#[default],}}}}'`,
  `set -ga window-status-current-format ' #{?#{==:#{@crosstalk_state},broken},#[fg=colour160]● broken#[default],#{?#{==:#{@crosstalk_state},waiting},#[fg=colour208]● waiting#[default],#{?#{==:#{@crosstalk_state},working},#[fg=colour33]● working#[default],#{?#{==:#{@crosstalk_state},done},#[fg=colour34]✓#[default],}}}}'`,
].join("\n")

// --- the hook's part ------------------------------------------------------------

export function pendingFor(sessionId: string, snapshot: () => Record<string, { sessionId: string; state: string }>): number {
  try {
    return Object.values(snapshot()).filter((i) => i.sessionId === sessionId && !["answered", "handed", "muted"].includes(i.state)).length
  } catch {
    return 0
  }
}
