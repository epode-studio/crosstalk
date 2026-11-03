// Sessions and attention, in the daemon.
//
// docs/design/next-generation.md: "Questions", "Getting someone on it", "The
// terminal" and "Wrangling every session". One service, handed what it needs
// from the daemon through Deps, so daemon.ts keeps a few call sites:
//
//   recaps         a session's last turns as the tiebreaker when its files
//                  place it ambiguously, and as an empty thread's recap
//                  (recap.ts; ThreadService calls tiebreak())
//   disposable     context nearly spent (the mod's reading, or the
//                  transcript's), or a PreCompact: "start fresh from the
//                  thread instead of compacting?", or done at once when a
//                  standing rule says so (dispose.ts)
//   staffing       a thread stuck for two hours: "add a second agent?"
//                  (staffing.ts), yes starts one through src/spawn.ts
//   focus          which session is in front (focus.ts), polled; questions for
//                  "the session you are in" go there when there is no main
//   notifications  a blocking question and the person looking elsewhere: a
//                  desktop notification whose click focuses the asker, and a
//                  receipt naming it (notify.ts)
//   phone          away and blocking: ntfy with a sealed line, and Claude's own
//                  push through the mod
//   permissions    a background agent's PermissionRequest, held open until the
//                  person answers it as a question (permission.ts)
//
// Every question is a UiItem of kind "attention" (src/uistate.ts), id
// `attn:<what>:<key>`, shown by crosstalk's mod in the session the person is
// in, and answered through ui_act → act(). Without the mod it is a
// systemMessage line, answered with crosstalk_answer action "attention".

import fs from "node:fs"
import path from "node:path"
import { spawnSync } from "node:child_process"
import * as ui from "../uistate.ts"
import * as R from "../restore.ts"
import type { Rec } from "../restore.ts"
import * as M from "../threads/model.ts"
import type { ThreadService } from "../threads/service.ts"
import * as Rc from "./recap.ts"
import * as Cx from "./context.ts"
import * as F from "./focus.ts"
import * as A from "./activity.ts"
import * as N from "./notify.ts"
import * as D from "./dispose.ts"
import * as St from "./staffing.ts"
import * as Pm from "./permission.ts"
import { BG_ENV } from "./background.ts"
import * as PP from "../services/postpone.ts"

export type Reg = { sessionId: string; name: string; cwd: string; transcript?: string; pid?: number; seenAt?: number }

export type Deps = {
  threads: ThreadService
  log: (...a: unknown[]) => void
  file: string
  /** The plugin root, for the notification's click. */
  root: string
  sessions: () => Map<string, Reg>
  status: (sessionId: string) => string
  mainId: () => string | undefined
  modLive: (sessionId: string) => boolean
  /** Repo-relative path → when this session last touched it. */
  touched: (sessionId: string) => Record<string, number> | undefined
  repoOf: (sessionId: string) => string | undefined
  spawn: (o: { task: string; name: string; cwd: string; by?: string; background: boolean; thread?: { id: string; name: string } }) => { ok: boolean; text: string; agents: { name: string }[] }
  /** Sessions crosstalk runs in the background: never where a question is put. */
  background: (sessionId: string) => string | undefined
  restart?: (o: { rec: Rec; cmd: string }) => Promise<{ ok: boolean; text: string; wait?: boolean }>
  /**
   * Whether something the session started still runs (src/services/postpone.ts).
   * Default: the live look, unless `restart` is a stand-in (a test's), when it is never.
   */
  busy?: (rec: Rec) => boolean
  focusSys?: F.Sys
  readRecs?: () => Rec[]
  recAlive?: (r: Rec) => boolean
  lastCommitAt?: (cwd: string) => number | undefined
  desktop?: (d: N.Desktop) => void
  fetcher?: typeof fetch
  env?: NodeJS.ProcessEnv
  now?: () => number
}

type Note = { id: string; text: string }

type State = {
  v: 1
  recaps: Record<string, { text: string; at: number; model?: boolean }>
  /** Thread recaps this service wrote, so a person's or an agent's is never overwritten. */
  autoRecap: Record<string, string>
  context: Record<string, Cx.Usage>
  disposeAsked: Record<string, number>
  disposed: { sessionId: string; name: string; cwd: string; threads: string[]; at: number; successor?: string }[]
  stuck: Record<string, { askedAt: number; since: number }>
  working: Record<string, number>
  alerted: Record<string, number>
  focus: { sessionId?: string; how?: string; changedAt: number }
  notes: Record<string, Note[]>
  pushes: Record<string, Note[]>
  /** Questions put without the mod, each shown once as a systemMessage. */
  told: Record<string, number>
  /** Sessions whose own hook said they are a background agent (CROSSTALK_BG_AGENT). */
  bg: Record<string, string>
  /**
   * The standing rule about disposal: this person's, on this machine, like
   * the disk rule. It ends their sessions, so a rule in the repo's shared
   * RULES.md (a teammate's) never decides it.
   */
  disposeRule?: typeof START_FRESH
  /** How many times "Start fresh" was answered, for offering the rule. */
  disposeFresh?: number
  disposeRuleOffered?: boolean
}

