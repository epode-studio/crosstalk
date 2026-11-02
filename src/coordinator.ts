// The daemon's side of three things from docs/design/next-generation.md:
//
//   the main session      src/main.ts decides where things go; this applies it
//                         and answers crosstalk_main, crosstalk_sessions and
//                         crosstalk_steer
//   answers become rules  every answered question is recorded (rules/history.ts);
//                         the second identical answer offers "Always do this?";
//                         yes is a rule on the ref (rules/doc.ts) that answers
//                         matching questions by itself, for everyone
//   agents warn           src/warn/service.ts, given what it needs from here
//
// The daemon owns the sessions, the queue and the relay; this module only
// calls back into them through Deps, so daemon.ts keeps a few call sites and
// nothing else.

import crypto from "node:crypto"
import path from "node:path"
import type { Identity, Peer, Held } from "./config.ts"
import type { Envelope, SessionPresence, Slice } from "./protocol.ts"
import type { ThreadService } from "./threads/service.ts"
import { NEW_THREAD, NO_THREAD } from "./threads/service.ts"
import * as M from "./threads/model.ts"
import * as ui from "./uistate.ts"
import * as mainS from "./main.ts"
import { injectInstruction } from "./inject.ts"
import { RuleDocs, RULES_FILE, docId, type Change } from "./rules/doc.ts"
import * as H from "./rules/history.ts"
import { describe, neverAuto, ruleKey, type Question } from "./rules/key.ts"
import { WarnService, type LocalMessage } from "./warn/service.ts"
import type { Conflict } from "./warn/conflict.ts"
import { isBot } from "./ui-extra/bots.ts"
import * as trust from "./trust.ts"
import { threadMuted } from "./ui-extra/mute.ts"
import { revokedFingerprints, shouldHold } from "./threads/rekey.ts"
import * as metrics from "./metrics/log.ts"
import { CrossRepo } from "./threads/crossrepo.ts"

export { RULES_FILE }

export type Reg = { sessionId: string; name: string; cwd: string; socket: string; token?: string; pid: number }

export type CoordDeps = {
  identity: Identity
  threads: ThreadService
  log: (...a: unknown[]) => void
  root: string
  peers: () => Record<string, Peer>
  send: (label: string, env: Envelope) => unknown
  sessions: () => Map<string, Reg>
  status: (sessionId: string) => string
  presence: () => Map<string, { sessions: SessionPresence[]; at: number }>
  /** Hold a message for a local session, as the daemon holds a peer's. */
  holdLocal: (sessionId: string, h: Held, slices: Slice[]) => void
  /** What is waiting on the person in one session. */
  waitingIn: (sessionId: string) => number
  modLive: (sessionId: string) => boolean
  repoOf: (sessionId: string) => string | undefined
  /** Deliver a held, unrouted message to a session (the route op). */
  route: (id: string, session: string) => Promise<any>
  /** Answer a peer's ask. */
  answerPeer: (label: string, correlation: string, text: string, replyTo?: string) => unknown
}

type Note = H.Note

const short = (repo: string) => repo.split("/").slice(-2).join("/") || repo || "this repo"

export class Coordinator {
  readonly docs: RuleDocs
  readonly warn: WarnService
  private hist: H.History
  private me: string
  private answering = false

  constructor(private d: CoordDeps) {
    this.docs = new RuleDocs({ identity: d.identity, peers: d.peers, file: path.join(d.root, "rules-docs.json"), members: (repo) => d.threads.peopleIn(repo) })
    this.me = this.docs.me
    this.hist = H.loadHistory()
    this.warn = new WarnService({
      me: this.me,
      label: d.identity.label,
      threads: d.threads,
      peers: d.peers,
      presence: d.presence,
      send: d.send,
      log: d.log,
      file: path.join(d.root, "warn.json"),
      deliver: (sid, m) => this.deliver(sid, m),
      ask: (sids, c) => this.askConflict(sids, c),
      sessionsNamed: (name) => [...d.sessions().values()].filter((s) => s.name === name).map((s) => s.sessionId),
    })
    this.cross = new CrossRepo({ me: this.me, label: d.identity.label, threads: d.threads, peers: d.peers, relay: (o) => this.warn.relay(o), log: d.log })
  }

  readonly cross: CrossRepo

  private save = () => H.saveHistory(this.hist)

