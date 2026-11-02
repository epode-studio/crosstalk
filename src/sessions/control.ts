// Wrangling sessions from any session: close, resume, rename, move, send to
// the background and bring back, on this machine. (Other machines: remote.ts.)
//
// Every action on another session is the person's own request. Where it ends
// or changes a session, it is put to them first:
//
//   with crosstalk's mod   a picker in the session that asked ("Close billing?
//                          Its dev server keeps running." Close / Cancel), and
//                          only their pick does it. The pick reaches
//                          `crosstalk ui act`, which runs it from the mod's own
//                          process (it is in the person's terminal), and which
//                          refuses an agent's shell pressing it for them.
//   without the mod        only when the person typed it in that same session:
//                          the last prompt they typed there (from Claude Code's
//                          transcript, never a message that arrived) names the
//                          session and says the action, in the last 15 minutes.
//                          Otherwise refused, and nothing happens.
//
// Ending a session is SIGTERM, then SIGINT, never SIGKILL, and only to the very
// process its record names (same pid, same start time, a claude or codex
// command line), the same checks gather makes (src/gather.ts endGracefully).
// Its record is marked archived first, so restore never takes it for a crash.
//
// Something the session started outside crosstalk that still runs (a dev
// server from a backgrounded Bash call, a watcher: src/services/postpone.ts)
// would die with it. Closing is the person's own explicit request, so the
// question says what it would interrupt ("It is still running npm run dev,
// which stops with it.") and a yes goes ahead. Sending one to the background
// waits instead, silently, in a detached waiter, until that has stopped.

import crypto from "node:crypto"
import fs from "node:fs"
import path from "node:path"
import { spawnSync } from "node:child_process"
import { P } from "../config.ts"
import * as R from "../restore.ts"
import type { Rec, Step, Term } from "../restore.ts"
import * as G from "../gather.ts"
import * as ui from "../uistate.ts"
import { request } from "../client.ts"
import { openForRepo, typedTab } from "../terminal/layout.ts"
import { slug } from "../terminal/repo.ts"
import * as spawn from "../spawn.ts"
import * as bgx from "../attention/background.ts"
import { refuseBot } from "../ui-extra/bots.ts"
import * as I from "./index.ts"
import * as T from "./transcripts.ts"
import * as N from "./names.ts"
import { keepsLine, runningFor, services } from "./services.ts"
import { spawn as spawnChild } from "node:child_process"
import { dirOf, shim } from "../paths.ts"
import * as PP from "../services/postpone.ts"
import type { Activity } from "../services/procs.ts"

export type Out = { ok: boolean; text: string; pending?: boolean; [k: string]: unknown }
type Ask = (req: Record<string, unknown>, timeoutMs?: number) => Promise<any>

/** Everything this module asks the machine, so the logic can be tested without one. */
export type Deps = {
  env: NodeJS.ProcessEnv
  ask: Ask
  sys: G.Sys
  /** A tab in the person's terminal, in its repository's window. */
  open: typeof openForRepo
  run: (s: Step) => { ok: boolean; out: string }
  which: (bin: string) => string | undefined
  modActive: (sessionId: string) => boolean
  now: () => number
}

export function liveDeps(env: NodeJS.ProcessEnv = process.env): Deps {
  return {
    env,
    ask: (req, ms) => request(req, ms ?? 4000),
    sys: G.liveSys(),
    open: openForRepo,
    run: (s) => {
      const r = spawnSync(s.cmd, s.args, { input: s.input, encoding: "utf8", timeout: 30_000, env: spawn.cleanEnv(env) })
      return { ok: r.status === 0, out: `${r.stdout ?? ""}${r.stderr ?? ""}${r.error ? String(r.error) : ""}`.trim() }
    },
    which: (bin) => which(bin, env),
    modActive: (sid) => ui.modActive(sid),
    now: Date.now,
  }
}

function which(bin: string, env: NodeJS.ProcessEnv): string | undefined {
  for (const d of (env.PATH ?? "").split(path.delimiter)) {
    if (!d) continue
    const p = path.join(d, bin)
    try {
      fs.accessSync(p, fs.constants.X_OK)
      return p
    } catch {}
  }
  return undefined
}

