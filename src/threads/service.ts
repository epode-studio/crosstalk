// Threads in the daemon: found from sessions, synced live, committed on change.
//
// The daemon owns one ThreadService. It hands it every local session as it
// registers (observe), every peer's presence (peerPresence) and every thread
// frame (accept), and asks it where a message goes (sessionsIn) and who a
// message without a recipient is for (recipients).
//
// Three copies of a thread exist, and they settle into one:
//
//   this replica    ~/.claude/crosstalk/threads.json, the working copy
//   the relay       a "thread" envelope to each of the thread's people on every
//                   change, sealed pairwise like any other envelope
//   the git ref     refs/crosstalk/threads, a commit only when status,
//                   features, decisions, questions or rules changed, written a
//                   moment later so frames in flight settle first
//
// Merging is the CRDT in model.ts, so it does not matter which copy arrives
// first or twice.
//
// Trust: a thread frame is accepted only from a direct peer (someone this
// machine shares a channel with) who is in the thread, and only into a thread
// we are in or that names us. Peer text in a thread reaches an agent only
// through crosstalk_thread_read, framed as other people's words.

import fs from "node:fs"
import path from "node:path"
import crypto from "node:crypto"
import { fingerprint } from "../crypto.ts"
import type { Identity, Peer } from "../config.ts"
import type { Envelope, SessionPresence } from "../protocol.ts"
import { parseSummary } from "../footprint.ts"
import * as M from "./model.ts"
import * as F from "./format.ts"
import * as S from "./store.ts"
import * as I from "./infer.ts"
import { sealSection, unwrapKey, wrapKey, newKey } from "./seal.ts"
import { botSafe } from "../ui-extra/bots.ts"

export type LocalSession = {
  sessionId: string
  name: string
  cwd: string
  repo?: string
  branch?: string
  root?: string
  /** Repo-relative, most recent first. */
  paths: string[]
}

export type Deps = {
  identity: Identity
  /** Direct peers by label: the trust set until repo trust lands. */
  peers: () => Record<string, Peer>
  send: (label: string, env: Envelope) => unknown
  log: (...a: unknown[]) => void
  file: string
  /** How long a change waits before it is committed, so the relay copy settles first. */
  settleMs?: number
  /** Push and fetch the ref. Off, it is still committed locally. */
  network?: boolean
  fadeDays?: number
  now?: () => number
  /**
   * Another file on the ref that is not a thread (RULES.md, src/rules/doc.ts):
   * read when the ref is merged, written with every commit.
   */
  extra?: { file: string; read: (repo: string, text: string) => void; render: (repo: string) => string | undefined }
  /** Threads that changed, after each save: what a standing rule may answer (src/coordinator.ts). */
  onFlush?: (ids: string[]) => void
}

/** Where a local session was placed. `name` is how its thread entry is keyed, the same way a peer sees it in presence. */
type Placed = { threads: string[]; why: Record<string, string>; pinned?: string[]; name?: string }
type Note = { id: string; text: string }

type State = {
  v: 1
  threads: Record<string, M.Thread>
  keys: Record<string, string>
  committed: Record<string, string>
  placed: Record<string, Placed>
  banner: Record<string, { name: string; why: string }[]>
  notes: Record<string, Note[]>
  questions: Record<string, { candidates: string[]; why: string; at: number }>
  noticed: string[]
  opaque: Record<string, Record<string, string>>
  roots: Record<string, string>
  publicStatus: Record<string, Record<string, string>>
  blobs: Record<string, { h: string; b: string }>
}

const empty = (): State => ({
  v: 1,
  threads: {},
  keys: {},
  committed: {},
  placed: {},
  banner: {},
  notes: {},
  questions: {},
  noticed: [],
  opaque: {},
  roots: {},
  publicStatus: {},
  blobs: {},
})

/** Files a thread keeps. A thread is about now, so the oldest fall off. */
const MAX_FILES = 60
/** How often a session's presence in a thread is refreshed, which is also an edit. */
const SESSION_REFRESH_MS = 10 * 60_000
/** A peer's session counts as there for this long after its presence said so. */
const PEER_SESSION_MS = 24 * 60 * 60_000
const DAY = 24 * 60 * 60_000

export const NEW_THREAD = "New thread"
export const NO_THREAD = "No thread"

export class ThreadService {
  private st: State
  private locals = new Map<string, LocalSession>()
  private touched = new Set<string>()
  /** Peers whose daemon said it knows threads. Nobody else is sent a frame they would show as a blank message. */
  private capable = new Set<string>()
  private timers = new Map<string, ReturnType<typeof setTimeout>>()
  private syncing = new Map<string, Promise<void>>()
  private defaults = new Map<string, { at: number; v?: string }>()
  private refspecDone = new Set<string>()
  /** Every local clone of each repo, this process. */
  private clones = new Map<string, Set<string>>()
  /** Clones whose local ref has been read since this process started. */
  private readLocal = new Set<string>()
  /** Sessions kept out of every thread: the main session (src/main.ts). */
  private outside = new Set<string>()
  readonly me: string
  readonly label: string

  constructor(private d: Deps) {
    this.me = fingerprint(d.identity.ed.pub)
    this.label = d.identity.label
    this.st = this.load()
  }

  private now = () => (this.d.now ? this.d.now() : Date.now())

  // --- persistence ---------------------------------------------------------------

  private load(): State {
    try {
      const raw = JSON.parse(fs.readFileSync(this.d.file, "utf8"))
      if (raw?.v !== 1) return empty()
      const st = { ...empty(), ...raw } as State
      for (const [id, t] of Object.entries(st.threads)) {
        const ok = M.parseThread(t)
        if (ok) st.threads[id] = ok
        else delete st.threads[id]
      }
      return st
    } catch {
      return empty()
    }
  }

  private save() {
    fs.mkdirSync(path.dirname(this.d.file), { recursive: true, mode: 0o700 })
    const tmp = `${this.d.file}.${process.pid}.tmp`
    fs.writeFileSync(tmp, JSON.stringify(this.st), { mode: 0o600 })
    fs.renameSync(tmp, this.d.file)
  }

  // --- reading -----------------------------------------------------------------

  thread(id: string): M.Thread | undefined {
    return this.st.threads[this.resolve(id)]
  }