const empty = (now: number): State => ({
  v: 1,
  recaps: {},
  autoRecap: {},
  context: {},
  disposeAsked: {},
  disposed: [],
  stuck: {},
  working: {},
  alerted: {},
  focus: { changedAt: now },
  notes: {},
  pushes: {},
  told: {},
  bg: {},
})

export const START_FRESH = "Start fresh"
export const COMPACT = "Compact as usual"
export const ALWAYS_FRESH = "Always start fresh"
export const NOT_NOW = "Not now"
export const DISPOSE_RULE_QUESTION = "That is twice you started a session fresh. Start sessions fresh from their thread by themselves from now on, whenever their context is spent?"

type What = "dispose" | "staff" | "perm" | "rule"
export const itemId = (what: What, key: string) => `attn:${what}:${key}`
const parseId = (id: string) => {
  const m = /^attn:(dispose|staff|perm|rule):(.+)$/.exec(id)
  return m ? { what: m[1] as What, key: m[2] } : null
}

type Pending = { resolve: (d: Pm.Decision | null) => void; timer: ReturnType<typeof setTimeout>; suggestions?: unknown; sessionId: string }

export class AttentionService {
  private st: State
  private pending = new Map<string, Pending>()
  /** Fresh starts waiting for what the session started to stop: when they began waiting, and the next look. */
  private postponed = new Map<string, { since: number; rule?: boolean; timer?: ReturnType<typeof setTimeout> }>()
  private ticking = false
  private lastStaffCheck = 0
  private env: NodeJS.ProcessEnv

  constructor(private d: Deps) {
    this.env = d.env ?? process.env
    this.st = this.load()
  }

  private now = () => (this.d.now ? this.d.now() : Date.now())

  private load(): State {
    try {
      const raw = JSON.parse(fs.readFileSync(this.d.file, "utf8"))
      if (raw?.v === 1) return { ...empty(this.now()), ...raw, focus: { changedAt: this.now(), ...(raw.focus ?? {}) } }
    } catch {}
    return empty(this.now())
  }

  private save() {
    fs.mkdirSync(path.dirname(this.d.file), { recursive: true, mode: 0o700 })
    const tmp = `${this.d.file}.${process.pid}.tmp`
    fs.writeFileSync(tmp, JSON.stringify(this.st), { mode: 0o600 })
    fs.renameSync(tmp, this.d.file)
  }

  /** Blocking questions that were there before this daemon started are not news. */
  start() {
    for (const t of this.d.threads.all()) for (const q of M.live(t, "questions")) if (q.blocking && !q.answer) this.st.alerted[q.id] ??= this.now()
    // Restarted: the person may have moved meanwhile, but not that we know of.
    this.st.focus.changedAt = Math.max(this.st.focus.changedAt, this.now())
    this.save()
  }

  // --- where a question goes ---------------------------------------------------------

  /** A background agent's name: from crosstalk's spawn records, or from its own hook. */
  private bgOf(sessionId: string): string | undefined {
    return this.d.background(sessionId) ?? this.st.bg?.[sessionId]
  }

  /** Whether a session is a background agent, for steering (src/coordinator.ts). */
  isBackground(sessionId: string): boolean {
    return !!this.bgOf(sessionId)
  }

  /** A session's hook said it is a background agent: never where a question is put. */
  markBackground(sessionId: string, agent: string) {
    if (!sessionId || !agent || this.st.bg[sessionId] === agent) return
    ;(this.st.bg ??= {})[sessionId] = agent
    this.save()
  }

  private recs(): Rec[] {
    return F.liveRecs(this.d.readRecs ? this.d.readRecs() : R.readAll(), this.d.recAlive ?? R.recAlive)
  }

  /** The session the person is looking at now, or typed in last. */
  focused(): F.Focus | null {
    try {
      const recs = this.recs().filter((r) => !this.bgOf(r.sessionId))
      const last = A.typed().find((t) => this.d.sessions().has(t.sessionId) && !this.bgOf(t.sessionId))
      return F.focused({ recs, sys: this.d.focusSys ?? F.liveSys(this.env), lastTyped: last?.sessionId })
    } catch {
      return null
    }
  }

  /** The id of the session in front, for the daemon's own questions (the route question). */
  focusedId(): string | undefined {
    const f = this.st.focus.sessionId ?? this.focused()?.sessionId
    return f && this.d.sessions().has(f) ? f : undefined
  }

  /**
   * Where a question for the person goes: the main session when there is one,
   * else the one in front, else the one typed in last, else `fallback`. Never
   * a background agent: nobody is looking at it.
   */
  target(fallback?: string): string | undefined {
    const live = this.d.sessions()
    const ok = (s?: string) => !!s && live.has(s) && !this.bgOf(s)
    // Main even before it registers again after a daemon restart: its mod reads the store either way.
    const main = this.d.mainId()
    if (main && !this.bgOf(main)) return main
    const f = this.focused()
    if (ok(f?.sessionId)) return f!.sessionId
    if (ok(fallback)) return fallback
    return [...live.values()].filter((s) => !this.bgOf(s.sessionId)).sort((a, b) => (b.seenAt ?? 0) - (a.seenAt ?? 0))[0]?.sessionId
  }

  // --- the tick --------------------------------------------------------------------------

