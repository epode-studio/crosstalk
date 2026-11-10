// Agents warn each other (docs/design/next-generation.md, "Agents talk without
// being told").
//
// Every edit a local session makes arrives here (op "edited", from the
// PostToolUse hook, with the top-level symbols it changed and the diff). Any
// other thread whose footprint includes that file hears about it:
//
//   a thread on this machine      its files cover the file
//   a peer's session              its presence lists the file, in its threads
//   a thread that warned us       its own heads-up said it has edits there
//
// That thread's sessions get a `heads-up`: the diff attached as a slice, sealed
// like every envelope and sent only through the thread's own people. Their
// agent receives it as data by itself (the mod hands a message about a
// session's own thread over without a picker) and raises a question only if it
// needs a decision. Rate limited and coalesced per (file, thread) by gate.ts.
//
// Conflict prediction: every heads-up carries the sender's unmerged symbols for
// the file. Two threads with unmerged edits to the same symbol are a conflict
// (conflict.ts): both agents get a `conflict` frame naming the other thread and
// the symbol, each proposes who changes it with crosstalk_thread action "note" kind "conflict" (recorded as
// a decision in its own thread), and only proposals that keep disagreeing
// become one question to the people.

import fs from "node:fs"
import path from "node:path"
import crypto from "node:crypto"
import type { Envelope, SessionPresence, Slice } from "../protocol.ts"
import type { Peer } from "../config.ts"
import type { ThreadService } from "../threads/service.ts"
import * as M from "../threads/model.ts"
import { covers } from "../threads/infer.ts"
import { overlapping, WHOLE } from "./outline.ts"
import { Gate, type Clock } from "./gate.ts"
import * as C from "./conflict.ts"

export type Edit = { file: string; symbols: string[]; pending: string[]; diff: string }

/** What a held message for a local session needs. */
export type LocalMessage = {
  id: string
  kind: "heads-up" | "conflict"
  from: string
  fromSession: string
  text: string
  slices: Slice[]
  threads: string[]
  /**
   * Handed to the session's agent by itself (the mod's own-thread path),
   * rather than held as a card for the person. Set only for what this machine
   * decided, or what came from someone who is in the thread it is about.
   */
  auto?: boolean
}

/** What the coordinator decided about a peer's frame before it reached here. */
export type Screen = { auto: boolean }

type Known = { repo: string; name: string; label: string; files: Record<string, { symbols: string[]; at: number }> }

type State = { v: 1; pending: Record<string, Known>; conflicts: Record<string, C.Conflict> }

export type WarnDeps = {
  me: string
  label: string
  threads: ThreadService
  peers: () => Record<string, Peer>
  presence: () => Map<string, { sessions: SessionPresence[]; at: number }>
  send: (label: string, env: Envelope) => unknown
  deliver: (sessionId: string, m: LocalMessage) => void
  /** Raise the "who changes it?" question to the people, in these sessions. */
  ask: (sessionIds: string[], c: C.Conflict) => void
  log: (...a: unknown[]) => void
  /** Local sessions by name, for a heads-up to a peer session that is in no thread. */
  sessionsNamed?: (name: string) => string[]
  file: string
  rateMs?: number
  clock?: Clock
  now?: () => number
}

type Target = { thread: string; name: string; labels: Set<string>; local: Set<string>; toSession?: string }

type Batch = { edit: Edit; from: { sessionId: string; name: string; threads: string[]; names: string[] }; repo: string; target: Target }

const MAX_FILES_PER_THREAD = 200

export class WarnService {
  private st: State
  private gate: Gate<Batch>

  constructor(private d: WarnDeps) {
    this.st = this.load()
    this.gate = new Gate<Batch>(d.rateMs ?? Number(process.env.CROSSTALK_WARN_RATE_MS ?? 60_000), (_k, items) => this.sendHeadsUp(items), d.clock)
  }

  private now = () => (this.d.now ? this.d.now() : Date.now())

  private load(): State {
    try {
      const s = JSON.parse(fs.readFileSync(this.d.file, "utf8"))
      if (s?.v === 1) return { v: 1, pending: s.pending ?? {}, conflicts: s.conflicts ?? {} }
    } catch {}
    return { v: 1, pending: {}, conflicts: {} }
  }

  private save() {
    fs.mkdirSync(path.dirname(this.d.file), { recursive: true, mode: 0o700 })
    const tmp = `${this.d.file}.${process.pid}.tmp`
    fs.writeFileSync(tmp, JSON.stringify(this.st), { mode: 0o600 })
    fs.renameSync(tmp, this.d.file)
  }