  /** Follow combines to the thread that holds the work now. */
  resolve(id: string): string {
    let cur = id
    for (let i = 0; i < 10; i++) {
      const next = this.st.threads[cur]?.meta.value.combinedInto
      if (!next || !this.st.threads[next]) break
      cur = next
    }
    return cur
  }

  private lite(t: M.Thread): I.ThreadLite {
    return {
      id: t.id,
      name: t.meta.value.name,
      repo: t.meta.value.repo,
      live: M.isLive(t),
      branches: M.ids(t, "branches"),
      files: M.ids(t, "files"),
      createdAt: t.meta.value.createdAt,
      combinedInto: t.meta.value.combinedInto,
    }
  }

  private lites(repo?: string) {
    return Object.values(this.st.threads)
      .filter((t) => !repo || t.meta.value.repo === repo)
      .map((t) => this.lite(t))
  }

  /** The threads a local session is in, after combines. */
  idsFor(sessionId: string): string[] {
    const p = this.st.placed[sessionId]
    if (!p) return []
    return [...new Set(p.threads.map((id) => this.resolve(id)))].filter((id) => this.st.threads[id])
  }

  namesFor(sessionId: string): string[] {
    return this.idsFor(sessionId).map((id) => this.st.threads[id].meta.value.name)
  }

  /** `auth · tokens · api`: the session's threads before its own name. */
  title(sessionId: string, name: string): string | undefined {
    const names = this.namesFor(sessionId)
    return names.length ? `${names.slice(0, 2).join(" · ")} · ${name}` : undefined
  }

  /** Local sessions in any of these threads. */
  sessionsIn(threadIds: string[]): string[] {
    const want = new Set(threadIds.map((id) => this.resolve(id)))
    return [...this.locals.keys()].filter((sid) => this.idsFor(sid).some((id) => want.has(id)))
  }

  /** Who a message from this session with no named recipient goes to: the people in its threads. */
  recipients(sessionId: string): { threads: string[]; labels: string[] } {
    const threads = this.idsFor(sessionId)
    const fps = new Set(threads.flatMap((id) => M.ids(this.st.threads[id], "people")))
    fps.delete(this.me)
    const labels = Object.values(this.d.peers())
      .filter((p) => fps.has(p.fingerprint))
      .map((p) => p.label)
    return { threads, labels: [...new Set(labels)] }
  }

  /** What the hook and the mod show for one session. Consuming takes the banner and notices once. */
  forSession(sessionId: string, name: string, consume: boolean, takeNotes = consume) {
    const ids = this.idsFor(sessionId)
    const out = {
      threads: ids.map((id) => {
        const t = this.st.threads[id]
        return {
          id,
          name: t.meta.value.name,
          status: t.meta.value.status,
          people: M.live(t, "people").map((p) => p.label),
          why: this.st.placed[sessionId]?.why[id],
          questions: M.live(t, "questions").filter((q) => !q.answer).length,
        }
      }),
      title: this.title(sessionId, name),
      banner: (this.st.banner[sessionId] ?? []).map((b) => `${b.name} (${b.why})`),
      notes: takeNotes ? (this.st.notes[sessionId] ?? []).map((n) => n.text) : [],
      question: this.question(sessionId),
    }
    if ((consume && this.st.banner[sessionId]?.length) || (takeNotes && this.st.notes[sessionId]?.length)) {
      if (consume) delete this.st.banner[sessionId]
      if (takeNotes) delete this.st.notes[sessionId]
      this.save()
    }
    return out
  }

  /** Notices for a session, taken once (the mod's toasts). */
  takeNotes(sessionId: string): Note[] {
    const n = this.st.notes[sessionId] ?? []
    if (n.length) {
      delete this.st.notes[sessionId]
      this.save()
    }
    return n
  }

  /** An open "which thread is this?" question for a session, as a picker would ask it. */
  question(sessionId: string): { id: string; question: string; options: string[] } | undefined {
    const q = this.st.questions[sessionId]
    if (!q) return undefined
    const names = q.candidates.map((id) => this.st.threads[id]?.meta.value.name).filter((n): n is string => !!n)
    if (names.length < 2) return undefined
    const s = this.locals.get(sessionId)
    return {
      id: `thread:${sessionId}:${q.at}`,
      question: `${s?.name ?? "This session"} ${q.why}. Which thread is it part of?`,
      options: [...names.slice(0, 3), NEW_THREAD, NO_THREAD],
    }
  }

  /** A thread by name or id, from this session's own first. */
  find(sessionId: string | undefined, nameOrId?: string): M.Thread | undefined {
    const mine = sessionId ? this.idsFor(sessionId).map((id) => this.st.threads[id]) : []
    if (!nameOrId) return mine[0]
    const n = M.slug(nameOrId)
    const all = [...mine, ...Object.values(this.st.threads).filter((t) => !t.meta.value.combinedInto)]
    const t = all.find((t) => t.id === nameOrId || t.meta.value.name === n) ?? all.find((t) => t.meta.value.name.startsWith(n))
    return t ? this.st.threads[this.resolve(t.id)] : undefined
  }

  list() {
    return Object.values(this.st.threads)
      .filter((t) => !t.meta.value.combinedInto)
      .map((t) => ({
        id: t.id,
        name: t.meta.value.name,
        status: t.meta.value.status,
        public: t.meta.value.public,
        repo: t.meta.value.repo,
        people: M.live(t, "people").map((p) => p.label),
      }))
  }

  /** The fingerprints of everyone in any thread of a repo: who its rules are sealed to. */
  peopleIn(repo: string): string[] {
    const out = new Set<string>()
    for (const t of Object.values(this.st.threads)) if (t.meta.value.repo === repo) for (const p of M.people(t)) out.add(p)
    return [...out]
  }

  /** Something else on this repo's ref changed (RULES.md): commit and push it soon. */
  touchRepo(repo: string) {
    this.schedule(repo)
  }

  /** Keep a session out of every thread, or let it be placed again. */
  setOutside(sessionId: string, on: boolean) {
    if (on) this.outside.add(sessionId)
    else this.outside.delete(sessionId)
    const s = this.locals.get(sessionId)
    if (s) this.place(s)
    this.flush()
  }

  // --- local sessions ----------------------------------------------------------