  /** Put back what was true before the daemon restarted: main stays out of its threads. */
  start() {
    const m = this.mainId()
    if (m) this.d.threads.setOutside(m, true)
  }

  // --- main session ---------------------------------------------------------------

  /** The main session, while it is a registered session. */
  mainId(): string | undefined {
    const m = mainS.readMain()
    if (!m) return undefined
    if (!this.d.sessions().has(m.sessionId)) {
      mainS.writeMain(null)
      this.d.threads.setOutside(m.sessionId, false)
      this.d.log(`main session ${m.name} has ended; back to focus-aware`)
      return undefined
    }
    return m.sessionId
  }

  /** What one session's mod shows, out of every open item (main.ts itemsFor). */
  itemsFor(items: Record<string, ui.UiItem>, sid: string): ui.UiItem[] {
    const open = Object.values(items).filter((i) => !ui.FINAL.has(i.state))
    return mainS.itemsFor(open, sid, this.mainId())
  }

  /** The session an inbound message goes to once routing picked one. */
  redirect(o: { how: string; kind: string; intent: string; target?: string }): string | undefined {
    return mainS.redirect({ ...o, mainId: this.mainId() })
  }

  /** Thread notices and digest lines for one session, each taken once. */
  notesFor(sid: string, threadNotes: Note[]): Note[] {
    const main = this.mainId()
    let keep = threadNotes
    if (main && main !== sid) {
      for (const n of threadNotes) if (mainS.crossNote(n.id)) H.addDigest(this.hist, main, n)
      keep = threadNotes.filter((n) => !mainS.crossNote(n.id))
    }
    const mine = [...(this.hist.digest[sid] ?? [])]
    delete this.hist.digest[sid]
    if (!main || main === sid) {
      mine.push(...(this.hist.digest["*"] ?? []))
      delete this.hist.digest["*"]
    }
    if (mine.length || keep !== threadNotes) this.save()
    return [...keep, ...mine]
  }

  /** A line for the digest: main's when there is one, else whichever session asks first. */
  private digest(n: Note, to?: string) {
    H.addDigest(this.hist, to ?? this.mainId() ?? "*", n)
    this.save()
  }

  /** A digest line from another module (src/extras.ts): disk, stats. */
  note(n: Note, to?: string) {
    this.digest(n, to)
  }

  mainStatus(sid: string):{ sessions: number; threads: number; waiting: number } | undefined {
    if (this.mainId() !== sid) return undefined
    const all = [...this.d.sessions().keys()].filter((s) => s !== sid)
    const threads = new Set(all.flatMap((s) => this.d.threads.idsFor(s)))
    const waiting = [...this.d.sessions().keys()].reduce((n, s) => n + this.d.waitingIn(s), 0)
    return { sessions: all.length, threads: threads.size, waiting }
  }

  private setMain(self: Reg, on: boolean) {
    const r = mainS.setMain(on, { sessionId: self.sessionId, name: self.name, pid: self.pid })
    this.d.threads.setOutside(self.sessionId, on)
    if (r.previous && r.previous.sessionId !== self.sessionId) {
      this.d.threads.setOutside(r.previous.sessionId, false)
      this.digest({ id: `main:${Date.now()}`, text: `◢ crosstalk: ${self.name} is your main session now, so this one is a working session again.` }, r.previous.sessionId)
    }
    this.d.log(on ? `main session is ${self.name}${r.previous ? ` (was ${r.previous.name})` : ""}` : `${self.name} is no longer main`)
    if (!on)
      return { ok: true, main: false, text: r.changed ? "This is a working session again. Questions go back to whichever session you are looking at." : "This was not your main session." }
    return {
      ok: true,
      main: true,
      text:
        `This is your main session now. It has left its threads. Questions from other threads, messages nothing matched, threads combining and key changes come here, and your other sessions only ask about their own threads.` +
        (r.previous && r.previous.sessionId !== self.sessionId ? ` ${r.previous.name} was main before and has been told.` : ""),
    }
  }

  sessionsList() {
    const main = this.mainId()
    return [...this.d.sessions().values()].map((s) => ({
      name: s.name,
      id: s.sessionId,
      cwd: s.cwd,
      status: this.d.status(s.sessionId),
      threads: this.d.threads.namesFor(s.sessionId),
      waiting: this.d.waitingIn(s.sessionId),
      ...(s.sessionId === main ? { main: true } : {}),
    }))
  }