  conflict = (id: string) => this.st.conflicts[id]
  conflicts = () => Object.values(this.st.conflicts)

  private labelOf(fp: string) {
    return Object.values(this.d.peers()).find((p) => p.fingerprint === fp)?.label
  }

  private record(thread: string, k: Omit<Known, "files">, file: string, symbols: string[]) {
    const known = (this.st.pending[thread] ??= { ...k, files: {} })
    Object.assign(known, { repo: k.repo || known.repo, name: k.name || known.name, label: k.label || known.label })
    if (symbols.length) known.files[file] = { symbols: [...new Set(symbols)], at: this.now() }
    else delete known.files[file]
    const names = Object.keys(known.files)
    if (names.length > MAX_FILES_PER_THREAD)
      for (const n of names.sort((a, b) => known.files[a].at - known.files[b].at).slice(0, names.length - MAX_FILES_PER_THREAD)) delete known.files[n]
  }

  /** Who else works on `file`, by thread. */
  targets(repo: string, file: string, mine: string[], selfSession?: string): Target[] {
    const out = new Map<string, Target>()
    const get = (thread: string, name: string) => out.get(thread) ?? out.set(thread, { thread, name, labels: new Set(), local: new Set() }).get(thread)!
    const mineSet = new Set(mine)
    for (const row of this.d.threads.list()) {
      const t = this.d.threads.thread(row.id)
      if (!t || !M.isLive(t) || t.meta.value.repo !== repo || mineSet.has(t.id)) continue
      const files = M.ids(t, "files")
      if (!files.some((f) => covers(f, file)) && !this.st.pending[t.id]?.files[file]) continue
      const tg = get(t.id, t.meta.value.name)
      for (const sid of this.d.threads.sessionsIn([t.id])) if (sid !== selfSession) tg.local.add(sid)
      for (const fp of M.people(t)) {
        if (fp === this.d.me) continue
        const l = this.labelOf(fp)
        if (l) tg.labels.add(l)
      }
    }
    for (const [label, pr] of this.d.presence()) {
      if (!this.d.peers()[label]) continue
      for (const ps of pr.sessions ?? []) {
        const fp = ps.footprint
        if (!fp?.repo || fp.repo !== repo || !(fp.paths ?? []).includes(file)) continue
        const ids = (ps.threads ?? []).filter((t) => typeof t === "string")
        if (ids.some((t) => mineSet.has(t))) continue
        if (!ids.length) {
          const tg = get(`session:${label}:${ps.name}`, ps.name)
          tg.labels.add(label)
          tg.toSession = ps.name
          continue
        }
        for (const id of ids) get(id, this.st.pending[id]?.name ?? this.d.threads.thread(id)?.meta.value.name ?? ps.name).labels.add(label)
      }
    }
    for (const [id, k] of Object.entries(this.st.pending)) {
      if (mineSet.has(id) || k.repo !== repo || !k.files[file] || !k.label || k.label === this.d.label) continue
      if (!this.d.peers()[k.label]) continue
      get(id, k.name).labels.add(k.label)
    }
    return [...out.values()].filter((t) => t.labels.size || t.local.size)
  }

  /**
   * Whether an edit to `file` by this session would matter to anyone: another
   * thread works on it, or one of this session's own threads already has
   * unmerged edits recorded there (kept current for conflict detection).
   */
  shares(repo: string, file: string, sessionId: string): boolean {
    const mine = this.d.threads.idsFor(sessionId)
    if (mine.some((id) => this.st.pending[id]?.files[file])) return true
    return this.targets(repo, file, mine, sessionId).length > 0
  }

  /** A local session edited a file. */
  edited(o: { sessionId: string; name: string; repo: string; edit: Edit }) {
    const { edit, repo } = o
    const mine = this.d.threads.idsFor(o.sessionId)
    const names = mine.map((id) => this.d.threads.thread(id)?.meta.value.name ?? id)
    mine.forEach((id, i) => this.record(id, { repo, name: names[i], label: this.d.label }, edit.file, edit.pending))
    // Conflicts first, so this side names them before the heads-up makes the other side find them too.
    const conflicts = mine.length ? this.detect(repo, edit.file, mine[0], names[0], this.d.label, edit.pending) : []
    const targets = this.targets(repo, edit.file, mine, o.sessionId)
    for (const target of targets)
      this.gate.offer(`${edit.file}|${target.thread}`, { edit, from: { sessionId: o.sessionId, name: o.name, threads: mine, names }, repo, target })
    this.save()
    return { warned: targets.map((t) => t.name), conflicts: conflicts.map((c) => c.id) }
  }