  /** Place a local session from its footprint. Cheap when nothing changed, which is most calls. */
  observe(s: LocalSession) {
    this.locals.set(s.sessionId, s)
    this.place(s)
    this.flush()
  }

  /** A session that ended leaves its threads, which then fade if nobody else is in them. */
  forget(sessionId: string) {
    const p = this.st.placed[sessionId]
    this.locals.delete(sessionId)
    if (!p) return
    for (const id of p.threads) {
      const t = this.st.threads[this.resolve(id)]
      if (t && M.remove(t, "sessions", `${this.me}:${p.name ?? sessionId}`, this.me, this.now())) this.touched.add(t.id)
    }
    delete this.st.placed[sessionId]
    delete this.st.questions[sessionId]
    this.flush()
  }

  /** Sessions that ended while no daemon was running leave their threads too. */
  retain(live: string[]) {
    const keep = new Set(live)
    for (const sid of Object.keys(this.st.placed)) if (!keep.has(sid)) this.forget(sid)
  }

  private onDefault(s: LocalSession): boolean {
    if (!s.root) return I.isDefaultBranch(s.branch)
    let c = this.defaults.get(s.root)
    if (!c || this.now() - c.at > 10 * 60_000) {
      c = { at: this.now(), v: S.defaultBranch(s.root) }
      this.defaults.set(s.root, c)
    }
    return I.isDefaultBranch(s.branch, c.v)
  }

  private footprint(s: LocalSession): I.Footprint {
    return { repo: s.repo, branch: s.branch, paths: s.paths, onDefault: this.onDefault(s) }
  }

  private place(s: LocalSession): void {
    if (this.outside.has(s.sessionId)) {
      const rec = this.st.placed[s.sessionId]
      for (const id of rec?.threads ?? []) {
        const t = this.st.threads[this.resolve(id)]
        if (t && M.remove(t, "sessions", `${this.me}:${rec?.name ?? s.name}`, this.me, this.now())) this.touched.add(t.id)
      }
      if (rec) rec.threads = []
      delete this.st.questions[s.sessionId]
      return
    }
    if (!s.repo) return
    if (s.root) {
      // The first clone seen is the one the ref is written in; every clone
      // gets the refspec, so a plain fetch anywhere brings the threads.
      const cur = this.st.roots[s.repo]
      if (!cur || !fs.existsSync(cur)) this.st.roots[s.repo] = s.root
      ;(this.clones.get(s.repo) ?? this.clones.set(s.repo, new Set()).get(s.repo)!).add(s.root)
      // What a plain fetch already brought is read before anything is
      // started, so a fresh machine joins the thread rather than starting
      // a second one. Local only; the network waits for sync.
      if (!this.readLocal.has(s.root)) {
        this.readLocal.add(s.root)
        this.mergeRef(s.root, s.repo, S.REF)
        this.mergeRef(s.root, s.repo, S.SYNC_REF)
      }
    }
    const fp = this.footprint(s)
    const rec: Placed = (this.st.placed[s.sessionId] ??= { threads: [], why: {} })
    rec.name = s.name
    rec.threads = rec.threads.map((id) => this.resolve(id)).filter((id) => this.st.threads[id])
    let want: { id: string; why: string }[]
    if (rec.pinned) {
      rec.pinned = rec.pinned.map((id) => this.resolve(id)).filter((id) => this.st.threads[id])
      want = rec.pinned.map((id) => ({ id, why: rec.why[id] ?? "you chose it" }))
      // A pin from the default branch is about those files; a new branch is new work.
      if (!fp.onDefault && fp.branch && !rec.pinned.some((id) => M.ids(this.st.threads[id], "branches").includes(fp.branch!))) {
        delete rec.pinned
        return this.place(s)
      }
    } else {
      const p = I.place(fp, this.lites(s.repo))
      if (p.kind === "join") want = p.threads
      else if (p.kind === "create") {
        const t = this.createThread(s, p.name, p.why)
        if (p.branch) M.put(t, "branches", p.branch, { at: this.now() }, this.me, this.now())
        for (const f of p.files) M.put(t, "files", f, { at: this.now() }, this.me, this.now())
        want = [{ id: t.id, why: p.why }]
      } else if (p.kind === "ask") {
        const before = this.st.questions[s.sessionId]
        if (!before || before.candidates.join() !== p.candidates.join())
          this.st.questions[s.sessionId] = { candidates: p.candidates, why: p.why, at: this.now() }
        want = rec.threads.map((id) => ({ id, why: rec.why[id] ?? "" }))
      } else {
        // Nothing new to say: a session on the default branch stays where it was.
        want = fp.onDefault ? rec.threads.map((id) => ({ id, why: rec.why[id] ?? "" })) : []
      }
      // On the default branch the threads accumulate: files keep a session in each.
      if (fp.onDefault) for (const id of rec.threads) if (!want.some((w) => w.id === id)) want.push({ id, why: rec.why[id] ?? "" })
    }
    const wantIds = want.map((w) => this.resolve(w.id))
    for (const id of rec.threads)
      if (!wantIds.includes(id)) {
        const t = this.st.threads[id]
        if (t && M.remove(t, "sessions", `${this.me}:${s.name}`, this.me, this.now())) this.touched.add(id)
        delete rec.why[id]
      }
    for (const w of want) {
      const id = this.resolve(w.id)
      const t = this.st.threads[id]
      if (!t) continue
      if (!rec.threads.includes(id)) {
        ;(this.st.banner[s.sessionId] ??= []).push({ name: t.meta.value.name, why: w.why || "matched" })
        rec.why[id] = w.why
      }
      this.join(t, s, fp)
    }
    rec.threads = [...new Set(wantIds)].filter((id) => this.st.threads[id])
  }

  private createThread(s: LocalSession, name: string, why: string): M.Thread {
    const t = M.create({ name, repo: s.repo!, by: this.me, label: this.label, now: this.now() })
    this.st.threads[t.id] = t
    this.st.keys[t.id] = newKey().toString("base64")
    this.touched.add(t.id)
    this.d.log(`thread ${name} started for ${s.name}: ${why}`)
    return t
  }