// --- which session --------------------------------------------------------------

export type Live = {
  id: string
  name: string
  cwd: string
  client: string
  pid: number
  pidStart?: string
  terminal: Term
  threads: string[]
  status?: string
}

/** In crosstalk's own background tmux (`tmux -L crosstalk`), and its tmux session there. */
export const backgroundOf = (l: { terminal: Term }): string | null =>
  l.terminal.tmux && path.basename(l.terminal.tmux.socket ?? "") === spawn.TMUX_SOCKET ? (l.terminal.tmux.session ?? null) : null

const label = (r: Rec) => N.nameOf(r.sessionId) ?? (r.name && !/^session-\d+$/.test(r.name) ? r.name : path.basename(r.cwd) || r.sessionId.slice(0, 8))

/** Every session open on this machine, named as the daemon names them when it is running. */
export async function liveSessions(d: Pick<Deps, "ask">, recs = R.readAll(), alive: (r: Rec) => boolean = R.recAlive): Promise<Live[]> {
  let byId = new Map<string, { name: string; threads: string[]; status?: string }>()
  try {
    const r = await d.ask({ op: "sessions" }, 3000)
    if (r?.ok) byId = new Map((r.sessions ?? []).map((s: any) => [s.id, { name: s.name, threads: s.threads ?? [], status: s.status }]))
  } catch {}
  return recs
    .filter((r) => !r.endedAt && r.interactive !== false && alive(r))
    .sort((a, b) => a.startedAt - b.startedAt)
    .map((r) => {
      const k = byId.get(r.sessionId)
      return {
        id: r.sessionId,
        name: N.nameOf(r.sessionId) ?? (k?.name && !/^session-\d+$/.test(k.name) ? k.name : label(r)),
        cwd: r.cwd,
        client: r.client,
        pid: r.pid,
        pidStart: r.pidStart,
        terminal: r.terminal,
        threads: k?.threads ?? (r.thread ? [r.thread] : []),
        ...(k?.status ? { status: k.status } : {}),
      }
    })
}

/** A session by id, id prefix, name, or a thread only it is in. */
export function resolve(ref: string, lives: Live[]): { ok: true; live: Live } | { ok: false; text: string } {
  const want = String(ref ?? "").trim()
  if (!want) return { ok: false, text: "◢ crosstalk: say which session." }
  const lc = want.toLowerCase()
  const exact =
    lives.find((l) => l.id === want) ??
    (want.length >= 6 ? lives.find((l) => l.id.startsWith(want)) : undefined) ??
    lives.find((l) => l.name.toLowerCase() === lc)
  if (exact) return { ok: true, live: exact }
  const inThread = lives.filter((l) => l.threads.some((t) => t.toLowerCase() === lc))
  if (inThread.length === 1) return { ok: true, live: inThread[0] }
  if (inThread.length > 1) return { ok: false, text: `◢ crosstalk: more than one session is in ${want}: ${inThread.map((l) => l.name).join(", ")}. Name one.` }
  const part = lives.filter((l) => l.name.toLowerCase().startsWith(lc))
  if (part.length === 1) return { ok: true, live: part[0] }
  return { ok: false, text: `◢ crosstalk: no open session called "${want}".${lives.length ? ` Open: ${lives.map((l) => l.name).join(", ")}.` : ""}` }
}

/** Whether a command line is the client the record says it is. */
export function isClientArgs(args: string | null | undefined, client: string): boolean {
  if (client === "claude") return G.isClaudeArgs(args)
  if (client === "codex") {
    const parts = (args ?? "").trim().split(/\s+/)
    return parts.slice(0, 3).some((p) => path.basename(p) === "codex")
  }
  return false
}

// --- the person's yes -------------------------------------------------------------

export type Action =
  | { kind: "close"; session: string; services: "keep" | "stop" }
  | { kind: "background"; session: string }
  | { kind: "rename"; session: string; name: string }
  | { kind: "move"; session: string; thread: string }
  | { kind: "remote"; machine: string; req: RemoteAct }
  // Asked from another of your machines, put to you on this one (remote.ts):
  | { kind: "resume"; session: string }
  | { kind: "spawn"; task: string; name?: string; cwd: string; count?: number }