  /** Focus changes (for "away"), and stuck threads. Called on the daemon's timer. */
  tick() {
    if (this.ticking) return
    this.ticking = true
    try {
      const f = this.focused()
      if (f && f.how !== "last typed" && f.sessionId !== this.st.focus.sessionId) {
        this.st.focus = { sessionId: f.sessionId, how: f.how, changedAt: this.now() }
        this.save()
      }
      const every = Math.max(0, Number(this.env.CROSSTALK_STAFF_EVERY_MS ?? 60_000))
      if (this.now() - this.lastStaffCheck >= every) {
        this.lastStaffCheck = this.now()
        this.staffing()
      }
    } catch (e) {
      this.d.log(`attention: ${(e as Error).message}`)
    } finally {
      this.ticking = false
    }
  }

  away(): boolean {
    const last = A.lastTyped()
    return A.isAway({ now: this.now(), lastTypedAt: last?.at, focusChangedAt: this.st.focus.changedAt, minutes: A.awayMinutes(this.env) })
  }

  // --- recaps ----------------------------------------------------------------------------

  /** The session's recap: the last one kept, else its transcript's last turns now. */
  recapFor(sessionId: string): string {
    const kept = this.st.recaps[sessionId]
    if (kept?.text) return kept.text
    const t = this.d.sessions().get(sessionId)?.transcript
    const text = Rc.fromTranscript(t)
    if (text) {
      this.st.recaps[sessionId] = { text, at: this.now() }
      this.save()
    }
    return text
  }

  private threadText(t: M.Thread): string {
    const v = M.view(t)
    return [v.recap, ...v.features.map((f) => f.name), ...v.notes.filter((k) => k.kind === "task").map((k) => k.text), ...v.notes.filter((x) => x.kind === "decision").slice(-10).map((x) => x.text), ...v.questions.map((q) => q.text)].join(" ")
  }

  /**
   * ThreadService's tiebreaker: the thread among `candidates` this session's
   * recap points at, when its files could not say.
   */
  tiebreak(sessionId: string, candidates: string[], mode: "ask" | "create"): { id: string; why: string } | undefined {
    if (this.env.CROSSTALK_NO_RECAP === "1") return undefined
    const recap = this.recapFor(sessionId)
    if (!recap) return undefined
    const cands = candidates
      .map((id) => this.d.threads.thread(id))
      .filter((t): t is M.Thread => !!t && M.isLive(t))
      .map((t) => ({ id: t.id, name: t.meta.value.name, text: this.threadText(t) }))
    const best = Rc.tiebreak(recap, cands, mode)
    if (!best) return undefined
    const name = cands.find((c) => c.id === best.id)!.name
    this.d.log(`attention: recap places ${this.d.sessions().get(sessionId)?.name ?? sessionId} in ${name} (${best.shared.slice(0, 4).join(", ")})`)
    // The thread's own recap, if it has none: after this placement settles.
    queueMicrotask(() => this.storeRecap(best.id, recap))
    return { id: best.id, why: `its last turns are about ${best.shared.slice(0, 3).join(", ")}` }
  }

  /** A thread with no recap, or only one this service wrote, takes this one. */
  private storeRecap(threadId: string, recap: string) {
    const t = this.d.threads.thread(threadId)
    if (!t || !recap) return
    const cur = M.recap(t)
    if (cur && this.st.autoRecap[t.id] !== cur) return
    if (cur === recap) return
    this.d.threads.mutate(t.id, (th, by, now) => M.setRecap(th, by, recap, now))
    this.st.autoRecap[t.id] = recap
    this.save()
  }

  /** A turn ended. Recap when placement is unsure; offer a fresh session when the context is spent. */
  async stop(sessionId: string, o: { transcript?: string } = {}): Promise<{ ok: true; recap?: string; threads: string[]; context?: number }> {
    const reg = this.d.sessions().get(sessionId)
    const transcript = o.transcript ?? reg?.transcript
    const ambiguous = !!this.d.threads.question(sessionId) || this.d.threads.idsFor(sessionId).length === 0
    let recap: string | undefined
    if (ambiguous && transcript && this.env.CROSSTALK_NO_RECAP !== "1") {
      recap = Rc.fromTranscript(transcript)
      if (recap) {
        this.st.recaps[sessionId] = { text: recap, at: this.now() }
        this.save()
        this.replace(sessionId)
        const model = Rc.recapModel(this.env)
        if (model)
          Rc.summarise(recap, model, (line) => {
            this.st.recaps[sessionId] = { text: line, at: this.now(), model: true }
            this.save()
            this.replace(sessionId)
          })
      }
    }
    // A thread it is in with no recap yet takes the session's.
    for (const id of this.d.threads.idsFor(sessionId)) {
      const text = recap ?? (transcript ? Rc.fromTranscript(transcript) : "")
      if (text) this.storeRecap(id, text)
    }
    const usage = Cx.freshest(this.st.context[sessionId], transcript ? Cx.usageFromTranscript(transcript, this.env) : null)
    if (usage) {
      this.st.context[sessionId] = usage
      this.save()
      if (usage.percent >= Cx.spentAt(this.env)) await this.spent(sessionId, usage.percent, "context")
    }
    return { ok: true, ...(recap ? { recap } : {}), threads: this.d.threads.namesFor(sessionId), ...(usage ? { context: usage.percent } : {}) }
  }

