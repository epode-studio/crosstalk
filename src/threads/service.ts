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
// machine shares a channel with) who is in the thread *here*, and only into a
// thread we are in or that names us. Who is in a thread, whether it is public
// and what it was combined into are this replica's to decide: neither a frame
// nor a file on the ref (which anyone who can push can write) adds a person,
// makes a sealed thread public or folds it into another (accept, mergeRef,
// settle). Keys move only forward (rekey.ts adoption). Nothing is committed or
// pushed for a repo before the person connected it (shared). Peer text in a
// thread reaches an agent only through crosstalk_thread action "read", framed as other
// people's words. docs/security.md, "Who may change a thread".

import { baseName } from "../ui-extra/pure.ts"
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
import * as N from "../notes.ts"
import { sealSection, unwrapFor, wrapKey, newKey } from "./seal.ts"
import { botSafe } from "../ui-extra/bots.ts"
import * as K from "./rekey.ts"

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
  /**
   * Whether the person connected this repo with their team (src/repotrust/
   * firstuse.ts). Absent (tests, tools) is yes. See ThreadService.shared.
   */
  connected?: (repo: string) => boolean
  /** Fingerprints repo trust revoked; defaults to repotrust's state (rekey.ts). */
  revoked?: () => Set<string>
  /**
   * When a session's files cannot place it (two threads equally, or new files
   * no thread covers), the thread its recap points at (src/attention).
   */
  tiebreak?: (sessionId: string, candidates: string[], mode: "ask" | "create") => { id: string; why: string } | undefined
}

/** Where a local session was placed. `name` is how its thread entry is keyed, the same way a peer sees it in presence. */
/**
 * `pinBranch` is the branch the session was on when its placement was chosen
 * (by the person, by `expect`, or by leaving a thread): the choice holds on
 * that branch, and a move to another branch none of the pinned threads has is
 * new work, placed afresh.
 */
type Placed = {
  threads: string[]
  why: Record<string, string>
  pinned?: string[]
  pinBranch?: string
  name?: string
  left?: string[]
  /** Threads this session was already told it joined: said once, however often its work moves in and out of them. */
  announced?: string[]
}
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
  /** Each thread key's epoch and who it may have reached (rekey.ts). */
  epochs: Record<string, number>
  holders: Record<string, string[]>
  /** Hashes of every key this replica replaced: never taken back from anyone (rekey.ts adoption). */
  retired: Record<string, string[]>
  /**
   * Placements said in advance (`expect`): "sid:<session id>" or "cwd:<folder>"
   * to the thread it starts in. `used` is the sessions it has placed, each once.
   */
  expected: Record<string, Expected>
}

type Expected = { thread: string; why: string; at: number; used: string[] }

/** How long a placement said in advance waits for its session. */
const EXPECT_MS = 7 * 24 * 60 * 60_000