  private async steer(self: Reg | undefined, req: any) {
    if (!self) return { ok: false, error: "steering comes only from one of your own registered sessions" }
    const want = String(req.session ?? "").trim()
    const text = String(req.text ?? "").trim()
    if (!want || !text) return { ok: false, error: "say which session and what to tell it" }
    const all = [...this.d.sessions().values()]
    const target =
      all.find((s) => s.sessionId === want) ??
      all.find((s) => s.name === want) ??
      all.find((s) => this.d.threads.namesFor(s.sessionId).includes(want) && s.sessionId !== self.sessionId) ??
      all.find((s) => s.name.toLowerCase().includes(want.toLowerCase()))
    if (!target) return { ok: false, error: `no session called "${want}". Open: ${all.map((s) => s.name).join(", ") || "none"}` }
    if (target.sessionId === self.sessionId) return { ok: false, error: "that is this session; just say it here" }
    if (!target.socket) return { ok: false, error: `${target.name} has no inbox crosstalk can write to (it is not a Claude Code session)` }
    await injectInstruction({ socket: target.socket, replyTo: self.socket || undefined, fromName: `${self.name} (you)`, token: target.token }, { from: self.name, text })
    this.d.log(`steered ${target.name} from ${self.name}`)
    return { ok: true, to: target.name, text: `Told ${target.name}.` }
  }

  // --- the daemon's requests ---------------------------------------------------------

  /** One of this module's control ops, or undefined when the op is someone else's. */
  async handle(req: any, self: Reg | undefined): Promise<unknown> {
    switch (req.op) {
      case "main": {
        if (!self) return { ok: false, error: "no session to make main" }
        const on = !(req.on === false || req.on === "off")
        return this.setMain(self, on)
      }
      case "sessions":
        return { ok: true, main: this.mainId() ? this.d.sessions().get(this.mainId()!)?.name : undefined, sessions: this.sessionsList() }
      case "steer":
        return this.steer(self, req)
      case "rule":
        return this.ruleOp(self, req)
      case "edited": {
        const sid = self?.sessionId ?? String(req.sessionId ?? "")
        const repo = this.d.repoOf(sid)
        if (!repo) return { ok: true, warned: [] }
        const e = req.edit ?? {}
        if (typeof e.file !== "string") return { ok: false, error: "edited needs a file" }
        const strs = (v: unknown) => (Array.isArray(v) ? v.filter((x): x is string => typeof x === "string").slice(0, 100) : [])
        const out = this.warn.edited({ sessionId: sid, name: self?.name ?? sid, repo, edit: { file: e.file, symbols: strs(e.symbols), pending: strs(e.pending), diff: String(e.diff ?? "").slice(0, 64 * 1024) } })
        // A library's public surface: the repos that depend on it hear too (threads/crossrepo.ts).
        let dependents: string[] = []
        try {
          dependents = this.cross.edited({ sessionId: sid, name: self?.name ?? sid, repo, root: typeof e.root === "string" ? e.root : this.d.threads.rootFor(repo), file: e.file, diff: String(e.diff ?? "") })
        } catch (err) {
          this.d.log(`cross-repo: ${(err as Error).message}`)
        }
        return { ok: true, ...out, ...(dependents.length ? { dependents } : {}) }
      }
      case "conflict": {
        if (!req.id) return { ok: true, conflicts: this.warn.list(self?.sessionId) }
        if (!self) return { ok: false, error: "no session" }
        return this.warn.propose(self.sessionId, { id: String(req.id), owner: String(req.owner ?? ""), text: req.text })
      }
      default:
        return undefined
    }
  }