  /** Put a local session in a thread: us among its people, the session, its files. */
  private join(t: M.Thread, s: LocalSession, fp: I.Footprint) {
    const now = this.now()
    let changed = false
    if (t.meta.value.status === "archived" && !t.meta.value.combinedInto) {
      // Comes back with new activity.
      changed = M.setMeta(t, this.me, { status: "active" }, now) || changed
    }
    changed = M.put(t, "people", this.me, { label: this.label }, this.me, now) || changed
    const sid = `${this.me}:${s.name}`
    const was = t.sessions[sid]
    if (!was || was.gone || was.name !== s.name || was.branch !== s.branch || now - was.at > SESSION_REFRESH_MS)
      changed = M.put(t, "sessions", sid, { person: this.me, label: this.label, name: s.name, branch: s.branch, at: now }, this.me, now) || changed
    if (fp.branch && !fp.onDefault && M.ids(t, "branches").length && !t.branches[fp.branch])
      changed = M.put(t, "branches", fp.branch, { at: now }, this.me, now) || changed
    const files = M.ids(t, "files")
    for (const p of s.paths.slice(0, 12)) {
      if (files.length >= MAX_FILES) break
      if (files.some((q) => I.covers(q, p))) continue
      changed = M.put(t, "files", p, { at: now }, this.me, now) || changed
      files.push(p)
    }
    if (changed) this.touched.add(t.id)
  }

  /** The person's answer to "which thread is this?". */
  answer(sessionId: string, pick: string): { ok: boolean; error?: string; threads?: string[] } {
    const s = this.locals.get(sessionId)
    const q = this.st.questions[sessionId]
    delete this.st.questions[sessionId]
    const rec: Placed = (this.st.placed[sessionId] ??= { threads: [], why: {} })
    if (pick === NO_THREAD) {
      rec.pinned = []
    } else if (pick === NEW_THREAD) {
      if (!s?.repo) return { ok: false, error: "this session is not in a git repo with a remote" }
      const base = M.slug(I.nameFromDir(path.posix.dirname(s.paths[0] ?? s.name)) || s.name)
      const taken = new Set(this.list().map((t) => t.name))
      let name = base
      for (let i = 2; taken.has(name); i++) name = `${base}-${i}`
      const t = this.createThread(s, name, "you asked for a new thread")
      for (const p of s.paths.slice(0, 12)) M.put(t, "files", p, { at: this.now() }, this.me, this.now())
      rec.pinned = [t.id]
      rec.why[t.id] = "you asked for a new thread"
    } else {
      const t = this.find(sessionId, pick) ?? (q ? q.candidates.map((id) => this.st.threads[id]).find((t) => t?.meta.value.name === pick) : undefined)
      if (!t) return { ok: false, error: `no thread called "${pick}". Threads: ${this.list().map((t) => t.name).join(", ") || "none"}` }
      rec.pinned = [...new Set([...(rec.pinned ?? []), t.id])]
      rec.why[t.id] = "you chose it"
    }
    if (s) this.place(s)
    this.flush()
    return { ok: true, threads: this.namesFor(sessionId) }
  }

  /** Take a session out of one thread for good (until it is placed there by hand). */
  leave(sessionId: string, nameOrId: string) {
    const t = this.find(sessionId, nameOrId)
    if (!t) return { ok: false, error: `no thread called "${nameOrId}"` }
    const rec: Placed = (this.st.placed[sessionId] ??= { threads: [], why: {} })
    rec.pinned = this.idsFor(sessionId).filter((id) => id !== t.id)
    const s = this.locals.get(sessionId)
    if (s) this.place(s)
    this.flush()
    return { ok: true, threads: this.namesFor(sessionId) }
  }

  // --- peers -------------------------------------------------------------------

  /**
   * A peer's sessions, from their presence. Any whose footprint matches one of
   * our threads joins it, and the peer is sent the thread: threads find their
   * people. Only direct peers get this far.
   */
  peerPresence(label: string, sessions: SessionPresence[] | undefined) {
    const peer = this.d.peers()[label]
    if (!peer || !Array.isArray(sessions)) return
    if (sessions.some((s) => Array.isArray(s.threads))) this.capable.add(label)
    else return
    const now = this.now()
    for (const ps of sessions) {
      const sum = parseSummary(ps.footprint)
      if (!sum?.repo) continue
      const fp: I.Footprint = {
        repo: sum.repo,
        branch: sum.branch,
        paths: sum.paths ?? [],
        // Their default branch is the same as ours: it is one repository.
        onDefault: I.isDefaultBranch(sum.branch, this.defaultFor(sum.repo)),
      }
      for (const t of Object.values(this.st.threads)) {
        if (!M.people(t).includes(this.me)) continue
        const why = I.matchesPeer(this.lite(t), fp)
        if (!why) continue
        const isNew = !t.people[peer.fingerprint] || !!t.people[peer.fingerprint].gone
        let changed = M.put(t, "people", peer.fingerprint, { label: peer.label }, this.me, now)
        if (isNew) {
          // Joining is reading: everyone in the thread hears who can now.
          const note = { id: `join:${t.id}:${peer.fingerprint}`, text: `◢ crosstalk: ${peer.label} joined ${t.meta.value.name} (${why}) and can now read it.` }
          for (const sid of this.sessionsIn([t.id])) (this.st.notes[sid] ??= []).push(note)
        }
        const sid = `${peer.fingerprint}:${ps.name}`
        const was = t.sessions[sid]
        if (!was || was.gone || was.branch !== sum.branch || now - was.at > SESSION_REFRESH_MS)
          changed = M.put(t, "sessions", sid, { person: peer.fingerprint, label: peer.label, name: ps.name, branch: sum.branch, at: now }, this.me, now) || changed
        if (changed) {
          this.d.log(`thread ${t.meta.value.name}: ${peer.label}/${ps.name} joined (${why})`)
          this.touched.add(t.id)
        }
      }
    }
    this.flush()
  }

  private defaultFor(repo: string): string | undefined {
    const root = this.st.roots[repo]
    if (!root) return undefined
    return this.defaults.get(root)?.v ?? S.defaultBranch(root)
  }