  /** Place a session again, now that its recap changed; a thread question it answers goes. */
  private replace(sessionId: string) {
    const s = this.d.threads.local(sessionId)
    if (!s) return
    const before = this.d.threads.question(sessionId)
    this.d.threads.observe(s)
    if (before && !this.d.threads.question(sessionId))
      ui.withStore((items, now) => {
        for (const it of Object.values(items)) if (it.kind === "thread" && it.sessionId === sessionId) ui.settle(items, it.id, "answered", now)
      })
  }

  /** The mod's reading of the context window. */
  context(sessionId: string, u: { percent?: number; tokens?: number; window?: number }) {
    const percent = Number(u.percent)
    if (!Number.isFinite(percent)) return { ok: false, error: "percent is needed" }
    this.st.context[sessionId] = { percent: Math.round(percent), tokens: Number(u.tokens) || 0, window: Number(u.window) || 0, at: this.now() }
    this.save()
    if (percent >= Cx.spentAt(this.env)) void this.spent(sessionId, Math.round(percent), "context")
    return { ok: true }
  }

  // --- disposable sessions ---------------------------------------------------------

  /** The person's own standing rule about disposal (off by default); "stop starting fresh by itself" undoes it. */
  setDisposeRule(on: boolean): string {
    this.st.disposeRule = on ? START_FRESH : undefined
    this.st.disposeRuleOffered = true
    this.save()
    return on ? "◢ crosstalk: a session whose context is spent starts fresh from its thread by itself from now on." : "◢ crosstalk: you will be asked before a session starts fresh."
  }

  /** Whether a fresh session can start where this one is, before anything is ended. */
  private canRestart(sessionId: string): { rec: Rec; thread: M.Thread } | { why: string } {
    const ids = this.d.threads.idsFor(sessionId)
    const thread = ids.map((id) => this.d.threads.thread(id)).find((t): t is M.Thread => !!t)
    if (!thread) return { why: "it is in no thread to start from" }
    const rec = (this.d.readRecs ? this.d.readRecs() : R.readAll()).find((r) => r.sessionId === sessionId && !r.endedAt)
    if (!rec || !rec.pid) return { why: "crosstalk does not know its tab" }
    if (rec.client !== "claude") return { why: "it is not a Claude Code session" }
    const t = rec.terminal
    if (!t.tmux?.pane && !G_TYPABLE(t)) return { why: "its terminal cannot be typed into from outside" }
    return { rec, thread }
  }

  /**
   * The context is spent (`why`: a reading, or a PreCompact). A standing rule
   * says start fresh: done now. Otherwise the question, once per session.
   * Returns whether a fresh session is being started.
   */
  async spent(sessionId: string, percent: number | undefined, why: "context" | "precompact"): Promise<boolean> {
    const can = this.canRestart(sessionId)
    if ("why" in can) return false
    const rule = this.st.disposeRule
    // The context is fully spent and something the session started still
    // runs: Claude Code compacts as usual, and nothing is ended.
    if (why === "precompact" && (this.postponed.has(sessionId) || (rule === START_FRESH && this.busy(can.rec)))) {
      this.unpostpone(sessionId)
      this.d.log(`attention: ${this.nameOf(sessionId)} compacts as usual: something it started is still running`)
      return false
    }
    if (rule === START_FRESH) {
      this.d.log(`attention: a standing rule starts ${this.nameOf(sessionId)} fresh (${why})`)
      setTimeout(() => void this.dispose(sessionId, { rule: true }), why === "precompact" ? 300 : 0)
      return true
    }
    if (rule === COMPACT || this.st.disposeAsked[sessionId]) return false
    this.st.disposeAsked[sessionId] = this.now()
    this.save()
    const to = this.target(sessionId)
    if (!to) return false
    const name = this.nameOf(sessionId)
    const question = `${name}'s context is ${percent ? `${percent}% ` : "nearly "}spent. Start a fresh session from ${can.thread.meta.value.name} instead of compacting? The thread carries the recap, decisions, questions and tasks.`
    this.put({ id: itemId("dispose", sessionId), sessionId: to, from: name, thread: can.thread.meta.value.name, question, options: [START_FRESH, COMPACT] })
    return false
  }

  /** PreCompact: block it when a fresh session starts instead. */
  async precompact(sessionId: string, trigger: string): Promise<{ ok: true; block?: string }> {
    if (trigger === "manual") return { ok: true }
    const started = await this.spent(sessionId, this.st.context[sessionId]?.percent, "precompact")
    if (!started) return { ok: true }
    const t = this.d.threads.namesFor(sessionId)[0]
    return { ok: true, block: `crosstalk: starting a fresh session from the thread ${t} instead of compacting (a standing rule).` }
  }