  /** Coalesced edits for one (file, thread): one heads-up. */
  private sendHeadsUp(items: Batch[]) {
    const last = items[items.length - 1]
    const { target, repo, from } = last
    const file = last.edit.file
    const symbols = [...new Set(items.flatMap((i) => i.edit.symbols))]
    const where = symbols.includes(WHOLE) ? file : `${file} (${symbols.join(", ")})`
    const text =
      `heads-up: ${this.d.label}/${from.name}${from.names.length ? ` in ${from.names.join(", ")}` : ""} changed ${where}` +
      `${items.length > 1 ? ` ${items.length} times` : ""}, which ${target.name} also works on. The diff is attached as a slice. ` +
      `Nobody needs to answer this: check whether it affects your work, and raise a question only if it needs a decision.`
    const slice = makeSlice(`diff of ${file}`, last.edit.diff)
    const warn = { repo, file, symbols, pending: last.edit.pending, fromThreads: from.threads, fromNames: from.names, target: target.thread }
    for (const sid of target.local)
      this.d.deliver(sid, { id: crypto.randomUUID(), kind: "heads-up", from: this.d.label, fromSession: from.name, text, slices: [slice], threads: [target.thread], auto: true })
    for (const label of target.labels)
      this.d.send(label, this.envelope(label, "heads-up", text, target, { warn, slices: [slice], fromSession: from.name }))
    this.d.log(`heads-up about ${file} to ${target.name} (${[...target.local].length} here, ${[...target.labels].join(", ") || "nobody"} remote)`)
  }

  private envelope(label: string, kind: "heads-up" | "conflict", text: string, target: { thread: string; toSession?: string }, o: { warn: unknown; slices?: Slice[]; fromSession?: string }): Envelope {
    return {
      v: 1,
      id: crypto.randomUUID(),
      ts: this.now(),
      from: this.d.label,
      fromSession: o.fromSession ?? "-",
      to: label,
      ...(target.toSession ? { toSession: target.toSession } : {}),
      kind,
      intent: "fyi",
      text,
      ...(o.slices ? { slices: o.slices } : {}),
      threads: target.thread.startsWith("session:") ? [] : [target.thread],
      warn: o.warn,
    }
  }

  /**
   * A heads-up decided elsewhere (src/threads/crossrepo.ts: a library's
   * surface changed): to these local sessions, and to these peers as an
   * ordinary heads-up their acceptHeadsUp delivers to the thread.
   */
  relay(o: { thread: string; local: string[]; labels: string[]; text: string; diff: { label: string; content: string }; warn: Record<string, unknown>; fromSession: string }) {
    const slice = makeSlice(o.diff.label, o.diff.content)
    for (const sid of o.local)
      this.d.deliver(sid, { id: crypto.randomUUID(), kind: "heads-up", from: this.d.label, fromSession: o.fromSession, text: o.text, slices: [slice], threads: [o.thread], auto: true })
    for (const label of o.labels) this.d.send(label, this.envelope(label, "heads-up", o.text, { thread: o.thread }, { warn: o.warn, slices: [slice], fromSession: o.fromSession }))
  }

  /** Whether a peer is in one of our threads here: a live person in it, never one taken out. */
  private memberOf(label: string, thread: string): boolean {
    const fp = this.d.peers()[label]?.fingerprint
    const t = fp ? this.d.threads.thread(thread) : undefined
    return !!t && t.id === thread && M.people(t).includes(fp!)
  }