  /** A thread frame from a peer. */
  accept(label: string, env: Envelope) {
    const peer = this.d.peers()[label]
    if (!peer) return this.d.log(`ignored a thread from ${label}: no direct channel`)
    this.capable.add(label)
    const sync = env.threadSync as { thread?: unknown; key?: string } | undefined
    const inc = botSafe(label, M.parseThread(sync?.thread), this.st.threads, this.d.peers())
    if (!inc) return this.d.log(`ignored a malformed thread from ${label}`)
    const known = this.st.threads[inc.id]
    const theirPeople = M.people(inc)
    if (!theirPeople.includes(peer.fingerprint)) return this.d.log(`ignored thread ${inc.id} from ${label}: they are not in it`)
    if (!known && !theirPeople.includes(this.me)) return this.d.log(`ignored thread ${inc.id} from ${label}: it does not name us`)
    if (known && !M.people(known).includes(this.me) && !theirPeople.includes(this.me)) return
    if (typeof sync?.key === "string" && Buffer.from(sync.key, "base64").length === 32) {
      const mine = this.st.keys[inc.id]
      // Two keys for one thread converge on the smaller, so every replica agrees.
      if (!mine || sync.key < mine) this.st.keys[inc.id] = sync.key
    }
    const merged = known ? M.merge(known, inc) : inc
    if (known && M.same(known, merged)) return
    this.st.threads[inc.id] = merged
    this.touched.add(inc.id)
    this.d.log(`thread ${merged.meta.value.name} updated by ${label}`)
    this.reconcile()
    // Sent back to them too: whatever we added while placing our own sessions
    // has to reach them, and an unchanged echo stops at their merge.
    this.flush()
  }

  /** Send a thread to every peer in it, except whoever it just came from. */
  private broadcast(t: M.Thread, skip: Set<string>) {
    const people = new Set(M.people(t))
    for (const p of Object.values(this.d.peers())) {
      if (!people.has(p.fingerprint) || p.fingerprint === this.me || skip.has(p.label)) continue
      if (!this.capable.has(p.label)) continue
      this.d.send(p.label, {
        v: 1,
        id: crypto.randomUUID(),
        ts: this.now(),
        from: this.label,
        fromSession: "-",
        to: p.label,
        kind: "thread",
        intent: "fyi",
        text: "",
        threadSync: { thread: t, key: this.st.keys[t.id] },
      })
    }
  }

  // --- combine and fade ----------------------------------------------------------

  /** Combine converged threads, absorb ones a peer combined, and place every local session again. */
  private reconcile() {
    for (let round = 0; round < 5; round++) {
      let any = false
      const all = Object.values(this.st.threads)
      for (const x of all) {
        const into = x.meta.value.combinedInto
        if (into && this.st.threads[into] && !this.st.noticed.includes(x.id)) {
          this.absorb(this.st.threads[this.resolve(into)], x, `combined by ${x.meta.by === this.me ? "you" : this.labelOf(x.meta.by)}`)
          any = true
        }
      }
      const live = Object.values(this.st.threads).filter((t) => M.isLive(t) && M.people(t).includes(this.me))
      outer: for (let i = 0; i < live.length; i++)
        for (let j = i + 1; j < live.length; j++) {
          const why = I.converge(this.lite(live[i]), this.lite(live[j]))
          if (!why) continue
          const [s, x] = I.survivor(
            { id: live[i].id, createdAt: live[i].meta.value.createdAt, t: live[i] },
            { id: live[j].id, createdAt: live[j].meta.value.createdAt, t: live[j] },
          )
          this.absorb(s.t, x.t, why)
          any = true
          break outer
        }
      if (!any) break
    }
    for (const s of this.locals.values()) this.place(s)
  }

  private labelOf(fp: string): string {
    if (fp === this.me) return this.label
    return Object.values(this.d.peers()).find((p) => p.fingerprint === fp)?.label ?? fp.slice(0, 9)
  }

  /** Fold `x` into `s`. Everyone in either can now read both, and is told so. */
  private absorb(s: M.Thread, x: M.Thread, why: string) {
    const now = this.now()
    const before = { s: M.live(s, "people").map((p) => p.label), x: M.live(x, "people").map((p) => p.label) }
    for (const list of M.LISTS)
      for (const it of M.live(x, list) as any[]) {
        const { l: _l, by: _b, id, gone: _g, ...data } = it
        const mine = (s as any)[list][id]
        if (mine && !mine.gone) continue
        M.put(s, list, id, data, this.me, now)
      }
    if (!s.recap.value && x.recap.value) M.setRecap(s, this.me, x.recap.value, now)
    if (s.meta.value.public !== x.meta.value.public && x.meta.value.public === false)
      // Combining never makes sealed work public.
      M.setMeta(s, this.me, { public: false }, now)
    if (x.meta.value.combinedInto !== s.id) M.setMeta(x, this.me, { combinedInto: s.id, status: "archived" }, now)
    if (!this.st.keys[s.id] && this.st.keys[x.id]) this.st.keys[s.id] = this.st.keys[x.id]
    for (const p of Object.values(this.st.placed)) {
      p.threads = [...new Set(p.threads.map((id) => (id === x.id ? s.id : id)))]
      if (p.pinned) p.pinned = [...new Set(p.pinned.map((id) => (id === x.id ? s.id : id)))]
      if (p.why[x.id] && !p.why[s.id]) p.why[s.id] = p.why[x.id]
    }
    this.touched.add(s.id)
    this.touched.add(x.id)
    if (this.st.noticed.includes(x.id)) return
    this.st.noticed.push(x.id)
    const newToS = before.x.filter((p) => !before.s.includes(p))
    const newToX = before.s.filter((p) => !before.x.includes(p))
    const sName = s.meta.value.name
    const xName = x.meta.value.name
    const reads: string[] = []
    if (newToS.length) reads.push(`${newToS.join(", ")} can now read ${sName}`)
    if (newToX.length) reads.push(`${newToX.join(", ")} can now read what was in ${xName}`)
    const text =
      `◢ crosstalk: ${xName === sName ? `two ${sName} threads` : `${xName} and ${sName}`} combined into ${sName} (${why}). ` +
      (reads.length ? reads.join("; ") + "." : "Nobody new can read anything.")
    this.d.log(text)
    const note = { id: `combine:${x.id}`, text }
    const sids = new Set([...this.locals.keys()].filter((sid) => (this.st.placed[sid]?.threads ?? []).includes(s.id)))
    for (const sid of sids) (this.st.notes[sid] ??= []).push(note)
  }

