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
//   Terminal.app      the tab's background colour through AppleScript, on the
//                     tab whose tty is the session's, tinted from the original,
//                     which is put back when the session is done or ends
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

export type TabState = "working" | "waiting" | "done" | "off"

/** What a terminal draws for each state, as 8-bit RGB. */
export const COLOUR: Record<Exclude<TabState, "off">, [number, number, number]> = {
  working: [47, 111, 214],
  waiting: [229, 140, 10],
  done: [46, 160, 67],
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

/** OSC 9;4: 3 is indeterminate (working), 4 paused (waiting), 0 clears. */
export function progressSequence(state: TabState): string {
  if (state === "working") return `\x1b]9;4;3${ST}`
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
    if (f && f.want === o.state) return f.applied !== o.state && now - f.wantAt > 5000
    writeTab({ ...(f ?? { sessionId: o.sessionId }), sessionId: o.sessionId, want: o.state, wantAt: now })
    return true
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
export function applyOnce(id: string, state: TabState, f: TabFile | null, sys: Sys): { ok: boolean; appleOriginal?: string } {
  const t = sys.term(id)
  if (!t) return { ok: false }
  let ok = true
  let appleOriginal = f?.appleOriginal
  for (const a of actionsFor(t, state, sys.platform)) {
    if (a.kind === "run") {
      const r = sys.run(a.step)
      if (!r.ok && !a.optional) ok = false
    } else if (a.kind === "tty") ok = sys.writeTty(a.path, a.data) && ok
    else {
      if (!appleOriginal && (state === "working" || state === "waiting")) {
        const r = sys.run({ cmd: "osascript", args: ["-"], input: appleReadBgScript(a.tty) })
        if (r.ok && parseRgb16(r.out)) appleOriginal = r.out.trim()
      }
      const orig = appleOriginal ? parseRgb16(appleOriginal) : null
      if (!orig) continue // never seen its own colour: nothing safe to set or put back
      ok = sys.run({ cmd: "osascript", args: ["-"], input: appleSetBgScript(a.tty, appleTint(orig, state)) }).ok && ok
    }
  }
  return { ok, appleOriginal }
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
          writeTab({ ...cur, applied: state, appliedAt: Date.now(), ...(r.appleOriginal ? { appleOriginal: r.appleOriginal } : {}) })
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
  `set -ga window-status-format ' #{?#{==:#{@crosstalk_state},waiting},#[fg=colour208]● waiting#[default],#{?#{==:#{@crosstalk_state},working},#[fg=colour33]● working#[default],#{?#{==:#{@crosstalk_state},done},#[fg=colour34]✓#[default],}}}'`,
  `set -ga window-status-current-format ' #{?#{==:#{@crosstalk_state},waiting},#[fg=colour208]● waiting#[default],#{?#{==:#{@crosstalk_state},working},#[fg=colour33]● working#[default],#{?#{==:#{@crosstalk_state},done},#[fg=colour34]✓#[default],}}}'`,
].join("\n")

// --- the hook's part ------------------------------------------------------------

export function pendingFor(sessionId: string, snapshot: () => Record<string, { sessionId: string; state: string }>): number {
  try {
    return Object.values(snapshot()).filter((i) => i.sessionId === sessionId && !["answered", "handed", "muted"].includes(i.state)).length
  } catch {
    return 0
  }
}