  /** End the session and start a fresh one in its tab, primed with its thread. */
  async dispose(sessionId: string, o: { rule?: boolean; retry?: boolean } = {}): Promise<{ ok: boolean; text: string }> {
    // A retry whose wait was called off (a compaction came first): nothing to do.
    if (o.retry && !this.postponed.has(sessionId)) return { ok: false, text: "◢ crosstalk: no longer waiting to start it fresh." }
    const can = this.canRestart(sessionId)
    if ("why" in can) {
      this.unpostpone(sessionId)
      return { ok: false, text: `◢ crosstalk: cannot start ${this.nameOf(sessionId)} fresh: ${can.why}.` }
    }
    const name = this.nameOf(sessionId)
    const pct = this.st.context[sessionId]?.percent
    const file = D.writePrimer(can.thread.meta.value.name, D.primer(can.thread, { session: name, context: pct }), this.now())
    const bg = this.bgOf(sessionId)
    const cmd = D.freshCommand({ claude: this.env.CROSSTALK_CLAUDE_BIN ?? which("claude", this.env) ?? "claude", primerFile: file, env: bg ? { [BG_ENV]: bg } : undefined })
    const restart = this.d.restart ?? ((x) => D.restart(x))
    const r = await restart({ rec: can.rec, cmd })
    if (r.wait) {
      // Silently: no question, tried again when what it started has stopped.
      const waiting = this.postpone(sessionId, o)
      try {
        fs.unlinkSync(file)
      } catch {}
      if (!o.retry) this.d.log(`attention: ${name} starts fresh once what it started stops`)
      return waiting
        ? { ok: true, text: `◢ crosstalk: ${name} starts fresh from ${can.thread.meta.value.name} once what it started (a server, a watcher) has stopped. Nothing is ended under it.` }
        : { ok: false, text: `◢ crosstalk: did not start ${name} fresh: what it started never stopped.` }
    }
    this.unpostpone(sessionId)
    if (!r.ok) {
      this.d.log(`attention: ${name} not started fresh: ${r.text}`)
      return { ok: false, text: `◢ crosstalk: did not start ${name} fresh: ${r.text}.` }
    }
    this.st.disposed = [...this.st.disposed.filter((x) => this.now() - x.at < 24 * 3600_000), { sessionId, name, cwd: can.rec.cwd, threads: this.d.threads.idsFor(sessionId), at: this.now() }]
    this.save()
    const text = `◢ crosstalk: ${name} started fresh from ${can.thread.meta.value.name}${pct ? ` (its context was ${pct}% spent)` : ""}${o.rule ? ", by the standing rule" : ""}. Nothing was compacted.`
    this.d.log(`attention: ${name} started fresh from ${can.thread.meta.value.name}`)
    const to = this.target(sessionId)
    if (to) this.note(to, { id: `fresh:${sessionId}`, text })
    return { ok: true, text }
  }

  /** The session is still busy with what it started: whether `restart` should wait for it. */
  private busy(rec: Rec): boolean {
    if (this.d.busy) return this.d.busy(rec)
    if (this.d.restart) return false
    return PP.liveActivity(rec.pid).length > 0
  }

  /** Look again later, for at most PP.UNTIL_MS. False when that is up. */
  private postpone(sessionId: string, o: { rule?: boolean }): boolean {
    const p = this.postponed.get(sessionId) ?? { since: this.now(), rule: o.rule }
    if (this.now() - p.since > PP.UNTIL_MS()) {
      this.unpostpone(sessionId)
      this.d.log(`attention: ${this.nameOf(sessionId)} not started fresh: what it started never stopped`)
      return false
    }
    if (p.timer) clearTimeout(p.timer)
    p.timer = setTimeout(() => {
      p.timer = undefined
      void this.dispose(sessionId, { rule: p.rule, retry: true }).catch(() => undefined)
    }, PP.POLL_MS())
    ;(p.timer as { unref?: () => void }).unref?.()
    this.postponed.set(sessionId, p)
    return true
  }

  private unpostpone(sessionId: string) {
    const p = this.postponed.get(sessionId)
    if (p?.timer) clearTimeout(p.timer)
    this.postponed.delete(sessionId)
  }

  /** Whether a fresh start is waiting on what the session started. */
  waitingToDispose(sessionId: string): boolean {
    return this.postponed.has(sessionId)
  }

  /** A session registered: the fresh one after a disposal takes its predecessor's threads. */
  registered(reg: Reg) {
    const prev = this.st.disposed.find((x) => !x.successor && x.sessionId !== reg.sessionId && x.cwd === reg.cwd && this.now() - x.at < 30 * 60_000)
    if (!prev) return
    prev.successor = reg.sessionId
    this.save()
    for (const id of prev.threads) {
      const t = this.d.threads.thread(id)
      if (t) this.d.threads.answer(reg.sessionId, t.meta.value.name)
    }
    this.d.log(`attention: ${reg.name} carries on ${prev.name}'s threads`)
  }

  // --- staffing ------------------------------------------------------------------------