  /**
   * Threads nobody touched for fadeDays and no session is in archive, squashed
   * to their decisions: what was decided, the features and the rules stay;
   * the conversation around it goes. They come back with new activity.
   */
  fade() {
    const days = this.d.fadeDays ?? 14
    const now = this.now()
    for (const t of Object.values(this.st.threads)) {
      if (!M.isLive(t) || now - t.touchedAt < days * DAY) continue
      if (this.sessionsIn([t.id]).length) continue
      if (M.live(t, "sessions").some((s) => s.person !== this.me && now - s.at < Math.min(PEER_SESSION_MS, days * DAY))) continue
      squash(t, this.me, now)
      this.touched.add(t.id)
      this.d.log(`thread ${t.meta.value.name} archived after ${days} quiet days`)
    }
    this.flush()
  }

  // --- edits from tools ----------------------------------------------------------

  private target(sessionId: string | undefined, name?: string): M.Thread | { error: string } {
    const t = this.find(sessionId, name)
    if (t) return t
    return { error: name ? `no thread called "${name}"` : "this session is in no thread yet" }
  }

  decide(sessionId: string | undefined, o: { text: string; rationale?: string; session?: string; thread?: string }) {
    const t = this.target(sessionId, o.thread)
    if ("error" in t) return { ok: false as const, error: t.error }
    const now = this.now()
    M.put(t, "decisions", M.newItemId("d"), { text: o.text, who: this.label, at: now, ...(o.rationale ? { rationale: o.rationale } : {}), ...(o.session ? { session: o.session } : {}) }, this.me, now)
    this.touched.add(t.id)
    this.flush()
    return { ok: true as const, thread: t.meta.value.name }
  }

  fact(sessionId: string | undefined, o: { text: string; thread?: string }) {
    const t = this.target(sessionId, o.thread)
    if ("error" in t) return { ok: false as const, error: t.error }
    const now = this.now()
    const id = M.newItemId("f")
    M.put(t, "facts", id, { text: o.text, who: this.label, at: now }, this.me, now)
    this.touched.add(t.id)
    this.flush()
    return { ok: true as const, thread: t.meta.value.name, id }
  }

  task(sessionId: string | undefined, o: { text?: string; id?: string; op: "add" | "claim" | "done"; note?: string; thread?: string }) {
    const t = this.target(sessionId, o.thread)
    if ("error" in t) return { ok: false as const, error: t.error }
    const now = this.now()
    if (o.op === "add") {
      if (!o.text?.trim()) return { ok: false as const, error: "a task needs some text" }
      const id = M.newItemId("t")
      M.put(t, "tasks", id, { text: o.text.trim(), who: this.label, at: now, state: "open" }, this.me, now)
      this.touched.add(t.id)
      this.flush()
      return { ok: true as const, thread: t.meta.value.name, id }
    }
    const k = o.id ? t.tasks[o.id] : undefined
    if (!k || k.gone) return { ok: false as const, error: `no task ${o.id} in ${t.meta.value.name}` }
    const { l: _l, by: _b, id: _i, gone: _g, ...data } = k
    if (o.op === "claim") {
      if (k.state !== "open" && k.claimedBy !== this.label) return { ok: false as const, error: "somebody else has that one. Pick a different task rather than doing it twice." }
      M.put(t, "tasks", k.id, { ...data, state: "claimed", claimedBy: this.label }, this.me, now)
    } else M.put(t, "tasks", k.id, { ...data, state: "done", doneBy: this.label, ...(o.note ? { note: o.note } : {}) }, this.me, now)
    this.touched.add(t.id)
    this.flush()
    return { ok: true as const, thread: t.meta.value.name, id: k.id }
  }

  /** Everything else crosstalk_thread can change, in plain fields. */
  edit(
    sessionId: string | undefined,
    o: {
      thread?: string
      status?: M.Status
      public?: boolean
      recap?: string
      feature?: { name: string; risk?: M.Risk; flag?: string; remove?: boolean }
      question?: { text: string; blocking?: boolean }
      answer?: { id: string; text: string }
      rule?: { text: string; when?: string; then?: string }
    },
  ) {
    const t = this.target(sessionId, o.thread)
    if ("error" in t) return { ok: false as const, error: t.error }
    const now = this.now()
    let changed = false
    if (o.status) {
      if (!M.STATUSES.includes(o.status)) return { ok: false as const, error: `status is one of ${M.STATUSES.join(", ")}` }
      if (o.status === "archived") changed = squash(t, this.me, now) || changed
      else changed = M.setMeta(t, this.me, { status: o.status }, now) || changed
    }
    if (o.public !== undefined) changed = M.setMeta(t, this.me, { public: !!o.public }, now) || changed
    if (o.recap !== undefined) changed = M.setRecap(t, this.me, String(o.recap).slice(0, 4000), now) || changed
    if (o.feature?.name) {
      const id = M.slug(o.feature.name, 60)
      changed = o.feature.remove
        ? M.remove(t, "features", id, this.me, now) || changed
        : M.put(t, "features", id, { ...this.featureRest(t, id), name: o.feature.name, risk: o.feature.risk === "risky" ? "risky" : "everyday", ...(o.feature.flag ? { flag: o.feature.flag } : {}) }, this.me, now) || changed
    }
    if (o.question?.text)
      changed = M.put(t, "questions", M.newItemId("q"), { text: o.question.text, blocking: !!o.question.blocking, who: this.label, at: now }, this.me, now) || changed
    if (o.answer?.id) {
      const q = t.questions[o.answer.id]
      if (!q || q.gone) return { ok: false as const, error: `no question ${o.answer.id}` }
      const { l: _l, by: _b, id: _i, gone: _g, ...data } = q
      changed = M.put(t, "questions", q.id, { ...data, answer: o.answer.text, answeredBy: this.label }, this.me, now) || changed
    }
    if (o.rule?.text)
      changed = M.put(t, "rules", M.newItemId("r"), { text: o.rule.text, who: this.label, at: now, ...(o.rule.when ? { when: o.rule.when } : {}), ...(o.rule.then ? { then: o.rule.then } : {}) }, this.me, now) || changed
    if (changed) this.touched.add(t.id)
    this.flush()
    return { ok: true as const, thread: M.view(t) }
  }