/** An action asked of another of your machines (remote.ts carries it). */
export type RemoteAct =
  | { kind: "close"; session: string; services?: "keep" | "stop" }
  | { kind: "background"; session: string }
  | { kind: "resume"; session: string }
  | { kind: "spawn"; task: string; name?: string; repo?: string; count?: number }

export const YES: Record<Action["kind"], string> = { close: "Close", background: "Send it", rename: "Rename", move: "Move", remote: "Do it", resume: "Resume it", spawn: "Start it" }
export const NO = "Cancel"

const VERBS: Record<Action["kind"] | RemoteAct["kind"], RegExp> = {
  close: /\b(close|stop|end|quit|exit|kill|archive|shut)\b/i,
  background: /\b(background|bg|behind)\b/i,
  rename: /\b(rename|name|call)\b/i,
  move: /\b(move|put|switch|belongs?)\b/i,
  resume: /\b(resume|reopen|open|bring|continue)\b/i,
  spawn: /\b(start|spawn|put|get|run|spin|agent)\b/i,
  remote: /./,
}

/** What the person is asked, in words. */
/** " It is still running npm run dev, which stops with it." for what a session started outside crosstalk. */
export function interruptsLine(busy: Activity[]): string {
  if (!busy.length) return ""
  return ` It is still running ${PP.what(busy).replace(/[\u0000-\u001f\u007f-\u009f]/g, " ")}, which ${busy.length === 1 ? "stops" : "stop"} with it.`
}

export function questionFor(a: Action, target?: Live, svc: { name: string }[] = [], busy: Activity[] = []): string {
  const n = target?.name ?? ("session" in a ? a.session : "")
  if (a.kind === "resume") return `Resume ${n}?`
  if (a.kind === "spawn") return `Start ${a.count && a.count > 1 ? `${a.count} agents` : "an agent"} in ${path.basename(a.cwd)}: "${a.task.length > 120 ? a.task.slice(0, 119) + "…" : a.task}"?`
  switch (a.kind) {
    case "close":
      return `Close ${n}?${keepsLine(svc, a.services === "stop")}${interruptsLine(busy)}`
    case "background":
      return `Send ${n} to the background? It ends here and carries on in crosstalk's background tmux, conversation and all.`
    case "rename":
      return `Rename ${n} to ${a.name}?`
    case "move":
      return `Move ${n} to the thread ${a.thread}?`
    case "remote":
      return `On ${a.machine}: ${describeRemote(a.req)}?`
  }
}

export function describeRemote(r: RemoteAct): string {
  switch (r.kind) {
    case "close":
      return `close ${r.session}`
    case "background":
      return `send ${r.session} to the background`
    case "resume":
      return `resume ${r.session}`
    case "spawn":
      return `start ${r.count && r.count > 1 ? `${r.count} agents` : "an agent"}${r.repo ? ` in ${r.repo}` : ""}: "${r.task.length > 120 ? r.task.slice(0, 119) + "…" : r.task}"`
  }
}

const has = (text: string, word: string) => {
  const w = word.trim().toLowerCase()
  if (!w) return false
  const esc = w.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
  return new RegExp(`(^|[^\\p{L}\\p{N}])${esc}($|[^\\p{L}\\p{N}])`, "iu").test(text)
}

/**
 * Whether the person's own last prompt asked for this: it names the session
 * (or the machine, or the new name or thread where those are the point) and
 * says the action, and was typed within `withinMs`.
 */
export function typedAsks(prompt: { text: string; at: number } | null, a: Action, target: Live | undefined, now: number, withinMs = typedWindow(), self = false): boolean {
  if (!prompt || now - prompt.at > withinMs || prompt.at - now > 60_000) return false
  const t = prompt.text
  const verb = a.kind === "remote" ? VERBS[a.req.kind] : VERBS[a.kind]
  if (!verb.test(t)) return false
  const names = target ? [target.name, ...target.threads, target.id.slice(0, 8)] : "session" in a ? [a.session] : []
  if (a.kind === "remote") {
    if (!has(t, a.machine)) return false
    if (a.req.kind !== "spawn" && !has(t, a.req.session)) return false
    return true
  }
  // About this very session ("move this to auth"), the session needs no naming.
  if (!self && !names.some((n) => has(t, n))) return false
  if (a.kind === "rename" && !has(t, a.name)) return false
  if (a.kind === "move" && !has(t, a.thread)) return false
  return true
}