  /**
   * A heads-up from a peer. It goes to the sessions in the threads it names;
   * it is handed to their agent by itself only for a thread the sender is in
   * here, and when the coordinator's screen (their level, mutes, not an agent)
   * allows it. Anything else, including a heads-up for a session it names
   * rather than a thread, is held as an ordinary card for the person.
   */
  acceptHeadsUp(label: string, env: Envelope, screen: Screen = { auto: false }) {
    const w = env.warn as any
    if (!w || typeof w.file !== "string" || typeof w.repo !== "string") return this.d.log(`ignored a malformed heads-up from ${label}`)
    const fromThreads: string[] = Array.isArray(w.fromThreads) ? w.fromThreads.filter((x: unknown) => typeof x === "string").slice(0, 10) : []
    const fromNames: string[] = Array.isArray(w.fromNames) ? w.fromNames.map(String) : []
    const pending: string[] = Array.isArray(w.pending) ? w.pending.map(String).slice(0, 100) : []
    fromThreads.forEach((id, i) => this.record(id, { repo: w.repo, name: M.slug(fromNames[i] ?? id), label }, w.file, pending))
    const targets = [...new Set((env.threads ?? []).filter((t) => typeof t === "string").slice(0, 20).map((t) => this.d.threads.resolve(t)))]
    const delivered = new Set<string>()
    for (const t of targets) {
      const auto = screen.auto && this.memberOf(label, t)
      for (const sid of this.d.threads.sessionsIn([t])) {
        if (delivered.has(sid)) continue
        // Only a session working in the repository it is about: never one in another project.
        const repo = this.d.threads.repoOfSession?.(sid)
        if (repo && repo !== w.repo) continue
        delivered.add(sid)
        this.d.deliver(sid, { id: env.id, kind: "heads-up", from: label, fromSession: env.fromSession, text: env.text, slices: env.slices ?? [], threads: auto ? [t] : [], auto })
      }
    }
    if (!delivered.size && env.toSession)
      for (const sid of this.byName(env.toSession)) {
        delivered.add(sid)
        this.d.deliver(sid, { id: env.id, kind: "heads-up", from: label, fromSession: env.fromSession, text: env.text, slices: env.slices ?? [], threads: [], auto: false })
      }
    // Our own unmerged edits to the same symbols: a conflict, seen from this side.
    if (fromThreads[0])
      for (const mine of targets) {
        const k = this.st.pending[mine]
        if (!k?.files[w.file]) continue
        this.detect(w.repo, w.file, mine, k.name, this.d.label, k.files[w.file].symbols, fromThreads[0])
      }
    this.save()
    this.d.log(`heads-up from ${label} about ${w.file} to ${delivered.size} session(s)`)
  }

  private byName(name: string): string[] {
    return this.d.sessionsNamed?.(name) ?? []
  }

  /** Conflicts between `mine` and any other thread with unmerged edits to the same symbols of `file`. */
  private detect(repo: string, file: string, mine: string, mineName: string, mineLabel: string, symbols: string[], only?: string): C.Conflict[] {
    const made: C.Conflict[] = []
    for (const [other, k] of Object.entries(this.st.pending)) {
      if (other === mine || (only && other !== only) || k.repo !== repo) continue
      const theirs = k.files[file]?.symbols ?? []
      if (!theirs.length) continue
      for (const symbol of overlapping(symbols, theirs)) {
        const a: C.Side = { thread: mine, name: mineName, label: mineLabel }
        const b: C.Side = { thread: other, name: k.name, label: k.label }
        const id = C.conflictId(repo, file, symbol, mine, other)
        if (this.st.conflicts[id]) continue
        const c = C.newConflict({ repo, file, symbol, a, b, now: this.now() })
        this.st.conflicts[id] = c
        made.push(c)
        this.announce(c)
      }
    }
    return made
  }

  private conflictText(c: C.Conflict, to: C.Side): string {
    const o = C.other(c, to.thread)
    const what = c.symbol === WHOLE ? c.file : `${c.symbol} in ${c.file}`
    return (
      `conflict ahead: ${what} has unmerged edits in both ${to.name} (here) and ${o.name} (${o.label}). ` +
      `Agree who changes it before either merges: call crosstalk_thread action "note" kind "conflict" with id ${c.id} and owner "mine" (${to.name} changes it and ${o.name} rebases onto it) or "theirs" (the other way round), with a line of why. ` +
      `It is recorded as a decision in ${to.name}. The people are asked only if the two of you cannot agree.`
    )
  }

  /** Tell both sides. A side on this machine is told here; the other through its people. */
  private announce(c: C.Conflict) {
    for (const s of c.sides) this.tellSide(c, s, "conflict", this.conflictText(c, s), {})
    this.d.log(`conflict ${c.id}: ${c.symbol} in ${c.file} between ${c.sides.map((s) => s.name).join(" and ")}`)
  }

  private localSessions(thread: string) {
    return this.d.threads.sessionsIn([thread])
  }

  private isLocalSide = (s: C.Side) => s.label === this.d.label

  private tellSide(c: C.Conflict, s: C.Side, kind: "conflict", text: string, extra: Record<string, unknown>) {
    if (this.isLocalSide(s)) {
      for (const sid of this.localSessions(s.thread))
        this.d.deliver(sid, { id: crypto.randomUUID(), kind, from: "crosstalk", fromSession: "-", text, slices: [], threads: [s.thread], auto: true })
      return
    }
    if (!this.d.peers()[s.label]) return
    this.d.send(s.label, this.envelope(s.label, kind, text, { thread: s.thread }, { warn: { conflict: c, ...extra } }))
  }