  /** A peer's frame of one of this module's kinds. True when handled. */
  accept(label: string, env: Envelope, inRoom: boolean): boolean {
    if (env.kind !== "heads-up" && env.kind !== "conflict" && env.kind !== "rules") return false
    if (inRoom || !this.d.peers()[label]) {
      this.d.log(`ignored a ${env.kind} from ${label}: only over a direct channel`)
      return true
    }
    // What a heads-up or conflict from them may do here: the same level and
    // mutes as any message. Muted (or at "mute") is dropped; an agent, a
    // muted thread or anyone below "ask" is never handed to an agent by
    // itself, only held as a card the person hands over.
    const peer = this.d.peers()[label]
    const ctx: trust.Context = { direct: true, machine: !!peer.isMachine }
    const level = trust.levelFor(label, ctx)
    if (env.kind !== "rules" && level === "mute") {
      this.d.log(`dropped a ${env.kind} from ${label}: they are at mute`)
      return true
    }
    const screen = { auto: !peer.isMachine && !isBot(label, this.d.peers()) && trust.atLeast(level, "ask") && !trust.isMuted(label, ctx) && !threadMuted(env) }
    try {
      if (env.kind === "heads-up") this.warn.acceptHeadsUp(label, env, screen)
      else if (env.kind === "conflict") this.warn.acceptConflict(label, env, screen)
      else if (isBot(label, this.d.peers())) this.d.log(`ignored rules from ${label}: an agent cannot answer for anyone`)
      else this.acceptRules(label, env)
    } catch (e) {
      this.d.log(`${env.kind}: ${(e as Error).message}`)
    }
    return true
  }

  // --- local delivery -----------------------------------------------------------------

  /** A heads-up or conflict for a local session: held like a message, handed to its agent by itself. */
  private deliver(sessionId: string, m: LocalMessage) {
    const h: Held = {
      id: m.id,
      from: m.from,
      fromSession: m.fromSession,
      intent: "fyi",
      kind: m.kind,
      text: m.text,
      slices: m.slices.map((s) => ({ kind: s.kind, label: s.label, bytes: s.bytes })),
      ts: Date.now(),
      threads: m.threads,
      // Handed to the agent by itself only when warn/service.ts said so: a
      // heads-up from this machine, or from someone in the thread it is about.
      ...(m.auto ? { auto: true } : {}),
    }
    this.d.holdLocal(sessionId, h, m.slices)
  }

  private askConflict(sids: string[], c: Conflict) {
    const options = c.sides.map((s) => s.name)
    const question = `The agents in ${options.join(" and ")} cannot agree who changes ${c.symbol} in ${c.file}. Which thread changes it (the other rebases onto it)?`
    const to = sids[0] ?? this.mainId()
    if (!to) return
    if (this.d.modLive(to))
      ui.withStore((items, now) => ui.upsert(items, { id: `conflict:${c.id}`, kind: "conflict", sessionId: to, thread: c.file, question, options, ts: now }, now))
    else this.digest({ id: `conflict:${c.id}`, text: `◢ crosstalk: ${question} Say which, and the agent will record it with crosstalk_conflict (id ${c.id}).` }, to)
  }

  // --- answers become rules --------------------------------------------------------

  /** A person answered a question. Offers "Always do this?" the second identical time. */
  answered(q: Question, answer: string, o: { sid?: string; repo?: string }): H.Offer | null {
    const repo = o.repo ?? q.repo ?? ""
    const offer = H.recordAnswer(this.hist, { ...q, repo: q.repo ?? repo }, answer, { repo, sessionId: o.sid })
    this.save()
    if (!offer) return null
    const to = o.sid && this.d.sessions().has(o.sid) ? o.sid : this.mainId()
    if (to && this.d.modLive(to))
      ui.withStore((items, now) => ui.upsert(items, { id: offer.id, kind: "rule", sessionId: to, thread: short(repo), question: H.offerQuestion(offer), options: [H.ALWAYS, H.NOT_NOW], ts: now }, now))
    else this.digest({ id: offer.id, text: `◢ crosstalk: ${H.offerQuestion(offer)} Say "always do that" and the agent will make it a rule with crosstalk_rule.` }, to)
    this.d.log(`offered a standing rule for ${offer.key}`)
    return offer
  }

  /** An offer as a tool result shows it, for the agent to put to the person. */
  offerView(o: H.Offer) {
    return { id: o.id, question: H.offerQuestion(o), how: `Ask your user. On yes, call crosstalk_rule with accept "${o.id}"; on no, decline "${o.id}".` }
  }

  answeredThreadQuestion(sid: string | undefined, thread: string | undefined, qid: string, text: string) {
    const t = this.d.threads.find(sid, thread)
    const q = t?.questions[qid]
    if (!t || !q) return null
    return this.answered({ kind: "question", text: q.text, risky: riskyIn(t, q.text) }, text, { sid, repo: t.meta.value.repo })
  }