  private staffing() {
    const ms = St.stuckMs(this.env)
    const sessions = this.d.sessions()
    for (const t of this.d.threads.all()) {
      if (!M.isLive(t) || t.meta.value.status === "done") continue
      const sids = this.d.threads.sessionsIn([t.id])
      if (!sids.length) continue
      const working: St.Working[] = sids.map((sid) => {
        const key = `${t.id}:${sid}`
        this.st.working[key] ??= this.now()
        const touched = this.d.touched(sid) ?? {}
        const reg = sessions.get(sid)
        return {
          sessionId: sid,
          since: this.st.working[key],
          lastEditAt: Math.max(0, ...Object.values(touched)),
          lastCommitAt: reg ? (this.d.lastCommitAt ?? lastCommitAt)(reg.cwd) : undefined,
          active: this.active(sid),
        }
      })
      const blocking = M.live(t, "questions")
        .filter((q) => q.blocking && !q.answer)
        .map((q) => ({ text: q.text, at: q.at }))
      const s = St.stuck({ now: this.now(), ms, blocking, working })
      if (!s) continue
      const prev = this.st.stuck[t.id]
      if (prev && prev.since >= s.since) continue // asked about this spell already
      this.st.stuck[t.id] = { askedAt: this.now(), since: s.since }
      this.save()
      const to = this.target(sids[0])
      if (!to) continue
      let recap = ""
      try {
        recap = M.recap(t)
      } catch {}
      this.put({
        id: itemId("staff", `${t.id}:${s.since}`),
        sessionId: to,
        thread: t.meta.value.name,
        question: St.question(t.meta.value.name, s, this.now()),
        text: St.context({ recap, s, agents: sids.map((sid) => sessions.get(sid)?.name ?? sid.slice(0, 8)), now: this.now() }),
        options: [St.ADD, St.NOT_NOW],
      })
      this.d.log(`attention: ${t.meta.value.name} is stuck (${s.why}); asked whether to add an agent`)
    }
    this.save()
  }

  private active(sid: string): boolean {
    const st = (this.d.status(sid) ?? "").toLowerCase()
    if (/busy|working|running|waiting|thinking/.test(st)) return true
    const seen = this.d.sessions().get(sid)?.seenAt ?? 0
    return this.now() - seen < Math.max(15 * 60_000, Number(this.env.CROSSTALK_ACTIVE_MS ?? 0))
  }

  private staff(threadId: string, by: string | undefined): { ok: boolean; text: string } {
    const t = this.d.threads.thread(threadId)
    if (!t) return { ok: false, text: "◢ crosstalk: that thread has gone." }
    const sid = this.d.threads.sessionsIn([t.id])[0]
    const cwd = (sid && this.d.sessions().get(sid)?.cwd) || (this.d.threads.rootFor(t.meta.value.repo) ?? "")
    if (!cwd) return { ok: false, text: `◢ crosstalk: no checkout of ${t.meta.value.name} to start an agent in.` }
    const s = this.st.stuck[t.id]
    const stuck: St.Stuck = { why: M.live(t, "questions").some((q) => q.blocking && !q.answer) ? "question" : "progress", since: s?.since ?? this.now(), question: M.live(t, "questions").find((q) => q.blocking && !q.answer)?.text }
    const task = St.brief(t.meta.value.name, stuck, M.view(t))
    const background = this.env.CROSSTALK_STAFF_TAB !== "1"
    const r = this.d.spawn({ task, name: t.meta.value.name, cwd, by, background, thread: { id: t.id, name: t.meta.value.name } })
    this.d.log(`attention: second agent on ${t.meta.value.name}: ${r.ok ? r.agents.map((a) => a.name).join(", ") : r.text}`)
    return { ok: r.ok, text: r.text }
  }

  // --- blocking questions in threads -------------------------------------------------

  /** Threads that changed: a new blocking question is the person's to see, wherever they are. */
  onThreadsFlush(ids: string[]) {
    for (const id of ids) {
      const t = this.d.threads.thread(id)
      if (!t || !M.isLive(t)) continue
      for (const q of M.live(t, "questions")) {
        if (!q.blocking || q.answer || this.st.alerted[q.id]) continue
        this.st.alerted[q.id] = this.now()
        const asker = this.d.threads.sessionsIn([t.id])[0]
        void this.alert({ key: q.id, asker, thread: t.meta.value.name, blocking: true, count: M.live(t, "questions").filter((x) => x.blocking && !x.answer).length })
      }
    }
    this.save()
  }

  // --- permission prompts of background agents --------------------------------------