  /** A conflict frame from a peer: a new conflict, a proposal, or what the people decided. */
  acceptConflict(label: string, env: Envelope, screen: Screen = { auto: false }) {
    const w = env.warn as any
    const inc = w?.conflict as C.Conflict | undefined
    if (!inc || typeof inc.id !== "string" || !Array.isArray(inc.sides) || inc.sides.length !== 2) return this.d.log(`ignored a malformed conflict from ${label}`)
    const theirSide = inc.sides.find((s) => s.label === label)
    const mySide = inc.sides.find((s) => s.label === this.d.label)
    if (!theirSide || !mySide) return this.d.log(`ignored conflict ${inc.id} from ${label}: not between us`)
    let c = this.st.conflicts[inc.id]
    // Handed over by itself only when they are in the thread it names as ours.
    const auto = screen.auto && this.memberOf(label, mySide.thread)
    const fresh = !c
    if (!c) {
      c = { ...C.newConflict({ repo: String(inc.repo), file: String(inc.file), symbol: String(inc.symbol), a: mySide, b: theirSide, now: this.now() }), id: inc.id }
      this.st.conflicts[c.id] = c
      for (const sid of this.localSessions(mySide.thread))
        this.d.deliver(sid, { id: env.id, kind: "conflict", from: label, fromSession: env.fromSession, text: this.conflictText(c, mySide), slices: [], threads: auto ? [mySide.thread] : [], auto })
    }
    // A conflict first heard from them, about a thread they are not in here,
    // writes nothing into that thread: they cannot decide for it.
    const may = !fresh || this.memberOf(label, mySide.thread)
    if (may && w.proposal && typeof w.proposal.owner === "string") this.onProposal(c, theirSide.thread, w.proposal as C.Proposal)
    if (may && typeof w.decided === "string") this.onDecided(c, w.decided, label, auto)
    this.save()
  }

  /**
   * This session's agent proposes who changes the symbol. Recorded as a
   * decision in its thread, sent to the other side.
   */
  propose(sessionId: string, o: { id: string; owner: string; text?: string }): { ok: boolean; error?: string; outcome?: C.Outcome; text?: string } {
    const c = this.st.conflicts[o.id]
    if (!c) return { ok: false, error: `no conflict ${o.id}` }
    const mine = this.d.threads.idsFor(sessionId)
    const from = c.sides.find((s) => mine.includes(s.thread)) ?? c.sides.find((s) => this.isLocalSide(s))
    if (!from) return { ok: false, error: "this session is in neither thread of that conflict" }
    const owner = C.ownerOf(c, from.thread, o.owner)
    if (!owner) return { ok: false, error: `owner is "mine", "theirs", or one of ${c.sides.map((s) => s.name).join(", ")}` }
    const p: C.Proposal = { owner, text: String(o.text ?? "").slice(0, 400), at: this.now(), by: this.d.label }
    const ownerName = C.side(c, owner)!.name
    const otherName = C.other(c, owner).name
    this.d.threads.decide(sessionId, {
      text: `Proposed for ${c.symbol} in ${c.file}: ${ownerName} changes it and ${otherName} rebases onto it.${p.text ? ` ${p.text}` : ""}`,
      thread: from.thread,
    })
    const outcome = this.onProposal(c, from.thread, p)
    const to = C.other(c, from.thread)
    if (this.isLocalSide(to)) {
      for (const sid of this.localSessions(to.thread))
        this.d.deliver(sid, { id: crypto.randomUUID(), kind: "conflict", from: this.d.label, fromSession: from.name, text: `${from.name} proposes, for ${c.symbol} in ${c.file} (conflict ${c.id}): ${ownerName} changes it and ${otherName} rebases onto it.${p.text ? ` "${p.text}"` : ""} Answer with crosstalk_thread action "note" kind "conflict".`, slices: [], threads: [to.thread], auto: true })
    } else if (this.d.peers()[to.label])
      this.d.send(to.label, this.envelope(to.label, "conflict", `${from.name} proposes, for ${c.symbol} in ${c.file} (conflict ${c.id}): ${ownerName} changes it and ${otherName} rebases onto it.${p.text ? ` "${p.text}"` : ""} Answer with crosstalk_thread action "note" kind "conflict".`, { thread: to.thread }, { warn: { conflict: c, proposal: { ...p, from: from.thread } } }))
    this.save()
    return { ok: true, outcome, text: outcomeText(c, outcome) }
  }