const typedWindow = () => Number(process.env.CROSSTALK_TYPED_WINDOW_MS ?? 15 * 60_000)

export const sessId = () => `sess:${crypto.randomBytes(6).toString("hex")}`
const pendingDir = () => path.join(P.root, "sessions", "pending")
const pendingFile = (id: string) => path.join(pendingDir(), `${id.replace(/[^A-Za-z0-9._-]/g, "_")}.json`)

export type Pending = { id: string; by: string; cwd: string; action: Action; at: number; yes: string; from?: string }

export function writePending(p: Pending) {
  fs.mkdirSync(pendingDir(), { recursive: true, mode: 0o700 })
  fs.writeFileSync(pendingFile(p.id), JSON.stringify(p), { mode: 0o600 })
}
export function takePending(id: string): Pending | null {
  const f = pendingFile(id)
  const mine = `${f}.${process.pid}`
  try {
    fs.renameSync(f, mine)
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
export function peekPending(id: string): Pending | null {
  try {
    return JSON.parse(fs.readFileSync(pendingFile(id), "utf8"))
  } catch {
    return null
  }
}

/** Put a question to the person in a session's mod: the picker, and what a yes does. */
export function raise(o: { by: string; cwd: string; action: Action; question: string; from?: string }, now = Date.now()): string {
  const id = sessId()
  const yes = YES[o.action.kind]
  writePending({ id, by: o.by, cwd: o.cwd, action: o.action, at: now, yes, ...(o.from ? { from: o.from } : {}) })
  ui.withStore((items, t) => ui.upsert(items, { id, kind: "session", sessionId: o.by, question: o.question, options: [yes, NO], ...(o.from ? { from: o.from } : {}), ts: now }, t))
  return id
}

/**
 * The gate every action that ends or changes a session goes through: a
 * picker with the mod, the person's own typed words without it, else nothing.
 */
export async function gate(o: { by: string; cwd: string; action: Action; target?: Live }, d: Deps): Promise<Out> {
  if (!o.by) return { ok: false, text: "◢ crosstalk: this comes only from one of your own sessions." }
  const svc = o.action.kind === "close" && o.target ? runningFor({ sessionId: o.target.id, cwd: o.target.cwd }) : []
  // What closing it would interrupt, said in the question: the person decides.
  const busy = o.action.kind === "close" && o.target ? activityOf(o.target, d) : []
  const q = questionFor(o.action, o.target, svc, busy)
  if (d.modActive(o.by)) {
    raise({ by: o.by, cwd: o.cwd, action: o.action, question: q })
    return { ok: true, pending: true, text: `Asked your user to confirm in this session: "${q}" Nothing happens unless they pick "${YES[o.action.kind]}".` }
  }
  const prompt = T.lastPrompt(T.transcriptOf(o.by, o.cwd, d.env))
  if (typedAsks(prompt, o.action, o.target, d.now(), typedWindow(), o.target?.id === o.by)) return perform(o.action, o.by, d)
  return {
    ok: false,
    text: `◢ crosstalk: "${q.replace(/\?$/, "")}" needs your user's own say-so. This session has no crosstalk mod to ask them with, and their last message here did not ask for it. Nothing was done; if they want it, they can say it here in their own words.`,
  }
}

/** The person's pick on the picker (`crosstalk ui act`). Only the session that asked, and only its yes, does anything. */
export async function act(session: string, id: string, action: string, value: string | undefined, d: Deps = liveDeps()): Promise<Out & { item?: ui.UiItem }> {
  if (action === "raised" || action === "later") {
    const r = ui.withStore((items, now) => ui.act(items, id, action, now))
    return { ...r, text: "" }
  }
  const p = peekPending(id)
  const v = (value ?? "").trim()
  const claim = ui.withStore((items, now) => ui.act(items, id, "answer", now, v || NO))
  if (!claim.ok) return { ok: false, text: claim.error, item: claim.item }
  const mine = takePending(id)
  if (!p || !mine || mine.by !== session) return { ok: false, text: "That is no longer waiting; nothing was done.", item: claim.item }
  if (action !== "answer" || v !== mine.yes) return { ok: true, text: "Left as it was.", item: claim.item }
  // A remote request carries the asking machine's label, for the bot check and the digest.
  const out = await perform(mine.action, mine.by, d, mine.from)
  return { ...out, item: claim.item }
}

// --- doing it ------------------------------------------------------------------------

/** Run an action the person has said yes to (or typed). */
export async function perform(a: Action, by: string, d: Deps, from?: string): Promise<Out> {
  if (a.kind === "remote") {
    try {
      const r = await d.ask({ op: "sessions_remote", sessionId: by, machine: a.machine, req: { op: "act", act: a.req } }, 45_000)
      return { ok: !!r?.ok, text: r?.text ?? r?.error ?? "no answer" }
    } catch (e) {
      return { ok: false, text: `◢ crosstalk: cannot reach the daemon: ${(e as Error).message}` }
    }
  }
  if (a.kind === "resume") return resume(a.session, { by, cwd: P.root, from }, d)
  if (a.kind === "spawn") {
    const bot = refuseBot(from, "start an agent on this machine")
    if (bot) return { ok: false, text: `◢ crosstalk: ${bot}` }
    return spawn.spawnAgents({ task: a.task, name: a.name, count: a.count, cwd: a.cwd, by, env: d.env, peer: from })
  }
  const lives = await liveSessions(d)
  const t = resolve(a.session, lives)
  if (!t.ok) return t
  switch (a.kind) {
    case "close":
      return close(t.live, { by, services: a.services }, d, from)
    case "background":
      return toBackground(t.live, { by }, d, from)
    case "rename":
      return rename(t.live, a.name, d)
    case "move":
      return move(t.live, a.thread, d)
  }
}

/** The process is the one its record names, and running the client it says. */
function verified(l: Live, d: Deps): string | null {
  const st = d.sys.state ? d.sys.state(l.pid, l.pidStart) : R.pidState(l.pid, l.pidStart)
  if (st === "gone") return `${l.name} has already ended.`
  if (st !== "same") return `cannot tell that process ${l.pid} is still ${l.name}, so nothing was sent to it.`
  if (!isClientArgs(d.sys.ps(l.pid, "args"), l.client)) return `process ${l.pid} is not ${l.client}, so nothing was sent to it.`
  return null
}

export async function close(l: Live, o: { by?: string; services?: "keep" | "stop" }, d: Deps, from?: string): Promise<Out> {
  const bot = refuseBot(from, "end a session on this machine")
  if (bot) return { ok: false, text: `◢ crosstalk: ${bot}` }
  if (l.id === o.by) return { ok: false, text: "◢ crosstalk: that is this session. To end it, type /exit here." }
  const bad = verified(l, d)
  if (bad) return { ok: false, text: `◢ crosstalk: ${bad}` }
  const svc = runningFor({ sessionId: l.id, cwd: l.cwd })
  const busy = activityOf(l, d)
  const rec = R.readOne(l.id)
  const now = d.now()
  // Marked first: its exit, and its SessionEnd hook, are on purpose.
  if (rec) R.writeRec({ ...rec, archived: now })
  if (!(await G.endGracefully(l.pid, l.pidStart, d.sys))) {
    if (rec) R.writeRec(rec)
    return { ok: false, text: `◢ crosstalk: ${l.name} did not exit. It was asked to (SIGTERM, then SIGINT twice) and left running; nothing stronger is ever sent.` }
  }
  const after = R.readOne(l.id) ?? rec
  if (after) R.writeRec({ ...after, archived: now, endedAt: after.endedAt ?? now, endReason: after.endReason ?? "archived" })
  let stopped: string[] = []
  if (o.services === "stop" && svc.length)
    try {
      stopped = await services().stop({ sessionId: l.id, cwd: l.cwd })
    } catch {}
  try {
    I.sweep()
    I.mark(l.id, { archived: now })
  } catch {}
  const svcLine = o.services === "stop" ? (stopped.length ? ` Stopped ${stopped.join(", ")}.` : "") : keepsLine(svc, false)
  const cut = busy.length ? ` What it was still running stopped with it (${PP.what(busy).replace(/[\u0000-\u001f\u007f-\u009f]/g, " ")}).` : ""
  return { ok: true, text: `◢ crosstalk: closed ${l.name}.${svcLine}${cut} It is archived, not lost: say "resume ${l.name}" to bring it back.`, closed: l.id }
}

/** A tmux session name in crosstalk's server that nobody has. */
export function freeTmuxName(base: string, has: (n: string) => boolean): string {
  const b = slug(base, 24) || "session"
  for (let i = 1; ; i++) {
    const n = i === 1 ? b : `${b}-${i}`
    if (!has(n)) return n
  }
}

/** The tmux step that runs `argv` in crosstalk's own background server, marked as a background agent. */
export function backgroundStep(o: { name: string; cwd: string; argv: string[] }): Step {
  return { cmd: "tmux", args: ["-L", spawn.TMUX_SOCKET, "-f", spawn.tmuxConf(), "new-session", "-d", "-s", o.name, "-c", o.cwd, bgx.tmuxArgv(o.argv, o.name).map(R.shq).join(" ")] }
}

const tmuxHas = (d: Deps) => (n: string) => d.run({ cmd: "tmux", args: ["-L", spawn.TMUX_SOCKET, "has-session", "-t", `=${n}`] }).ok

/** End a tab's session and carry it on in crosstalk's background tmux, conversation and all. Its services are left alone. */
export async function toBackground(l: Live, o: { by?: string }, d: Deps, from?: string): Promise<Out> {
  const bot = refuseBot(from, "move a session on this machine")
  if (bot) return { ok: false, text: `◢ crosstalk: ${bot}` }
  if (l.id === o.by) return { ok: false, text: "◢ crosstalk: that is this session; it cannot send itself away mid-turn. Ask from another session." }
  const bg = backgroundOf(l)
  if (bg) return { ok: true, text: `◢ crosstalk: ${l.name} already runs in the background (${bg}). Say "show me ${bg}" to watch it.` }
  const argv = R.resumeArgv({ client: l.client, sessionId: l.id } as Rec, d.which(l.client))
  if (!argv) return { ok: false, text: `◢ crosstalk: ${l.client} cannot resume a session, so ${l.name} cannot move to the background.` }
  if (!d.which("tmux")) return { ok: false, text: "◢ crosstalk: the background runs in tmux, which is not installed here." }
  const bad = verified(l, d)
  if (bad) return { ok: false, text: `◢ crosstalk: ${bad}` }
  // Something it started still runs: ending it now would end that too, so it
  // moves once that has stopped, by a detached waiter, without asking again.
  const busy = activityOf(l, d)
  if (busy.length) return waitThenBackground(l, o.by ?? "", d)
  const name = freeTmuxName(l.name, tmuxHas(d))
  const rec = R.readOne(l.id)
  if (rec) R.writeRec({ ...rec, archived: d.now() })
  if (!(await G.endGracefully(l.pid, l.pidStart, d.sys))) {
    if (rec) R.writeRec(rec)
    return { ok: false, text: `◢ crosstalk: ${l.name} did not exit, so it stays in its tab.` }
  }
  spawn.ensureConf()
  const r = d.run(backgroundStep({ name, cwd: l.cwd, argv }))
  if (!r.ok) {
    if (rec) R.writeRec({ ...rec, archived: undefined, endedAt: d.now(), endReason: "other" })
    return { ok: false, text: `◢ crosstalk: ${l.name} ended, but could not start in the background: ${r.out.split("\n").pop()}. Resume it with:\n  ${R.typed({ ...(rec ?? ({} as Rec)), sessionId: l.id, cwd: l.cwd, client: l.client })}` }
  }
  return { ok: true, text: `◢ crosstalk: ${l.name} carries on in the background as ${name}, with its whole conversation. Its tab is free. Say "show me ${name}" to bring it into a tab.`, tmux: name }
}

/** What the session started outside crosstalk that still runs (src/services/postpone.ts); none where the system cannot say. */
function activityOf(l: Live, d: Deps): Activity[] {
  try {
    return d.sys.activity?.(l.pid) ?? []
  } catch {
    return []
  }
}

/** The plugin root, from src/sessions/ or from dist/: the folder holding bin/crosstalk. */
function pluginRoot(): string {
  let dir = dirOf(import.meta.url)
  for (let i = 0; i < 4; i++) {
    if (fs.existsSync(shim(dir))) return dir
    dir = path.dirname(dir)
  }
  return path.join(dirOf(import.meta.url), "..")
}

const LATER_MS = 10 * 60_000

/** The waiter is crosstalk's own, carrying on a yes already given: not an agent's shell. */
const waiterEnv = (env: NodeJS.ProcessEnv) => {
  const e = { ...env }
  delete e.CLAUDECODE
  delete e.CODEX_SANDBOX
  delete e.CROSSTALK_AS_AGENT
  return e
}

/**
 * The person said send it to the background, and it is still running
 * something it started: a pending record of that yes, and a detached waiter
 * (`crosstalk ui bg-later`) that takes it and moves the session once nothing
 * it started still runs, for at most PP.UNTIL_MS.
 */
export function waitThenBackground(l: Live, by: string, d: Deps): Out {
  const id = `bglater:${crypto.randomBytes(6).toString("hex")}`
  writePending({ id, by, cwd: l.cwd, action: { kind: "background", session: l.id }, at: d.now(), yes: "later" })
  if (!d.env.CROSSTALK_NO_WAITER)
    try {
      const child = spawnChild(shim(pluginRoot()), ["ui", "bg-later", "--session", by, "--id", id], { detached: true, stdio: "ignore", env: waiterEnv(d.env) })
      child.on("error", () => {})
      child.unref()
    } catch {}
  return { ok: true, pending: true, waiting: id, text: `◢ crosstalk: ${l.name} is still running something it started, so it moves to the background once that has stopped; nothing is ended under it.` }
}

/** The waiter: takes the pending yes (once, while fresh), then moves the session as soon as it is free. */
export async function backgroundLater(by: string, id: string, d: Deps = liveDeps(), sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))): Promise<Out> {
  if (!id.startsWith("bglater:")) return { ok: false, text: "not a waiting move" }
  const p = takePending(id)
  if (!p || p.by !== by || p.action.kind !== "background" || d.now() - p.at > LATER_MS) return { ok: false, text: "That is no longer waiting; nothing was done." }
  const session = p.action.session
  const until = d.now() + PP.UNTIL_MS()
  for (;;) {
    const t = resolve(session, await liveSessions(d, R.readAll(), (r) => d.sys.alive(r.pid, r.pidStart)))
    if (!t.ok) return t
    if (!activityOf(t.live, d).length) return toBackground(t.live, { by }, d)
    if (d.now() > until) return { ok: false, text: `◢ crosstalk: ${t.live.name} stayed in its tab: what it started never stopped.` }
    await sleep(PP.POLL_MS())
  }
}