  answeredRoute(sid: string | undefined, o: { sender: string; repo?: string; target: string }) {
    const names = this.d.threads.namesFor(o.target)
    const name = this.d.sessions().get(o.target)?.name ?? o.target
    return this.answered({ kind: "route", sender: o.sender, repo: o.repo }, names[0] ?? name, { sid, repo: o.repo })
  }

  answeredAsk(sid: string | undefined, o: { sender: string; text: string; repo?: string }, answer: string) {
    return this.answered({ kind: "ask", sender: o.sender, text: o.text }, answer, { sid, repo: o.repo ?? this.d.repoOf(sid ?? "") })
  }

  /** Before the thread picker is answered: what it was between, to record with the answer. */
  threadQuestionOf(sid: string): Question | undefined {
    const q = this.d.threads.question(sid)
    if (!q) return undefined
    return { kind: "thread", repo: this.d.repoOf(sid), among: q.options.filter((o) => o !== NEW_THREAD && o !== NO_THREAD) }
  }

  // automatic answers

  private matchRule(q: Question, repo: string | undefined) {
    if (!repo) return undefined
    const rule = this.docs.match(repo, ruleKey(q))
    if (!rule || neverAuto(q, rule.then)) return undefined
    return rule
  }

  private autoNote(id: string, what: string, answer: string, rule: { text: string }) {
    metrics.record({ k: "auto", at: Date.now(), id, what: what.slice(0, 120) })
    this.digest({ id: `auto:${id}`, text: `◢ crosstalk: answered ${what} with "${answer}", by the standing rule (${rule.text}).` })
  }

  /** Thread questions that changed: any a standing rule answers are answered. */
  onThreadsFlush(ids: string[]) {
    if (this.answering) return
    this.answering = true
    try {
      for (const id of ids) {
        const t = this.d.threads.thread(id)
        if (!t || !M.isLive(t)) continue
        for (const q of M.live(t, "questions")) {
          if (q.answer || q.ship) continue // a shipping question is a person's, never a rule's
          const rule = this.matchRule({ kind: "question", text: q.text, risky: riskyIn(t, q.text) }, t.meta.value.repo)
          if (!rule) continue
          const r = this.d.threads.edit(undefined, { thread: t.id, answer: { id: q.id, text: rule.then! } })
          if (r.ok) {
            this.d.log(`answered ${q.id} in ${t.meta.value.name} by rule ${rule.id}`)
            this.autoNote(q.id, `"${q.text.slice(0, 80)}" in ${t.meta.value.name}`, rule.then!, rule)
          }
        }
      }
    } finally {
      this.answering = false
    }
  }

  /** "Which thread is this session part of?", answered by a rule when one says. */
  autoThread(sid: string): boolean {
    const q = this.threadQuestionOf(sid)
    if (!q) return false
    const rule = this.matchRule(q, q.repo)
    if (!rule || !(q.among ?? []).includes(rule.then!)) return false
    const r = this.d.threads.answer(sid, rule.then!)
    if (r.ok) this.autoNote(`thread:${sid}`, `which thread ${this.d.sessions().get(sid)?.name ?? "a session"} is part of`, rule.then!, rule)
    return r.ok
  }

  /** A message nothing matched, routed by a rule when one says. Returns the session it went to. */
  autoRoute(sender: string, repo: string | undefined): string | undefined {
    const rule = this.matchRule({ kind: "route", sender, repo }, repo)
    if (!rule) return undefined
    const all = [...this.d.sessions().values()]
    const inThread = all.filter((s) => this.d.threads.namesFor(s.sessionId).includes(rule.then!))
    const target = inThread[0] ?? all.find((s) => s.name === rule.then)
    if (!target) return undefined
    this.autoNote(`route:${sender}:${Date.now()}`, `where ${sender}'s message about ${short(repo ?? "")} goes`, target.name, rule)
    return target.sessionId
  }

  /** A peer's ask a rule answers: sent at once. True when answered. */
  autoAsk(label: string, env: Envelope): boolean {
    if (env.kind !== "ask" || !env.correlation) return false
    const repo = (env.footprint as { repo?: string } | undefined)?.repo
    const rule = this.matchRule({ kind: "ask", sender: label, text: env.text }, repo)
    if (!rule) return false
    this.d.answerPeer(label, env.correlation, rule.then!, env.id)
    this.autoNote(`ask:${env.id}`, `${label}'s question "${env.text.slice(0, 80)}"`, rule.then!, rule)
    return true
  }