  private onProposal(c: C.Conflict, from: string, p: C.Proposal): C.Outcome {
    const outcome = C.propose(c, from, p)
    if (outcome === "agreed") {
      const ownerName = C.side(c, c.owner!)!.name
      for (const s of c.sides)
        if (this.isLocalSide(s))
          for (const sid of this.localSessions(s.thread))
            this.d.deliver(sid, { id: crypto.randomUUID(), kind: "conflict", from: "crosstalk", fromSession: "-", text: `agreed for ${c.symbol} in ${c.file}: ${ownerName} changes it, the other thread rebases onto it.`, slices: [], threads: [s.thread], auto: true })
    }
    if (outcome === "ask") {
      const here = c.sides.filter((s) => this.isLocalSide(s)).flatMap((s) => this.localSessions(s.thread))
      this.d.ask([...new Set(here)], c)
    }
    return outcome
  }

  /** The people's answer, from the picker here. Sent to the other side, recorded in our thread. */
  decide(sessionId: string | undefined, id: string, ownerName: string): { ok: boolean; error?: string; text?: string } {
    const c = this.st.conflicts[id]
    if (!c) return { ok: false, error: `no conflict ${id}` }
    const owner = c.sides.find((s) => s.name === ownerName || s.thread === ownerName)?.thread
    if (!owner) return { ok: false, error: `pick one of ${c.sides.map((s) => s.name).join(", ")}` }
    if (!C.decide(c, owner)) return { ok: true, text: "already decided" }
    const mySide = c.sides.find((s) => this.isLocalSide(s))
    const text = `Decided for ${c.symbol} in ${c.file}: ${C.side(c, owner)!.name} changes it and ${C.other(c, owner).name} rebases onto it.`
    if (mySide) this.d.threads.decide(sessionId, { text, thread: mySide.thread })
    for (const s of c.sides)
      if (!this.isLocalSide(s) && this.d.peers()[s.label])
        this.d.send(s.label, this.envelope(s.label, "conflict", text, { thread: s.thread }, { warn: { conflict: c, decided: owner } }))
    this.save()
    return { ok: true, text }
  }

  private onDecided(c: C.Conflict, owner: string, label: string, auto: boolean) {
    if (!C.decide(c, owner)) return
    const mySide = c.sides.find((s) => this.isLocalSide(s))
    if (!mySide) return
    const text = `Decided for ${c.symbol} in ${c.file} (by ${label}): ${C.side(c, owner)!.name} changes it and ${C.other(c, owner).name} rebases onto it.`
    this.d.threads.decide(undefined, { text, thread: mySide.thread })
    for (const sid of this.localSessions(mySide.thread))
      this.d.deliver(sid, { id: crypto.randomUUID(), kind: "conflict", from: label, fromSession: "-", text, slices: [], threads: auto ? [mySide.thread] : [], auto })
  }

  /** Forget what was merged: a thread with no unmerged edits to a file says so with its next heads-up. */
  list(sessionId?: string) {
    const mine = sessionId ? new Set(this.d.threads.idsFor(sessionId)) : undefined
    return this.conflicts()
      .filter((c) => !mine || c.sides.some((s) => mine.has(s.thread)))
      .map((c) => ({ id: c.id, file: c.file, symbol: c.symbol, between: c.sides.map((s) => `${s.name} (${s.label})`), state: c.state, owner: c.owner ? C.side(c, c.owner)?.name : undefined }))
  }
}

function outcomeText(c: C.Conflict, o: C.Outcome): string {
  switch (o) {
    case "waiting":
      return "Proposed. Waiting for the other thread's agent."
    case "agreed":
      return `Agreed: ${C.side(c, c.owner!)!.name} changes ${c.symbol}.`
    case "ask":
      return "The two threads still disagree, so the people have been asked."
    case "disagree":
      return "The other thread proposed the opposite. Reconsider, or keep your proposal; the people are asked if it stays split."
    default:
      return `Already settled: ${c.owner ? C.side(c, c.owner)?.name : "?"} changes it.`
  }
}

function makeSlice(label: string, content: string): Slice {
  return {
    kind: "diff",
    label,
    content,
    bytes: Buffer.byteLength(content, "utf8"),
    sha256: crypto.createHash("sha256").update(content).digest("hex").slice(0, 16),
  }
}