  /** Held open until the person answers, or `waitMs` passes (null: the dialog stays where it was). */
  permission(sessionId: string, o: { agent?: string; tool: string; input: unknown; suggestions?: unknown; cwd?: string }): Promise<{ ok: true; decision: Pm.Decision | null; asked?: string }> {
    if (o.agent) this.markBackground(sessionId, o.agent)
    const agent = o.agent || this.bgOf(sessionId) || this.nameOf(sessionId)
    const key = `${sessionId.slice(0, 40)}-${this.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`
    const id = itemId("perm", key)
    const to = this.target()
    if (!to) return Promise.resolve({ ok: true, decision: null })
    const threads = this.d.threads.namesFor(sessionId)
    this.put({ id, sessionId: to, from: agent, thread: threads[0] ?? agent, question: Pm.question(agent, o.tool, o.input), options: Pm.optionsFor(o.tool, o.input) })
    void this.alert({ key: id, asker: sessionId, askerName: agent, thread: threads[0] ?? agent, blocking: true, count: 1 })
    this.d.log(`attention: ${agent} asks to use ${o.tool}; asked in ${this.nameOf(to)}`)
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        this.pending.delete(id)
        ui.withStore((items, now) => ui.settle(items, id, "muted", now))
        resolve({ ok: true, decision: null, asked: to })
      }, Pm.waitMs(this.env))
      this.pending.set(id, { resolve: (d) => resolve({ ok: true, decision: d, asked: to }), timer, suggestions: o.suggestions, sessionId })
    })
  }

  // --- putting a question and getting it seen -----------------------------------------

  private put(o: { id: string; sessionId: string; question: string; options: string[]; from?: string; thread?: string; text?: string }) {
    ui.withStore((items, now) => ui.upsert(items, { ...o, kind: "attention", ts: now }, now))
  }

  private note(sessionId: string, n: Note) {
    const list = (this.st.notes[sessionId] ??= [])
    if (!list.some((x) => x.id === n.id)) list.push(n)
    this.save()
  }

  /**
   * A question someone is blocked on: a desktop notification when the person
   * is not looking at the asker, the phone when they are away, and a receipt
   * in the session they are in, naming the asker.
   */
  async alert(o: { key: string; asker?: string; askerName?: string; thread: string; blocking: boolean; count: number }) {
    if (!o.blocking) return
    const f = this.focused()
    const askerName = o.askerName ?? (o.asker ? this.nameOf(o.asker) : o.thread)
    const looking = !!o.asker && f?.sessionId === o.asker && f.how !== "last typed"
    const out: string[] = []
    if (!looking) {
      const asker = o.asker ? (this.d.readRecs ? this.d.readRecs() : R.readAll()).find((r) => r.sessionId === o.asker) : undefined
      const plan = N.desktopPlan({
        id: o.key,
        title: `crosstalk · ${o.thread}`,
        body: `${askerName} is waiting on you`,
        click: [path.join(this.d.root, "bin", "crosstalk"), "attn", "focus", "--session", o.asker ?? "", "--name", askerName],
        asker: asker?.terminal,
        platform: process.platform,
        has: (b) => (this.d.focusSys ?? F.liveSys(this.env)).has(b),
      })
      if (plan && this.env.CROSSTALK_NO_NOTIFY !== "1") {
        try {
          ;(this.d.desktop ?? liveDesktop)(plan)
          out.push(plan.how)
        } catch {}
      }
      const to = this.target()
      if (to && to !== o.asker)
        this.note(to, { id: `waiting:${o.key}`, text: `◢ crosstalk: ${askerName} (${o.thread}) is waiting on you. Say "show me ${askerName}" to go to it.` })
    }
    if (this.away()) {
      const line = N.sealedLine(o.count, o.thread)
      const cfg = N.ntfyConfig(this.env)
      if (cfg && (await N.pushNtfy(cfg, line, this.d.fetcher))) out.push("ntfy")
      // Claude's own push, from the mod in the session the person was last in.
      const to = this.target()
      if (to) {
        ;(this.st.pushes[to] ??= []).push({ id: `push:${o.key}`, text: line })
        this.save()
      }
    }
    if (out.length) this.d.log(`attention: ${o.thread} waits on the person (${out.join(", ")})`)
  }

  // --- answers ----------------------------------------------------------------------

  /** The mod's picker, or crosstalk_answer action "attention", answered one of these. */
  async act(sessionId: string, id: string, action: string, value: string | undefined): Promise<Record<string, unknown>> {
    const p = parseId(id)
    if (!p) return { ok: false, error: `not an attention question: ${id}` }
    if (action === "raised" || action === "later") return ui.withStore((items, now) => ui.act(items, id, action as ui.UiAction, now))
    const v = (value ?? "").trim()
    const answer = action === "mute" ? (p.what === "perm" ? Pm.DENY : p.what === "dispose" ? COMPACT : p.what === "rule" ? NOT_NOW : St.NOT_NOW) : v
    if (!answer) return { ok: false, error: "an attention question is answered with one of its options" }
    const item = ui.snapshot()[id]
    // One of its own options, word for word: "Deny for this session" is not "Allow for this session".
    if (action !== "mute" && item?.options && !item.options.includes(answer))
      return { ok: false, error: `answer with one of: ${item.options.join(" / ")}`, item }
    if (p.what === "perm" && item && answer !== Pm.DENY) {
      // Only the session it was put to allows it, and never the agent asking (a deny may come from anywhere).
      const asker = this.pending.get(id)?.sessionId
      if (sessionId !== item.sessionId || (asker && sessionId === asker)) return { ok: false, error: "that permission request was asked in another session", item }
    }
    const claim = ui.withStore((items, now) => ui.act(items, id, "answer", now, answer))
    if (!claim.ok) return claim
    if (p.what === "perm") {
      const pend = this.pending.get(id)
      if (!pend) return { ok: false, error: "that permission request is no longer waiting", item: claim.item }
      clearTimeout(pend.timer)
      this.pending.delete(id)
      const decision = Pm.decisionFor(answer, pend.suggestions)
      pend.resolve(decision)
      return { ok: true, item: claim.item, text: `◢ crosstalk: ${decision.behavior === "allow" ? "allowed" : "denied"} ${claim.item.from ?? "the agent"}'s request.` }
    }
    if (p.what === "dispose") {
      if (answer === START_FRESH) {
        this.st.disposeFresh = (this.st.disposeFresh ?? 0) + 1
        if (this.st.disposeFresh >= 2 && !this.st.disposeRuleOffered && !this.st.disposeRule) {
          this.st.disposeRuleOffered = true
          this.put({ id: itemId("rule", `dispose-${this.now()}`), sessionId, question: DISPOSE_RULE_QUESTION, options: [ALWAYS_FRESH, NOT_NOW] })
        }
        this.save()
      }
      if (answer !== START_FRESH) return { ok: true, item: claim.item, text: `◢ crosstalk: ${this.nameOf(p.key)} compacts as usual.` }
      const r = await this.dispose(p.key)
      if (!r.ok) ui.withStore((items, now) => ui.reopen(items, id, now))
      return { ...r, item: claim.item }
    }
    if (p.what === "rule") return { ok: true, item: claim.item, text: this.setDisposeRule(answer === ALWAYS_FRESH) }
    // staff
    if (answer !== St.ADD) return { ok: true, item: claim.item, text: "◢ crosstalk: no second agent. You will be asked again only if it gets stuck again." }
    const threadId = p.key.split(":")[0]
    const r = this.staff(threadId, sessionId)
    return { ...r, item: claim.item }
  }

  // --- what the mod and the hook take ------------------------------------------------

  /** Receipts for the mod's toasts, taken once. */
  takeNotes(sessionId: string): Note[] {
    const n = this.st.notes[sessionId] ?? []
    if (!n.length) return []
    delete this.st.notes[sessionId]
    this.save()
    return n
  }

  /** A sealed line for Claude's own push, taken once by the mod. */
  takePush(sessionId: string): Note | undefined {
    const list = this.st.pushes[sessionId]
    if (!list?.length) return undefined
    const p = list.shift()
    if (!list.length) delete this.st.pushes[sessionId]
    this.save()
    return p
  }

  /** For a session without the mod: receipts, and each question put to it, once, as a systemMessage. */
  systemMessage(sessionId: string): string | undefined {
    const lines = this.takeNotes(sessionId).map((n) => n.text)
    for (const it of ui.openFor(ui.snapshot(), sessionId)) {
      if (it.kind !== "attention" || this.st.told[it.id]) continue
      this.st.told[it.id] = this.now()
      lines.push(`◢ crosstalk: ${it.question} (${(it.options ?? []).join(" / ")}). Say which, and the agent will answer with crosstalk_answer action "attention" (id ${it.id}).`)
    }
    if (lines.length) this.save()
    return lines.length ? lines.join("\n") : undefined
  }

  private nameOf(sid: string) {
    return this.d.sessions().get(sid)?.name ?? sid.slice(0, 8)
  }

  /** The daemon's ops for this service, or undefined when the op is not one of them. */
  async handle(req: any, self: Reg | undefined): Promise<unknown> {
    // The hook names its own session; a cwd alone would find another one in the same folder.
    const sid = req.sessionId ? String(req.sessionId) : (self?.sessionId ?? "")
    switch (req.op) {
      case "attn_stop":
        return this.stop(sid, { transcript: req.transcript ? String(req.transcript) : undefined })
      case "attn_precompact":
        return this.precompact(sid, String(req.trigger ?? "auto"))
      case "attn_context":
        return this.context(sid, req)
      case "attn_permission":
        return this.permission(sid, { agent: req.agent, tool: String(req.tool ?? "a tool"), input: req.input, suggestions: req.suggestions })
      case "attn_bg":
        this.markBackground(sid, String(req.agent ?? ""))
        return { ok: true }
      case "attn_notes":
        return { ok: true, systemMessage: this.systemMessage(sid) }
      case "attn_act":
        return this.act(sid, String(req.id ?? ""), String(req.action ?? "answer"), req.value === undefined ? undefined : String(req.value))
      case "attn_focus":
        return { ok: true, focus: this.focused(), target: this.target(), away: this.away() }
      case "attn_dispose_rule":
        return { ok: true, text: this.setDisposeRule(req.on === true) }
      case "attn_dispose":
        return this.dispose(String(req.session ?? sid))
      case "attn_tick":
        this.lastStaffCheck = 0
        this.tick()
        return { ok: true }
      default:
        return undefined
    }
  }
}