const empty = (): State => ({
  expected: {},
  epochs: {},
  holders: {},
  retired: {},
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
/** The files that say what a thread is about, for placing sessions: its first ones. */
const DEFINING_FILES = 24
/** On the default branch, a session's thread follows what it touched lately, not all it ever touched. */
const RECENT_PATHS = 10
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

  /** What was last written, so a save with nothing new in it writes nothing. */
  private written?: string

  private save() {
    const text = JSON.stringify(this.st)
    if (text === this.written) return
    fs.mkdirSync(path.dirname(this.d.file), { recursive: true, mode: 0o700 })
    const tmp = `${this.d.file}.${process.pid}.tmp`
    fs.writeFileSync(tmp, text, { mode: 0o600 })
    fs.renameSync(tmp, this.d.file)
    this.written = text
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
      // What it is about: its first files. Files picked up later by sessions passing through
      // must not let one thread swallow every session in the repo.
      files: M.ids(t, "files").slice(0, DEFINING_FILES),
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
    // One thread, and the session's own name: never a title built on the last title (pure.ts baseName).
    const names = [...new Set(this.namesFor(sessionId))]
    return names.length ? `${names[0]} · ${baseName(name)}` : undefined
  }

  /** The repository a local session is working in now, as its footprint says. */
  repoOfSession(sessionId: string): string | undefined {
    return this.locals.get(sessionId)?.repo
  }

  /** Local sessions in any of these threads. */
  sessionsIn(threadIds: string[]): string[] {
    const want = new Set(threadIds.map((id) => this.resolve(id)))
    return [...this.locals.keys()].filter((sid) => this.idsFor(sid).some((id) => want.has(id)))
  }

  /** Who a message from this session with no named recipient goes to: the people in its threads. */
  recipients(sessionId: string): { threads: string[]; labels: string[] } {
    const threads = this.idsFor(sessionId)
    return { threads, labels: this.teammates(threads) }
  }

  /** The other people in these threads, by the label this machine knows them by: none when a thread is only local. */
  teammates(threadIds: string[]): string[] {
    const fps = new Set(
      threadIds.flatMap((id) => {
        const t = this.st.threads[this.resolve(id)]
        return t ? M.ids(t, "people") : []
      }),
    )
    fps.delete(this.me)
    const labels = Object.values(this.d.peers())
      .filter((p) => fps.has(p.fingerprint))
      .map((p) => p.label)
    return [...new Set(labels)]
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

  /**
   * Say where a session goes before it arrives: a new agent started from a
   * thread (src/spawn.ts) is in that thread from its first registration, by
   * its session id or by the folder it runs in (its worktree). It is a pin,
   * like the person choosing the thread: its files never move it, and its own
   * branch joins the thread so a pin made on another branch is not dropped.
   * Each session is placed by it once; leaving the thread afterwards sticks.
   * Saying it again for the same key and thread changes nothing.
   */
  expect(o: { sessionId?: string; cwd?: string; thread: string; why?: string }): { ok: boolean; error?: string; thread?: string } {
    const t = this.thread(o.thread) ?? this.find(undefined, o.thread)
    if (!t) return { ok: false, error: `no thread called "${o.thread}"` }
    const key = o.sessionId ? `sid:${o.sessionId}` : o.cwd ? `cwd:${path.resolve(o.cwd)}` : ""
    if (!key) return { ok: false, error: "a session id or a folder is needed" }
    const now = this.now()
    for (const [k, e] of Object.entries(this.st.expected)) if (now - e.at > EXPECT_MS) delete this.st.expected[k]
    const was = this.st.expected[key]
    if (was?.thread === t.id) return { ok: true, thread: t.meta.value.name }
    this.st.expected[key] = { thread: t.id, why: o.why ?? "started in it", at: now, used: [] }
    this.save()
    // Already registered: placed now.
    const s = o.sessionId ? this.locals.get(o.sessionId) : [...this.locals.values()].find((x) => this.expectedFor(x)?.[0] === key)
    if (s) {
      this.place(s)
      this.flush()
    }
    return { ok: true, thread: t.meta.value.name }
  }

  /** The placement said in advance for this session, if one is waiting for it. */
  private expectedFor(s: LocalSession): [string, Expected] | undefined {
    const e = this.st.expected
    const bySid = e[`sid:${s.sessionId}`]
    if (bySid && !bySid.used.includes(s.sessionId)) return [`sid:${s.sessionId}`, bySid]
    if (!s.cwd) return undefined
    const c = path.resolve(s.cwd)
    let best: [string, Expected] | undefined
    for (const [k, x] of Object.entries(e)) {
      if (!k.startsWith("cwd:") || x.used.includes(s.sessionId)) continue
      const dir = k.slice(4)
      if (c !== dir && !c.startsWith(dir + path.sep)) continue
      if (!best || k.length > best[0].length) best = [k, x]
    }
    return best
  }

  /** Take a waiting placement: the session is pinned to that thread. */
  private takeExpected(s: LocalSession, rec: Placed, fp: I.Footprint) {
    const hit = this.expectedFor(s)
    if (!hit) return
    const [, x] = hit
    x.used.push(s.sessionId)
    const id = this.resolve(x.thread)
    const t = this.st.threads[id]
    if (!t || K.isRemoved(t, this.me)) return
    rec.pinned = [...new Set([...(rec.pinned ?? []), id])]
    rec.pinBranch = fp.branch
    rec.why[id] = x.why
    delete this.st.questions[s.sessionId]
    // Its branch is this thread's work, so the pin holds on it.
    if (fp.branch && !fp.onDefault && !t.branches[fp.branch] && M.put(t, "branches", fp.branch, { at: this.now() }, this.me, this.now())) this.touched.add(t.id)
  }

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
    if (!p) {
      if (this.st.notes[sessionId] || this.st.banner[sessionId]) {
        delete this.st.notes[sessionId]
        delete this.st.banner[sessionId]
        this.save()
      }
      return
    }
    for (const id of p.threads) {
      const t = this.st.threads[this.resolve(id)]
      if (t && M.remove(t, "sessions", `${this.me}:${p.name ?? sessionId}`, this.me, this.now())) this.touched.add(t.id)
    }
    delete this.st.placed[sessionId]
    delete this.st.questions[sessionId]
    delete this.st.notes[sessionId]
    delete this.st.banner[sessionId]
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
    const onDefault = this.onDefault(s)
    return { repo: s.repo, branch: s.branch, paths: onDefault ? s.paths.slice(0, RECENT_PATHS) : s.paths, onDefault }
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
    // A thread is one repository's work: a session out of it (another project, or no repository)
    // is not in it, whatever placed it there before. Only the person's own choice holds.
    {
      const rec = this.st.placed[s.sessionId]
      if (rec?.threads.length) {
        const keep = rec.threads.filter((id) => {
          const t = this.st.threads[this.resolve(id)]
          return t && ((s.repo && t.meta.value.repo === s.repo) || rec.pinned?.includes(id))
        })
        if (keep.length !== rec.threads.length) {
          for (const id of rec.threads)
            if (!keep.includes(id)) {
              const t = this.st.threads[this.resolve(id)]
              if (t && M.remove(t, "sessions", `${this.me}:${rec.name ?? s.name}`, this.me, this.now())) this.touched.add(t.id)
              delete rec.why[id]
            }
          rec.threads = keep
        }
      }
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
    this.takeExpected(s, rec, fp)
    let want: { id: string; why: string }[]
    if (rec.pinned) {
      rec.pinned = rec.pinned.map((id) => this.resolve(id)).filter((id) => this.st.threads[id])
      want = rec.pinned.map((id) => ({ id, why: rec.why[id] ?? "you chose it" }))
      // A pin from the default branch is about those files; a new branch is new work.
      const moved = rec.pinBranch === undefined || rec.pinBranch !== fp.branch
      if (!fp.onDefault && fp.branch && moved && !rec.pinned.some((id) => M.ids(this.st.threads[id], "branches").includes(fp.branch!))) {
        delete rec.pinned
        delete rec.pinBranch
        return this.place(s)
      }
    } else {
      let p = I.place(fp, this.lites(s.repo))
      // The session's own last turns break a tie the files cannot (src/attention/recap.ts).
      if (p.kind === "ask" || (p.kind === "create" && fp.onDefault)) {
        const cands = p.kind === "ask" ? p.candidates : this.lites(s.repo).filter((t) => t.live && !t.combinedInto).map((t) => t.id)
        const pick = cands.length ? this.d.tiebreak?.(s.sessionId, cands, p.kind) : undefined
        if (pick) {
          p = { kind: "join", threads: [pick] }
          delete this.st.questions[s.sessionId]
        }
      }
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
        want = (fp.onDefault ? rec.threads.slice(-1) : rec.threads).map((id) => ({ id, why: rec.why[id] ?? "" }))
      } else {
        // Nothing new to say: a session on the default branch stays where it was (its latest thread only).
        want = fp.onDefault ? rec.threads.slice(-1).map((id) => ({ id, why: rec.why[id] ?? "" })) : []
      }
      // On the default branch a session is in one thread at a time: the one its latest files are in.
      // It moves when its work does; it never collects every thread it ever touched.
      if (fp.onDefault && want.length > 1) want = want.slice(0, 1)
    }
    // A thread this person left, or was taken out of, is not joined again by matching it.
    want = want.filter((w) => !(this.st.threads[this.resolve(w.id)] && K.isRemoved(this.st.threads[this.resolve(w.id)], this.me)))
    // A thread this session was told to leave is not joined again by matching it.
    const left = new Set((rec.left ?? []).map((id) => this.resolve(id)))
    if (left.size) want = want.filter((w) => !left.has(this.resolve(w.id)))
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
        if (!(rec.announced ?? []).includes(id)) {
          const banner = (this.st.banner[s.sessionId] ??= [])
          if (!banner.some((b) => b.name === t.meta.value.name)) banner.push({ name: t.meta.value.name, why: w.why || "matched" })
          rec.announced = [...(rec.announced ?? []), id].slice(-50)
        }
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
    // On the default branch a thread only takes files beside its own: a session passing through
    // must not make it cover the whole repo, and pull every other session in.
    const near = (p: string) => files.some((q) => path.posix.dirname(q.replace(/\/\*\*$/, "/x")) === path.posix.dirname(p))
    for (const p of s.paths.slice(0, 12)) {
      if (files.length >= MAX_FILES) break
      if (files.some((q) => I.covers(q, p))) continue
      if (fp.onDefault && files.length && !near(p)) continue
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
    rec.pinBranch = s?.branch
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
      this.branchInto(t, s)
      rec.pinned = [t.id]
      rec.why[t.id] = "you asked for a new thread"
    } else {
      const t = this.find(sessionId, pick) ?? (q ? q.candidates.map((id) => this.st.threads[id]).find((t) => t?.meta.value.name === pick) : undefined)
      if (!t) return { ok: false, error: `no thread called "${pick}". Threads: ${this.list().map((t) => t.name).join(", ") || "none"}` }
      rec.pinned = [...new Set([...(rec.pinned ?? []), t.id])]
      if (s) this.branchInto(t, s)
      rec.why[t.id] = "you chose it"
      rec.left = rec.left?.filter((id) => this.resolve(id) !== t.id)
    }
    if (s) this.place(s)
    this.flush()
    return { ok: true, threads: this.namesFor(sessionId) }
  }

  /** A thread chosen for a session on a work branch takes that branch, so the choice holds there. */
  private branchInto(t: M.Thread, s: LocalSession) {
    const b = s.branch ? t.branches[s.branch] : undefined
    if (!s.branch || this.onDefault(s) || (b && !b.gone)) return
    if (M.put(t, "branches", s.branch, { at: this.now() }, this.me, this.now())) this.touched.add(t.id)
  }

  /** Take a session out of one thread for good (until it is placed there by hand). */
  leave(sessionId: string, nameOrId: string) {
    const t = this.find(sessionId, nameOrId)
    if (!t) return { ok: false, error: `no thread called "${nameOrId}"` }
    const rec: Placed = (this.st.placed[sessionId] ??= { threads: [], why: {} })
    rec.pinned = this.idsFor(sessionId).filter((id) => id !== t.id)
    rec.pinBranch = this.locals.get(sessionId)?.branch
    // Remembered, so matching (its branch, its files) never puts it back; only choosing it does.
    rec.left = [...new Set([...(rec.left ?? []), t.id])]
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
        if (K.isRemoved(t, peer.fingerprint)) continue
        const isNew =!t.people[peer.fingerprint] || !!t.people[peer.fingerprint].gone
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

  /**
   * A thread frame from a peer.
   *
   * The frame is a replica of the thread, but not everything in it is the
   * sender's to change. A known thread is heard only from someone who is in
   * it here. Who is in it, whether it is public and what it was combined into
   * are decided on this machine: a frame cannot add a person (only take one
   * out, or the sender themselves leaving), cannot make a sealed thread
   * public, and cannot fold this thread into another unless nobody new could
   * read that other thread by it.
   */
  accept(label: string, env: Envelope) {
    const peer = this.d.peers()[label]
    if (!peer) return this.d.log(`ignored a thread from ${label}: no direct channel`)
    this.capable.add(label)
    const sync = env.threadSync as { thread?: unknown; key?: string; epoch?: number } | undefined
    const raw = botSafe(label, M.parseThread(sync?.thread), this.st.threads, this.d.peers())
    if (!raw) return this.d.log(`ignored a malformed thread from ${label}`)
    const known = this.st.threads[raw.id]
    const theirPeople = M.people(raw)
    if (known) {
      // Someone taken out of a thread is not heard in it again.
      if (K.isRemoved(known, peer.fingerprint)) return this.d.log(`ignored thread ${raw.id} from ${label}: they were taken out of it`)
      // Membership is what this replica says, never what the frame says.
      if (!M.people(known).includes(peer.fingerprint)) return this.d.log(`ignored thread ${raw.id} from ${label}: they are not in it here`)
      // A thread we left, or were taken out of, is not ours to hear about.
      if (!M.people(known).includes(this.me)) return
    } else {
      if (!theirPeople.includes(peer.fingerprint)) return this.d.log(`ignored thread ${raw.id} from ${label}: they are not in it`)
      if (!theirPeople.includes(this.me)) return this.d.log(`ignored thread ${raw.id} from ${label}: it does not name us`)
    }
    // Someone leaving sends the thread once more, without themselves in it.
    const leaving = !!known && K.isRemoved(raw, peer.fingerprint) && raw.people[peer.fingerprint].by === peer.fingerprint
    if (!theirPeople.includes(peer.fingerprint) && !leaving) return this.d.log(`ignored thread ${raw.id} from ${label}: they are not in it`)
    const inc = this.screen(known, raw)
    const merged = this.settle(known, known ? M.merge(known, inc) : inc, peer.label)
    // Keys converge on the higher epoch, then the smaller key (rekey.ts), so every replica agrees.
    if (K.validKey(sync?.key)) this.adoptKey(raw.id, sync.key, Number(sync.epoch) || 0, merged, [])
    if (known && M.same(known, merged)) return
    this.st.threads[raw.id] = merged
    this.touched.add(raw.id)
    this.d.log(`thread ${merged.meta.value.name} updated by ${label}`)
    this.reconcile()
    // Sent back to them too: whatever we added while placing our own sessions
    // has to reach them, and an unchanged echo stops at their merge.
    this.flush()
  }

  /**
   * A replica from elsewhere (a frame or a file) with the people it would add
   * taken out: adding a person is done here (presence, a combine decided here),
   * with a notice. Taking someone out, and leaving, still travel.
   */
  private screen(known: M.Thread | undefined, inc: M.Thread): M.Thread {
    if (!known) return inc
    const people: M.Items<M.Person> = {}
    for (const [fp, p] of Object.entries(inc.people)) {
      const mine = known.people[fp]
      const adds = !p.gone && (!mine || mine.gone)
      if (!adds) people[fp] = p
      else if (mine) people[fp] = mine
    }
    return { ...inc, people }
  }

  /**
   * After a merge: `public` and `combinedInto` as this replica decided them.
   * A change the other side made is a notice here, not a change.
   */
  private settle(known: M.Thread | undefined, merged: M.Thread, from: string): M.Thread {
    const want = { ...merged.meta.value }
    const was = known?.meta.value
    const notes: string[] = []
    const pub = was ? was.public : false
    if (want.public !== pub) {
      if (want.public && !pub) notes.push(`◢ crosstalk: ${from} made ${want.name} public on their side. It stays sealed here; it is committed in plain text only if you make it public yourself (crosstalk_thread action "status", public: true).`)
      want.public = pub
    }
    if (want.combinedInto !== was?.combinedInto) {
      const ok = want.combinedInto ? this.combineOk(merged, want.combinedInto) : false
      if (!ok) {
        if (want.combinedInto) {
          const into = this.st.threads[want.combinedInto]
          notes.push(`◢ crosstalk: ${from} combined ${want.name} into ${into ? into.meta.value.name : "a thread you do not have"}. It was not combined here, because that would let someone new read it.`)
        }
        want.combinedInto = was?.combinedInto
        // The combine archived it; not combined, it is as it was.
        want.status = was?.status ?? "active"
      }
    }
    if (M.canonical(want) !== M.canonical(merged.meta.value)) merged = { ...merged, meta: { ...merged.meta, value: want } }
    if (notes.length) for (const text of notes) this.noteThread(merged.id, `${merged.id}:${text.length}:${merged.meta.l}`, text)
    return merged
  }

  /** A combine this replica did not decide: only when everyone in `x` can already read the thread it goes into. */
  private combineOk(x: M.Thread, into: string): boolean {
    const s = this.st.threads[this.resolve(into)]
    if (!s || s.id === x.id) return false
    const readers = new Set(M.people(s))
    return M.people(x).every((fp) => readers.has(fp)) && (!s.meta.value.public || x.meta.value.public)
  }

  /** A notice for the local sessions in one thread, once. */
  private noteThread(id: string, key: string, text: string) {
    const note = { id: `note:${key}`, text }
    this.d.log(text)
    for (const sid of this.sessionsIn([id])) {
      const list = (this.st.notes[sid] ??= [])
      if (!list.some((n) => n.id === note.id)) list.push(note)
    }
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
        threadSync: { thread: t, key: this.st.keys[t.id], ...(this.st.epochs[t.id] ? { epoch: this.st.epochs[t.id] } : {}) },
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
          // Only a combine decided here, or one that lets nobody new read anything.
          if (x.meta.by !== this.me && !this.combineOk(x, into)) {
            this.st.noticed.push(x.id)
            continue
          }
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
    if (!M.recap(s) && M.recap(x)) M.setRecap(s, this.me, M.recap(x), now)
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
    M.note(t, { kind: "decision", text: o.text, who: this.label, at: now, ...(o.rationale ? { rationale: o.rationale } : {}), ...(o.session ? { session: o.session } : {}) }, this.me, now)
    this.touched.add(t.id)
    this.flush()
    return { ok: true as const, thread: t.meta.value.name }
  }

  fact(sessionId: string | undefined, o: { text: string; thread?: string }) {
    const t = this.target(sessionId, o.thread)
    if ("error" in t) return { ok: false as const, error: t.error }
    const now = this.now()
    const id = M.note(t, { kind: "fact", text: o.text, who: this.label, at: now }, this.me, now)
    this.touched.add(t.id)
    this.flush()
    return { ok: true as const, thread: t.meta.value.name, id }
  }

  /** The session's thread that holds note `id` of `kind`, or the one named. */
  holding(sessionId: string | undefined, id: string, kind: M.NoteKind, name?: string): M.Thread | undefined {
    if (name) {
      const t = this.find(sessionId, name)
      return t && M.noteOf(t, id, kind) ? t : undefined
    }
    const ids = sessionId ? this.idsFor(sessionId) : Object.keys(this.st.threads)
    return ids.map((x) => this.thread(x)).find((t): t is M.Thread => !!t && !!M.noteOf(t, id, kind))
  }

  /** The thread that keeps task `id`: the session's own first, then any thread this machine knows. */
  taskHolder(sessionId: string | undefined, id: string): M.Thread | undefined {
    return (sessionId ? this.holding(sessionId, id, "task") : undefined) ?? this.holding(undefined, id, "task")
  }

  /** A fact still holds: whoever says so stands behind it, as with facts kept outside threads. */
  confirmFact(sessionId: string | undefined, o: { id: string; thread?: string }) {
    const t = this.holding(sessionId, o.id, "fact", o.thread)
    if (!t) return { ok: false as const, error: `no fact ${o.id} in this session's threads` }
    const now = this.now()
    const data = N.confirmed(t, o.id, this.label, now)!
    M.put(t, "notes", o.id, data, this.me, now)
    this.touched.add(t.id)
    this.flush()
    return { ok: true as const, thread: t.meta.value.name, id: o.id }
  }

  /** A fact was wrong: the new one takes its place, the old one ends (it stays in History, saying what replaced it). */
  correctFact(sessionId: string | undefined, o: { id: string; text?: string; reason?: string; thread?: string }) {
    const t = this.holding(sessionId, o.id, "fact", o.thread)
    if (!t) return { ok: false as const, error: `no fact ${o.id} in this session's threads` }
    const now = this.now()
    const old = M.noteOf(t, o.id, "fact")!
    const next = o.text?.trim() ? M.note(t, { kind: "fact", text: o.text.trim(), who: this.label, at: now }, this.me, now) : undefined
    const { l: _l, by: _b, id: _i, gone: _g, ...data } = old
    M.put(t, "notes", o.id, { ...data, ...(next ? { supersededBy: next } : {}), ...(o.reason ? { reason: o.reason } : {}) }, this.me, now)
    M.remove(t, "notes", o.id, this.me, now)
    this.touched.add(t.id)
    this.flush()
    return { ok: true as const, thread: t.meta.value.name, id: next ?? o.id }
  }

  task(sessionId: string | undefined, o: { text?: string; id?: string; op: "add" | "claim" | "done"; note?: string; thread?: string }) {
    // A task is finished by its id wherever it is kept: the session may have moved to
    // another worktree, and so another thread, since it was handed the task.
    const holder = o.op !== "add" && !o.thread && o.id ? this.taskHolder(sessionId, o.id) : undefined
    const t = holder ?? this.target(sessionId, o.thread)
    if ("error" in t) return { ok: false as const, error: t.error }
    const now = this.now()
    if (o.op === "add") {
      if (!o.text?.trim()) return { ok: false as const, error: "a task needs some text" }
      const id = M.note(t, { kind: "task", text: o.text.trim(), who: this.label, at: now, state: "open" }, this.me, now)
      this.touched.add(t.id)
      this.flush()
      return { ok: true as const, thread: t.meta.value.name, id }
    }
    const k = M.noteOf(t, o.id, "task")
    if (!k) return { ok: false as const, error: `no task ${o.id} in ${t.meta.value.name}` }
    const { l: _l, by: _b, id: _i, gone: _g, ...data } = k
    if (o.op === "claim") {
      if (k.state !== "open" && k.claimedBy !== this.label) return { ok: false as const, error: "somebody else has that one. Pick a different task rather than doing it twice." }
      M.put(t, "notes", k.id, { ...data, state: "claimed", claimedBy: this.label }, this.me, now)
    } else M.put(t, "notes", k.id, { ...data, state: "done", doneBy: this.label, doneAt: now, ...(o.note ? { note: o.note } : {}) }, this.me, now)
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
      // Security (src/shipping): a risk is never lowered by an edit. Omitted, the
      // feature keeps its own; risky stays risky, even across a remove and a
      // re-add (a removed item keeps its data). Only a person's answer to
      // shipping's question makes a risky feature everyday again.
      const prev = t.features[id]
      const risk: M.Risk = o.feature.risk === "risky" || prev?.risk === "risky" ? "risky" : "everyday"
      changed = o.feature.remove
        ? M.remove(t, "features", id, this.me, now) || changed
        : M.put(t, "features", id, { ...this.featureRest(t, id), name: o.feature.name, risk, ...(o.feature.flag ? { flag: o.feature.flag } : {}) }, this.me, now) || changed
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
      changed = M.put(t, "notes", M.newItemId("r"), { kind: "rule", text: o.rule.text, who: this.label, at: now, ...(o.rule.when ? { when: o.rule.when } : {}), ...(o.rule.then ? { then: o.rule.then } : {}) }, this.me, now) || changed
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

  /** Every repo this machine has a clone of, with that clone. */
  roots(): Record<string, string> {
    return { ...this.st.roots }
  }

  // --- leaving and re-keying (rekey.ts) ---------------------------------------------

  /** Revoked fingerprints; a dependency so tests need no repotrust state. */
  private revoked = () => (this.d.revoked ? this.d.revoked() : K.revokedFingerprints())

  keyEpoch = (id: string) => this.st.epochs[id] ?? 0

  /**
   * Take a person out of a thread, or leave it ("me"). Their sessions go with
   * them, nobody's presence puts them back, and the key is replaced on the
   * way out so nothing written from now on opens for them.
   */
  removePerson(id: string, fp: string): { ok: boolean; error?: string; thread?: string; rekeyed?: boolean } {
    const t = this.thread(id)
    if (!t) return { ok: false, error: "no such thread" }
    if (!t.people[fp] || (t.people[fp].gone && K.isRemoved(t, fp))) return { ok: false, error: "they are not in that thread" }
    const before = this.keyEpoch(t.id)
    K.removePerson(t, fp, this.me, this.now())
    if (fp === this.me)
      for (const [sid, p] of Object.entries(this.st.placed))
        if (p.threads.includes(t.id)) {
          p.pinned = (p.pinned ?? p.threads).filter((x) => x !== t.id)
          p.threads = p.threads.filter((x) => x !== t.id)
          delete p.why[t.id]
          const s = this.locals.get(sid)
          if (s) this.place(s)
        }
    this.touched.add(t.id)
    // Our own leaving is told to the others before we stop hearing them: they re-key.
    if (fp === this.me) this.broadcast(t, new Set())
    this.flush()
    return { ok: true, thread: t.meta.value.name, rekeyed: this.keyEpoch(t.id) > before }
  }

  /** Replace the key when someone who may hold it should not any more. */
  private checkKey(id: string) {
    const t = this.st.threads[id]
    if (!t || t.meta.value.public || !this.st.keys[id]) return
    const should = K.shouldHold(M.people(t), this.revoked())
    const r = K.check({ me: this.me, holders: this.st.holders[id], should })
    this.st.holders[id] = r.holders
    if (!r.rotate) return
    this.st.retired[id] = K.retire(this.st.retired[id], this.st.keys[id])
    this.st.keys[id] = newKey().toString("base64")
    this.st.epochs[id] = this.keyEpoch(id) + 1
    // Re-sealed on the next commit, whatever else changed.
    delete this.st.committed[id]
    this.touched.add(id)
    this.d.log(`thread ${t.meta.value.name}: new key (epoch ${this.st.epochs[id]}) for ${should.length} ${should.length === 1 ? "person" : "people"}`)
  }

  /**
   * Take a key from a peer's frame or the ref when it may replace ours
   * (rekey.ts adoption): never a retired key, never an older epoch, at most
   * one epoch ahead. Who it may have reached is everyone in the thread and
   * everyone a file wrapped it for, so a file that leaves someone out of its
   * wraps does not hide that they hold it. True when it was taken.
   */
  private adoptKey(id: string, key: string, epoch: number, t: M.Thread, wrapped: string[]): boolean {
    const e = K.adoption({ key: this.st.keys[id], epoch: this.st.epochs[id], retired: this.st.retired[id] }, { key, epoch })
    if (e === null) return false
    this.st.retired[id] = K.retire(this.st.retired[id], this.st.keys[id])
    this.st.keys[id] = key
    if (e) this.st.epochs[id] = e
    else delete this.st.epochs[id]
    this.st.holders[id] = [...new Set([...M.people(t), ...wrapped])].sort()
    this.save()
    return true
  }

  // --- after every operation -------------------------------------------------------

  /** Save, send what changed to the people in it, and schedule a commit for what earns one. */
  private flush() {
    const skip = new Set<string>()
    for (const id of this.touched) this.checkKey(id)
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

  /**
   * Whether this repo's threads may leave this machine: the ref committed,
   * the clone's fetch list changed, anything pushed. Only once the person
   * said yes to "Connect with your team" for the repo (repotrust/firstuse.ts),
   * or once someone else is in one of its threads, which they joined over a
   * channel the person set up. Until then threads stay in threads.json.
   */
  shared(repo: string): boolean {
    if (!this.d.connected) return true
    try {
      if (this.d.connected(repo)) return true
    } catch {}
    return Object.values(this.st.threads).some((t) => t.meta.value.repo === repo && M.people(t).some((fp) => fp !== this.me))
  }

  private async syncOnce(repo: string, commit: boolean) {
    const root = this.st.roots[repo]
    if (!root || !fs.existsSync(root)) return
    if (!this.shared(repo)) {
      // Local only: what a fetch the person ran brought is still read.
      this.mergeRef(root, repo, S.SYNC_REF)
      this.mergeRef(root, repo, S.REF)
      this.reconcile()
      this.flush()
      return
    }
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
    // Trust revoked since the last round leaves a key holder who should not be one.
    for (const t of Object.values(this.st.threads)) if (t.meta.value.repo === repo) this.checkKey(t.id)
    this.flush()
    const mine = Object.values(this.st.threads).filter((t) => t.meta.value.repo === repo)
    // Due when asked, when something committed changed, or when the ref does
    // not hold what this replica would write (a commit that lost its race, or
    // one a forced fetch dropped).
    const due = commit || mine.some((t) => M.committedDigest(t) !== this.st.committed[t.id]) || !S.holds(root, this.render(repo))
    if (!due) return
    for (let attempt = 0; attempt < 2; attempt++) {
      const files = this.render(repo)
      const local = S.refCommit(root)
      const remoteHead = S.refCommit(root, S.SYNC_REF)
      const extra = remoteHead && remoteHead !== local && !(local && S.isAncestor(root, remoteHead, local)) ? [remoteHead] : []
      const made = S.writeRef(root, files, commitMessage(mine), { author: `crosstalk (${this.label})`, extraParents: extra })
      // Only what the ref now holds counts as committed: a lost swap is tried again next round.
      if (S.holds(root, files)) for (const t of mine) this.st.committed[t.id] = M.committedDigest(t)
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

  /**
   * Merge what a ref holds. A sealed file nobody gave us the key to is kept as it is.
   *
   * Anyone who can push can write any file on the ref, so a file is screened
   * like a frame, and more: a public file is read only into a thread that is
   * public here already (never into a sealed one, and never as a new thread a
   * session could then be placed in and committed in plain text); a sealed
   * file that does not open with our key opens only through a wrap from
   * someone in the thread here, for this thread, at an epoch we may adopt.
   */
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
      const known = p.kind === "unknown" ? undefined : this.st.threads[p.id]
      const keep = () => {
        // Not ours to read: carried along untouched so a commit never drops it.
        if (!known) (this.st.opaque[repo] ??= {})[name] = text
      }
      let t: M.Thread | null = null
      let adopt: { key: string; epoch: number; wrapped: string[] } | undefined
      if (p.kind === "public") {
        if (known?.meta.value.public) t = p.thread
        else if (known) this.d.log(`ignored ${name} on ${ref}: a public file for a thread that is sealed here`)
      } else if (p.kind === "sealed") {
        const mine = this.st.keys[p.id]
        t = mine ? p.open(Buffer.from(mine, "base64")) : null
        if (!t) {
          const u = unwrapFor(this.d.identity, p.wraps, peers, p.id, known ? new Set(M.people(known)) : undefined)
          const opened = u ? p.open(u.key) : null
          const k = u?.key.toString("base64")
          if (opened && u && k && K.adoption({ key: mine, epoch: this.st.epochs[p.id], retired: this.st.retired[p.id] }, { key: k, epoch: u.epoch }) !== null) {
            t = opened
            adopt = { key: k, epoch: u.epoch, wrapped: p.wraps.map((w) => w.to) }
          } else if (opened) this.d.log(`ignored ${name} on ${ref}: sealed with a key that was replaced`)
        }
      }
      if (!t || p.kind === "unknown" || t.id !== p.id || (t.meta.value.repo && t.meta.value.repo !== repo)) {
        keep()
        continue
      }
      if (this.st.opaque[repo]) delete this.st.opaque[repo][name]
      let merged = known ? M.merge(known, this.screen(known, t)) : t
      // A combine first seen in git, on a thread new here, is history: its people were told when it happened.
      if (known) merged = this.settle(known, merged, "a file on the ref")
      else if (merged.meta.value.public) merged = { ...merged, meta: { ...merged.meta, value: { ...merged.meta.value, public: false } } }
      if (adopt) this.adoptKey(t.id, adopt.key, adopt.epoch, merged, adopt.wrapped)
      if (!known || !M.same(known, merged)) {
        this.st.threads[t.id] = merged
        this.touched.add(t.id)
      }
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
      const recipients = K.shouldHold(M.people(t), this.revoked())
        .map((fp) => byFp.get(fp))
        .filter((p): p is Peer => !!p)
      out[name] = F.renderSealed(t, this.sealer(t.id, key), this.wraps(t.id, key, recipients), this.st.epochs[t.id] ?? 0)
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
    const epoch = this.keyEpoch(id)
    const h = `${kh}e${epoch}b1:` + recipients.map((p) => p.fingerprint).sort().join(",")
    const slot = `${id}/wraps`
    const c = this.st.blobs[slot]
    if (c?.h === h) return JSON.parse(c.b)
    const w = wrapKey(this.d.identity, key, recipients, { thread: id, epoch })
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
  for (const list of ["questions", "sessions"] as const)
    for (const id of M.ids(t, list)) changed = M.remove(t, list, id, by, now) || changed
  // Notes keep their decisions and rules; facts, tasks and the recap go (to History).
  for (const n of M.live(t, "notes")) if (n.kind === "fact" || n.kind === "task" || n.kind === "recap") changed = M.remove(t, "notes", n.id, by, now) || changed
  return changed
}

function commitMessage(threads: M.Thread[]): string {
  const names = threads.filter((t) => !t.meta.value.combinedInto).map((t) => (t.meta.value.public ? t.meta.value.name : t.id.slice(0, 8)))
  return `crosstalk: threads (${names.slice(0, 5).join(", ")}${names.length > 5 ? ", …" : ""})`
}