  /** What a feature edit keeps: shipping's record of it (src/shipping), and its flag unless one is named. */
  private featureRest(t: M.Thread, id: string): Partial<M.Feature> {
    const f = t.features[id]
    if (!f || f.gone) return {}
    return { ...(f.ship ? { ship: f.ship } : {}), ...(f.flag ? { flag: f.flag } : {}) }
  }

  // --- for src/shipping ------------------------------------------------------------

  /** Every thread this replica holds, combined ones aside. */
  all(): M.Thread[] {
    return Object.values(this.st.threads).filter((t) => !t.meta.value.combinedInto)
  }

  /** Change one thread with the model's edit functions; saved, sent and committed like any edit. */
  mutate(id: string, fn: (t: M.Thread, by: string, now: number) => unknown) {
    const t = this.thread(id)
    if (!t) return
    fn(t, this.me, this.now())
    this.touched.add(t.id)
    this.flush()
  }

  /** A notice for the people in a thread: each local session in it shows it once. */
  notify(id: string, text: string) {
    const t = this.thread(id)
    if (!t) return
    const note = { id: M.newItemId("n"), text }
    for (const sid of this.sessionsIn([t.id])) (this.st.notes[sid] ??= []).push(note)
    this.save()
  }

  /** A thread nobody's session started, such as an incident's. */
  open(o: { name: string; repo: string }): M.Thread {
    const t = M.create({ name: M.slug(o.name), repo: o.repo, by: this.me, label: this.label, now: this.now() })
    this.st.threads[t.id] = t
    this.st.keys[t.id] = newKey().toString("base64")
    this.touched.add(t.id)
    this.flush()
    this.d.log(`thread ${t.meta.value.name} started: ${o.name}`)
    return t
  }

  /** A local session as the threads know it: its folder, checkout and branch. */
  local(sessionId: string): LocalSession | undefined {
    return this.locals.get(sessionId)
  }

  /** The clone the ref is written in for a repo. */
  rootFor(repo: string): string | undefined {
    return this.st.roots[repo]
  }

  // --- after every operation -------------------------------------------------------

  /** Save, send what changed to the people in it, and schedule a commit for what earns one. */
  private flush() {
    const skip = new Set<string>()
    if (this.touched.size) {
      const ids = [...this.touched]
      this.touched.clear()
      this.save()
      for (const id of ids) {
        const t = this.st.threads[id]
        if (!t) continue
        this.broadcast(t, skip)
        if (M.committedDigest(t) !== this.st.committed[id]) this.schedule(t.meta.value.repo)
      }
      try {
        this.d.onFlush?.(ids)
      } catch (e) {
        this.d.log(`threads: ${(e as Error).message}`)
      }
    } else this.save()
  }

  private schedule(repo: string) {
    if (!repo || !this.st.roots[repo]) return
    clearTimeout(this.timers.get(repo))
    this.timers.set(
      repo,
      setTimeout(() => {
        this.timers.delete(repo)
        void this.sync(repo, true)
      }, this.d.settleMs ?? 3000),
    )
  }

  /** Fetch and merge every repo this machine has threads in. Startup and every few minutes. */
  async syncAll() {
    for (const repo of Object.keys(this.st.roots)) await this.sync(repo, false)
  }

  /**
   * One round with the ref: fetch the remote copy, merge it and the local
   * ref into this replica, commit when anything that earns a commit differs
   * from the last commit, push. Never throws, never prompts.
   */
  sync(repo: string, commit: boolean): Promise<void> {
    const running = this.syncing.get(repo)
    if (running) return running.then(() => this.sync(repo, commit))
    const p = this.syncOnce(repo, commit)
      .catch((e) => this.d.log(`thread sync for ${repo} failed: ${(e as Error).message}`))
      .finally(() => this.syncing.delete(repo))
    this.syncing.set(repo, p)
    return p
  }

  private async syncOnce(repo: string, commit: boolean) {
    const root = this.st.roots[repo]
    if (!root || !fs.existsSync(root)) return
    const remote = S.remoteName(root)
    for (const clone of new Set([root, ...(this.clones.get(repo) ?? [])])) {
      if (this.refspecDone.has(clone) || !fs.existsSync(clone)) continue
      const r = S.remoteName(clone)
      if (r && S.ensureRefspec(clone, r)) this.d.log(`added ${S.REFSPEC} to ${r}'s fetch in ${clone}`)
      this.refspecDone.add(clone)
    }
    const network = this.d.network !== false && !!remote
    if (network) {
      const f = await S.fetchRemote(root, remote)
      if (!f.ok) this.d.log(`thread fetch from ${remote} failed quietly: ${f.err}`)
    }
    this.mergeRef(root, repo, S.SYNC_REF)
    this.mergeRef(root, repo, S.REF)
    this.reconcile()
    this.flush()
    const mine = Object.values(this.st.threads).filter((t) => t.meta.value.repo === repo)
    const due = commit || mine.some((t) => M.committedDigest(t) !== this.st.committed[t.id])
    if (!due) return
    for (let attempt = 0; attempt < 2; attempt++) {
      const files = this.render(repo)
      const local = S.refCommit(root)
      const remoteHead = S.refCommit(root, S.SYNC_REF)
      const extra = remoteHead && remoteHead !== local && !(local && S.isAncestor(root, remoteHead, local)) ? [remoteHead] : []
      const made = S.writeRef(root, files, commitMessage(mine), { author: `crosstalk (${this.label})`, extraParents: extra })
      for (const t of mine) this.st.committed[t.id] = M.committedDigest(t)
      this.save()
      this.writeSummary(repo, root)
      if (made) this.d.log(`committed ${Object.keys(files).length} thread file(s) to ${S.REF} in ${root}`)
      if (!network) return
      const r = await S.pushRemote(root, remote)
      if (r.ok) return void this.d.log(`pushed ${S.REF} to ${remote}`)
      this.d.log(`thread push to ${remote} failed quietly${attempt ? "" : ", fetching and trying once more"}: ${r.err}`)
      if (attempt) return
      await S.fetchRemote(root, remote)
      this.mergeRef(root, repo, S.SYNC_REF)
      this.reconcile()
      this.flush()
    }
  }