  // the rules themselves

  private async ruleOp(self: Reg | undefined, req: any) {
    const sid = self?.sessionId
    if (req.accept !== undefined || req.yes === true) return this.acceptOffer(String(req.accept ?? "last"), sid)
    if (req.decline !== undefined || req.yes === false) return this.declineOffer(String(req.decline ?? "last"), sid)
    if (req.remove) {
      const repo = req.repo ? String(req.repo) : undefined
      const r = this.docs.remove(repo, String(req.remove))
      if (!r.ok) return r
      this.hist.seen.push(`gone:${r.rule.id}:${this.docs.writer(r.repo, r.rule.id)}`)
      this.save()
      this.publish(r.repo)
      return { ok: true, text: `Dropped the standing rule for ${short(r.repo)}: ${r.rule.text}. Everyone in the repo's threads is told.` }
    }
    if (req.public !== undefined) {
      const repo = String(req.repo ?? (sid ? this.d.repoOf(sid) : "") ?? "")
      if (!repo) return { ok: false, error: "which repo?" }
      this.docs.setPublic(repo, !!req.public)
      this.publish(repo)
      return { ok: true, text: req.public ? `The standing rules for ${short(repo)} are now committed in plain text.` : `The standing rules for ${short(repo)} are sealed to the people in its threads.` }
    }
    const repos = req.repo ? [String(req.repo)] : this.docs.repos()
    return {
      ok: true,
      // Who made it is the key that signed it, not the name written in it.
      rules: repos.flatMap((repo) => this.docs.rules(repo).map((r) => ({ id: r.id, repo, rule: r.text, answer: r.then, by: this.docs.verified(docId(repo), r) ? this.whoOf(r.by) : "unsigned" }))),
      offers: Object.values(this.hist.offers)
        .filter((o) => o.state === "open")
        .map((o) => ({ id: o.id, question: H.offerQuestion(o) })),
    }
  }

  private acceptOffer(ref: string, sid?: string) {
    const offer = ref && ref !== "last" ? this.hist.offers[ref] : H.lastOpen(this.hist, sid)
    if (!offer) return { ok: false, error: "no \"Always do this?\" offer is waiting" }
    if (offer.state !== "open") return { ok: false, error: `that offer was already answered (${offer.state})` }
    const rule = this.docs.add(offer.repo, { key: offer.key, then: offer.answer, text: `${describe(offer.q)}: "${offer.answer}"`, who: this.d.identity.label })
    offer.state = "yes"
    offer.ruleId = rule.id
    this.hist.seen.push(rule.id)
    this.save()
    ui.withStore((items, now) => ui.settle(items, offer.id, "answered", now))
    this.publish(offer.repo)
    this.d.log(`standing rule ${rule.id} for ${offer.repo}: ${rule.text}`)
    // Anything waiting that it answers is answered now.
    this.onThreadsFlush(this.d.threads.list().filter((t) => t.repo === offer.repo).map((t) => t.id))
    return {
      ok: true,
      rule: { id: rule.id, text: rule.text },
      text: `Standing rule for ${short(offer.repo)}: ${rule.text}. It answers that question for everyone in the repo's threads from now on; anyone can undo it ("drop the rule about …").`,
    }
  }

  private declineOffer(ref: string, sid?: string) {
    const offer = ref && ref !== "last" ? this.hist.offers[ref] : H.lastOpen(this.hist, sid)
    if (!offer || offer.state !== "open") return { ok: true, text: "Nothing to decline." }
    offer.state = "no"
    this.save()
    ui.withStore((items, now) => ui.settle(items, offer.id, "answered", now))
    return { ok: true, text: "Not a rule. You will not be asked about that one again." }
  }

  /** The mod's picker answered a rule offer or a conflict. */
  uiAct(sid: string, it: ui.UiItem, value: string) {
    if (it.kind === "rule") {
      const claim = ui.withStore((items, now) => ui.act(items, it.id, "answer", now, value))
      if (!claim.ok) return claim
      const r: any = value === H.ALWAYS ? this.acceptOffer(it.id, sid) : this.declineOffer(it.id, sid)
      return { ...r, item: claim.item }
    }
    if (it.kind === "conflict") {
      const claim = ui.withStore((items, now) => ui.act(items, it.id, "answer", now, value))
      if (!claim.ok) return claim
      const r = this.warn.decide(sid, it.id.slice("conflict:".length), value)
      if (!r.ok) ui.withStore((items, now) => ui.reopen(items, it.id, now))
      return { ...r, item: claim.item }
    }
    return undefined
  }