/** "pop auth out": a tab of the person's terminal, attached to a background agent. */
export function popout(o: { name: string; cwd: string; by?: string; env?: NodeJS.ProcessEnv }): Out {
  return spawn.show({ name: o.name, cwd: o.cwd, by: o.by, env: o.env })
}

export async function rename(l: Live, name: string, d: Deps): Promise<Out> {
  const n = N.clean(name)
  if (!n) return { ok: false, text: "◢ crosstalk: say what to call it." }
  N.setName(l.id, n)
  const rec = R.readOne(l.id)
  if (rec) R.writeRec({ ...rec, name: n })
  let threads = ""
  try {
    const r = await d.ask({ op: "session_rename", sessionId: l.id, name: n }, 4000)
    if (r?.ok && r.threads?.length) threads = ` Its entry in ${r.threads.join(", ")} says so too.`
  } catch {}
  return { ok: true, text: `◢ crosstalk: ${l.name} is called ${n} now; its tab title follows on its next turn.${threads}` }
}

export async function move(l: Live, thread: string, d: Deps): Promise<Out> {
  const t = String(thread ?? "").trim()
  if (!t) return { ok: false, text: "◢ crosstalk: say which thread." }
  try {
    const r = await d.ask({ op: "session_move", sessionId: l.id, thread: t }, 6000)
    if (!r?.ok) return { ok: false, text: `◢ crosstalk: ${r?.error ?? "could not move it"}` }
    return { ok: true, text: `◢ crosstalk: ${l.name} is in ${(r.threads ?? [t]).join(", ")} now, by your choice; its files will not move it back.`, threads: r.threads }
  } catch {
    return { ok: false, text: "◢ crosstalk: threads live in the daemon, which is not running." }
  }
}