  /** Merge what a ref holds. A sealed file nobody gave us the key to is kept as it is. */
  private mergeRef(root: string, repo: string, ref: string) {
    const { files } = S.readRef(root, ref)
    const peers = Object.values(this.d.peers())
    for (const [name, text] of Object.entries(files)) {
      if (this.d.extra && name === this.d.extra.file) {
        this.d.extra.read(repo, text)
        if (this.st.opaque[repo]) delete this.st.opaque[repo][name]
        continue
      }
      if (name === S.RULES_FILE) {
        ;(this.st.opaque[repo] ??= {})[name] = text
        continue
      }
      const p = F.parse(text)
      let t: M.Thread | null = null
      if (p.kind === "public") t = p.thread
      else if (p.kind === "sealed") {
        let key: Buffer | null = this.st.keys[p.id] ? Buffer.from(this.st.keys[p.id], "base64") : null
        t = key ? p.open(key) : null
        if (!t) {
          key = unwrapKey(this.d.identity, p.wraps, peers)
          t = key ? p.open(key) : null
          if (t && key) this.st.keys[p.id] = key.toString("base64")
        }
      }
      if (!t || (t.meta.value.repo && t.meta.value.repo !== repo)) {
        // Not ours to read: carried along untouched so a commit never drops it.
        if (!this.st.threads[p.kind === "unknown" ? "" : p.id]) (this.st.opaque[repo] ??= {})[name] = text
        continue
      }
      if (this.st.opaque[repo]) delete this.st.opaque[repo][name]
      const known = this.st.threads[t.id]
      const merged = known ? M.merge(known, t) : t
      if (!known || !M.same(known, merged)) {
        this.st.threads[t.id] = merged
        this.touched.add(t.id)
      }
      // A combine first seen in git is history: its people were told when it happened.
      if (!known && merged.meta.value.combinedInto && !this.st.noticed.includes(t.id)) this.st.noticed.push(t.id)
    }
  }

  /** Every file for this repo's ref, rendered from this replica. */
  private render(repo: string): Record<string, string> {
    const out: Record<string, string> = { ...(this.st.opaque[repo] ?? {}) }
    const extra = this.d.extra?.render(repo)
    if (extra && this.d.extra) out[this.d.extra.file] = extra
    const taken = new Set(Object.keys(out))
    const byFp = new Map(Object.values(this.d.peers()).map((p) => [p.fingerprint, p]))
    for (const t of Object.values(this.st.threads).sort((a, b) => a.meta.value.createdAt - b.meta.value.createdAt || (a.id < b.id ? -1 : 1))) {
      if (t.meta.value.repo !== repo) continue
      const name = F.fileName(t, taken)
      taken.add(name)
      if (t.meta.value.public) {
        out[name] = F.renderPublic(t)
        continue
      }
      const k = this.st.keys[t.id]
      if (!k) continue
      const key = Buffer.from(k, "base64")
      const recipients = M.people(t)
        .map((fp) => byFp.get(fp))
        .filter((p): p is Peer => !!p)
      out[name] = F.renderSealed(t, this.sealer(t.id, key), this.wraps(t.id, key, recipients))
    }
    return out
  }

  /** Reuse a section's sealed blob while its content and key are the same. */
  private sealer(id: string, key: Buffer): F.Sealer {
    const kh = crypto.createHash("sha256").update(key).digest("hex").slice(0, 8)
    return (section, value) => {
      const h = kh + crypto.createHash("sha256").update(M.canonical(value)).digest("hex").slice(0, 24)
      const slot = `${id}/${section}`
      const c = this.st.blobs[slot]
      if (c?.h === h) return c.b
      const b = sealSection(key, id, section, value)
      this.st.blobs[slot] = { h, b }
      return b
    }
  }

  private wraps(id: string, key: Buffer, recipients: Peer[]) {
    const kh = crypto.createHash("sha256").update(key).digest("hex").slice(0, 8)
    const h = kh + recipients.map((p) => p.fingerprint).sort().join(",")
    const slot = `${id}/wraps`
    const c = this.st.blobs[slot]
    if (c?.h === h) return JSON.parse(c.b)
    const w = wrapKey(this.d.identity, key, recipients)
    this.st.blobs[slot] = { h, b: JSON.stringify(w) }
    return w
  }

  /**
   * THREADS.md, the one file crosstalk writes in a working tree: rewritten
   * only when a public thread's status changes, and left as an unstaged change
   * for the person to commit or not. Never written for a repo with no public
   * thread, so a repo whose threads are all sealed never sees it.
   */
  private writeSummary(repo: string, root: string) {
    const pub = Object.values(this.st.threads).filter((t) => t.meta.value.repo === repo && t.meta.value.public && !t.meta.value.combinedInto)
    const now = Object.fromEntries(pub.map((t) => [t.id, t.meta.value.status]))
    const before = this.st.publicStatus[repo] ?? {}
    if (M.canonical(now) === M.canonical(before)) return
    this.st.publicStatus[repo] = now
    this.save()
    const file = path.join(root, "THREADS.md")
    if (!pub.length && !fs.existsSync(file)) return
    const text = F.summary(pub)
    try {
      if (fs.existsSync(file) && fs.readFileSync(file, "utf8") === text) return
      fs.writeFileSync(file, text)
    } catch {
      return
    }
    this.d.log(`wrote ${file}`)
    const note = { id: `summary:${repo}:${Date.now()}`, text: `◢ crosstalk: updated THREADS.md in ${path.basename(root)} because a public thread's status changed. It is left unstaged; commit it if you want it in the repo.` }
    for (const [sid, s] of this.locals) if (s.repo === repo) (this.st.notes[sid] ??= []).push(note)
    this.save()
  }
}

/** Archive a thread and keep only what was decided. */
export function squash(t: M.Thread, by: string, now: number): boolean {
  let changed = M.setMeta(t, by, { status: "archived" }, now)
  for (const list of ["facts", "tasks", "questions", "sessions"] as const)
    for (const id of M.ids(t, list)) changed = M.remove(t, list, id, by, now) || changed
  if (t.recap.value) changed = M.setRecap(t, by, "", now) || changed
  return changed
}

function commitMessage(threads: M.Thread[]): string {
  const names = threads.filter((t) => !t.meta.value.combinedInto).map((t) => (t.meta.value.public ? t.meta.value.name : t.id.slice(0, 8)))
  return `crosstalk: threads (${names.slice(0, 5).join(", ")}${names.length > 5 ? ", …" : ""})`
}