/** Terminals gather can type into (gather.inPlaceSteps), checked before anything is ended. */
function G_TYPABLE(t: R.Term): boolean {
  if (t.kitty?.window && t.kitty.listenOn) return true
  if (t.wezterm?.pane) return true
  if (process.platform === "darwin" && (t.program === "Apple_Terminal" || t.program === "iTerm.app" || t.iterm) && t.tty) return true
  return false
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

function lastCommitAt(cwd: string): number | undefined {
  try {
    const r = spawnSync("git", ["-C", cwd, "log", "-1", "--format=%ct"], { encoding: "utf8", timeout: 3000 })
    const s = Number(r.stdout.trim())
    return r.status === 0 && s > 0 ? s * 1000 : undefined
  } catch {
    return undefined
  }
}

function liveDesktop(d: N.Desktop) {
  if (d.kind === "tty") {
    let fd = -1
    try {
      fd = fs.openSync(d.path, fs.constants.O_WRONLY | fs.constants.O_NOCTTY | fs.constants.O_NONBLOCK)
      fs.writeSync(fd, d.data)
    } catch {
    } finally {
      if (fd >= 0) fs.closeSync(fd)
    }
    return
  }
  spawnSync(d.step.cmd, d.step.args, { input: d.step.input, timeout: 5000, stdio: "ignore" })
}