/** Reopen a past session: a tab in the person's terminal, in its repository's window, beside its thread. Or the background. */
export async function resume(ref: string, o: { by?: string; cwd: string; background?: boolean; from?: string }, d: Deps): Promise<Out> {
  const bot = refuseBot(o.from, "resume a session on this machine")
  if (bot) return { ok: false, text: `◢ crosstalk: ${bot}` }
  const live = I.liveIds()
  const entries = I.all({ env: d.env, live })
  let p = I.lookup(ref, entries)
  if (!p) {
    const hits = I.find(ref, entries)
    if (hits.length === 1 || (hits.length > 1 && hits[0].score > hits[1].score * 1.5)) p = hits[0].past
    else if (hits.length) return { ok: false, text: `${I.describeHits(hits)}\nWhich one? Say its id.` }
  }
  if (!p) {
    const open = (await liveSessions(d)).find((l) => l.id === ref || l.name.toLowerCase() === ref.toLowerCase())
    if (open || live.has(ref)) return { ok: true, text: `◢ crosstalk: ${open?.name ?? ref} is open already. Say "show me ${open?.name ?? ref}" to bring it to the front.` }
    return { ok: false, text: `◢ crosstalk: no past session matches "${ref}".` }
  }
  const argv = R.resumeArgv({ client: p.client, sessionId: p.id } as Rec, d.which(p.client))
  if (!argv) return { ok: false, text: `◢ crosstalk: ${p.client} sessions cannot be resumed.` }
  const name = p.title || path.basename(p.cwd)
  if (o.background) {
    if (!d.which("tmux")) return { ok: false, text: "◢ crosstalk: the background runs in tmux, which is not installed here." }
    spawn.ensureConf()
    const tn = freeTmuxName(name, tmuxHas(d))
    const r = d.run(backgroundStep({ name: tn, cwd: p.cwd, argv }))
    if (!r.ok) return { ok: false, text: `◢ crosstalk: could not resume ${name} in the background: ${r.out.split("\n").pop()}` }
    I.mark(p.id, { resumedAt: d.now(), archived: undefined })
    return { ok: true, text: `◢ crosstalk: resumed ${name} in the background as ${tn}, with its whole conversation. Say "show me ${tn}" to watch it.`, tmux: tn, resumed: p.id }
  }
  const tab = { cwd: p.cwd, argv, name, ...(p.threads[0] ? { thread: p.threads[0] } : {}) }
  const r = d.open([tab], { cwd: p.cwd, envVars: d.env, by: o.by, thread: p.threads[0] })
  if (r.opened.kind === "manual") return { ok: true, text: `◢ crosstalk: this terminal cannot open a tab from outside. To resume ${name}, run:\n  ${typedTab(tab)}`, resumed: p.id }
  if (!r.ok) return { ok: false, text: `◢ crosstalk: could not open a tab for ${name}: ${r.out.split("\n").pop()}. To resume it yourself:\n  ${typedTab(tab)}` }
  I.mark(p.id, { resumedAt: d.now(), archived: undefined })
  return { ok: true, text: `◢ crosstalk: resumed ${name} in a new tab in ${r.opened.where}, with its whole conversation.`, resumed: p.id }
}