  /** Everyone in the repo's threads gets the rules now, and the ref gets them soon. */
  private publish(repo: string) {
    const f = this.docs.frame(repo)
    if (!f) return
    const byFp = new Map(Object.values(this.d.peers()).map((p) => [p.fingerprint, p]))
    for (const fp of this.d.threads.peopleIn(repo)) {
      const p = byFp.get(fp)
      if (!p || fp === this.me) continue
      this.d.send(p.label, { v: 1, id: crypto.randomUUID(), ts: Date.now(), from: this.d.identity.label, fromSession: "-", to: p.label, kind: "rules", intent: "fyi", text: "", rules: f })
    }
    this.d.threads.touchRepo(repo)
  }

  private acceptRules(label: string, env: Envelope) {
    const peer = this.d.peers()[label]
    const f = env.rules as { repo?: unknown; doc?: unknown; key?: unknown } | undefined
    const doc = M.parseThread(f?.doc)
    if (!peer || !f || typeof f.repo !== "string" || !doc) return this.d.log(`ignored malformed rules from ${label}`)
    if (!this.d.threads.peopleIn(f.repo).includes(peer.fingerprint)) return this.d.log(`ignored rules for ${f.repo} from ${label}: not in any of its threads here`)
    const change = this.docs.merge(f.repo, doc, typeof f.key === "string" ? f.key : undefined, Number((f as any).epoch) || 0)
    this.announce(f.repo, change)
    if (change.added.length) this.onThreadsFlush(this.d.threads.list().filter((t) => t.repo === f.repo).map((t) => t.id))
  }

  /** RULES.md from the ref (ThreadService's extra file). */
  readRules(repo: string, text: string) {
    this.announce(repo, this.docs.read(repo, text))
  }

  renderRules(repo: string): string | undefined {
    const byFp = new Map(Object.values(this.d.peers()).map((p) => [p.fingerprint, p]))
    // Someone no longer in any of the repo's threads, or revoked, gets no key that opens what is written next.
    const should = shouldHold(this.d.threads.peopleIn(repo), revokedFingerprints())
    if (this.docs.ensureKey(repo, should)) {
      this.d.log(`rules for ${repo}: new key (epoch ${this.docs.epoch(repo)})`)
      this.publish(repo)
    }
    const recipients = should
      .map((fp) => byFp.get(fp))
      .filter((p): p is Peer => !!p)
    return this.docs.render(repo, recipients)
  }

  private whoOf(fp: string | undefined) {
    if (!fp) return "someone"
    if (fp === this.me) return "you"
    return Object.values(this.d.peers()).find((p) => p.fingerprint === fp)?.label ?? fp.slice(0, 9)
  }

  /** Each rule that appeared or went, once in this person's digest. */
  private announce(repo: string, c: Change) {
    for (const r of c.added) {
      if (this.hist.seen.includes(r.id)) continue
      this.hist.seen.push(r.id)
      this.digest({ id: `rule:${r.id}:${r.l}`, text: `◢ crosstalk: ${this.docs.verified(docId(repo), r) ? this.whoOf(r.by) : "someone (unsigned)"} made a standing rule for ${short(repo)}: ${r.text}. Matching questions are answered by it from now on; anyone can undo it ("drop the rule about …").` })
    }
    for (const r of c.removed) {
      const by = this.docs.writer(repo, r.id)
      const mark = `gone:${r.id}:${by}`
      if (this.hist.seen.includes(mark)) continue
      this.hist.seen.push(mark)
      this.hist.seen = this.hist.seen.filter((x) => x !== r.id)
      this.digest({ id: `rule-gone:${r.id}:${r.l}`, text: `◢ crosstalk: ${this.whoOf(by)} dropped the standing rule for ${short(repo)}: ${r.text}.` })
    }
    this.save()
  }
}

/** A question that names a feature the thread marks risky is about a risky feature. */
function riskyIn(t: M.Thread, text: string): boolean {
  const low = text.toLowerCase()
  return M.live(t, "features").some((f) => f.risk === "risky" && (low.includes(f.name.toLowerCase()) || (!!f.flag && low.includes(f.flag.toLowerCase()))))
}
