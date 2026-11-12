// A thread: a piece of work and the conversation about it.
//
// docs/design/next-generation.md, "Threads". This file is the shape and the
// merge rule; format.ts writes it out, store.ts keeps it on the git ref and
// service.ts runs it in the daemon.
//
// Every copy of a thread is a replica. Two people edit theirs at the same time,
// over a relay that may deliver late or twice, and both must end up with the
// same thing without a coordinator. So a thread is made of sections, and each
// section merges on its own:
//
//   meta            one value, last writer wins
//   everything else a set of items keyed by id, last writer wins per item,
//                   removal is a tombstone (`gone`) so it wins over a stale add
//
// What a person meets inside a thread is four parts (docs/design/next-generation.md,
// "Three nouns"): Notes (`notes`, one list whose items carry a kind: decision,
// fact, task, rule, recap), Features (`features`), Running (a projection over
// what the daemon runs, src/threads/running.ts) and History (`links` and ended
// notes, src/threads/history.ts). People, sessions, files, branches and
// questions are the thread's own bookkeeping.
//
// Version 1 kept decisions, facts, tasks and rules as separate lists and the
// recap as a value of its own. parseThread reads that shape too and folds it
// into `notes`, keeping every item's id and stamp, so an old file, an old
// sealed file or a frame from a replica that has not updated merges with a new
// one item by item, and is written back in the new shape.
//
// "Last" is a Lamport clock: every edit stamps what it touches with one more
// than the highest stamp this replica has seen, and ties go to the higher
// author fingerprint. Merging is commutative, associative and idempotent, so
// the order frames arrive in, or whether a copy came over the relay or out of
// git, makes no difference. Concurrent appends to one list both survive, which
// a whole-section last-writer-wins would not give you: two people recording a
// decision at once is the common case, not the edge.

import crypto from "node:crypto"
import type { FeatureShip } from "../shipping/types.ts"
import type { Link } from "../urls/history/links.ts"

export type Status = "active" | "waiting" | "done" | "archived"
export const STATUSES: readonly Status[] = ["active", "waiting", "done", "archived"]
export type Risk = "everyday" | "risky"

/** A Lamport stamp: the clock value and who wrote it (a key fingerprint). */
export type Stamp = { l: number; by: string }

export type Scalar<T> = Stamp & { value: T }
export type Item<T> = T & Stamp & { id: string; gone?: true }
export type Items<T> = Record<string, Item<T>>

export type Meta = {
  name: string
  status: Status
  /** Public threads are committed in plain text and listed in THREADS.md. */
  public: boolean
  /** Normalised remote, as footprint.normaliseRemote spells it. */
  repo: string
  createdAt: number
  /** Fingerprint of whoever started it. */
  createdBy: string
  /** Set when this thread was combined into another one. */
  combinedInto?: string
}

/** One of the thread's people. The item id is their key fingerprint. */
export type Person = { label: string }
/** A session working in the thread. Id: `<fingerprint>:<session name>`, the name being what presence shows a peer. */
export type SessionRef = { person: string; label: string; name: string; branch?: string; at: number }
/** A shippable part. Id: a slug of the name. `ship` is what src/shipping knows about it. */
export type Feature = { name: string; risk: Risk; flag?: string; ship?: FeatureShip }
export type Question = {
  text: string
  blocking?: boolean
  who: string
  at: number
  answer?: string
  answeredBy?: string
  /**
   * Mail: a message for one person who is not on the relay, carried by the thread's own sync
   * (ThreadService.mail). `to` is their fingerprint, `env` the message. Stored answered, so
   * nothing that lists a thread's questions takes it for one.
   */
  mail?: { to: string; env: string }
  /** A shipping question (src/shipping/remote.ts): what a person on another machine needs to answer it. */
  ship?: { kind: string; feature: string; options: string[]; asker: string; stage?: string }
  /** A person's answer to a shipping question from another machine, signed with their key. */
  vote?: { pick: string; fp: string; label: string; at: number; sig: string }
}
/** What a thread knows: one list, each note one of these kinds. */
export type NoteKind = "decision" | "fact" | "task" | "rule" | "recap"
export const NOTE_KINDS: readonly NoteKind[] = ["decision", "fact", "task", "rule", "recap"]
type NoteBase = { text: string; who: string; at: number }
export type TaskState = "open" | "claimed" | "done"
export type Decision = NoteBase & { kind: "decision"; rationale?: string; session?: string }
/** `confirmed`: who has since said it still holds; `supersededBy`: the fact that corrected it. */
export type Fact = NoteBase & { kind: "fact"; confirmed?: { by: string; at: number }[]; supersededBy?: string; reason?: string }
export type Task = NoteBase & {
  kind: "task"
  state: TaskState
  claimedBy?: string
  doneBy?: string
  doneAt?: number
  note?: string
  /** Kept by crosstalk from an agent's Open list: it closes again by itself (gone from the list, or three days untouched). */
  auto?: boolean
}
/**
 * A standing rule ("Answers become rules"). `when` describes the kind of
 * question, `then` the standing answer, `sig` the author's signature
 * (src/rules/doc.ts).
 */
export type Rule = NoteBase & { kind: "rule"; when?: string; then?: string; sig?: string }
/** What the thread is doing, in a line or two. One per thread, id `recap`. */
export type Recap = NoteBase & { kind: "recap" }
export type Note = Decision | Fact | Task | Rule | Recap
export type NoteOf<K extends NoteKind> = Extract<Note, { kind: K }>
/** The recap's fixed id: one recap per thread, last writer wins, as when it was a value of its own. */
export const RECAP_ID = "recap"
/** Files and branches are sets of strings: the id is the value. */
export type Mark = { at: number }

export type Thread = {
  v: 2
  id: string
  meta: Scalar<Meta>
  people: Items<Person>
  sessions: Items<SessionRef>
  files: Items<Mark>
  branches: Items<Mark>
  features: Items<Feature>
  questions: Items<Question>
  /** Notes: decisions, facts, tasks, rules and the recap, each with its kind. */
  notes: Items<Note>
  /** Every link, preview and screenshot the thread had (src/urls/history/links.ts). */
  links: Items<Link>
  /** Highest Lamport value seen. Not a section: the max of two replicas. */
  lamport: number
  /** Wall clock of the last edit anyone made, for fading. Also merged as a max. */
  touchedAt: number
}

export const LISTS = [
  "people",
  "sessions",
  "files",
  "branches",
  "features",
  "questions",
  "notes",
  "links",
] as const
export type ListName = (typeof LISTS)[number]
export const SECTIONS = ["meta", ...LISTS] as const
export type SectionName = (typeof SECTIONS)[number]

/** Version 1's sections, read by parseThread and format.ts and never written. */
export const LEGACY_LISTS = { decisions: "decision", facts: "fact", tasks: "task", rules: "rule" } as const
export const LEGACY_SECTIONS = ["recap", ...Object.keys(LEGACY_LISTS)] as const

/**
 * What is worth a commit on the ref: the meta, features and questions, and the
 * decisions and rules among the notes. The rest travels over the relay only.
 */
export const COMMITTED: readonly SectionName[] = ["meta", "features", "questions", "notes"]
const COMMITTED_NOTES: ReadonlySet<NoteKind> = new Set(["decision", "rule"])

export const newThreadId = () => crypto.randomBytes(8).toString("hex")
export const newItemId = (prefix: string) => `${prefix}_${crypto.randomBytes(5).toString("hex")}`

/** True when `a` was written after `b`. */
export const newer = (a: Stamp, b: Stamp) => (a.l !== b.l ? a.l > b.l : a.by > b.by)

export function create(o: {
  id?: string
  name: string
  repo: string
  by: string
  label: string
  now?: number
  public?: boolean
}): Thread {
  const now = o.now ?? Date.now()
  const s: Stamp = { l: 1, by: o.by }
  return {
    v: 2,
    id: o.id ?? newThreadId(),
    meta: { ...s, value: { name: o.name, status: "active", public: !!o.public, repo: o.repo, createdAt: now, createdBy: o.by } },
    people: { [o.by]: { ...s, id: o.by, label: o.label } },
    sessions: {},
    files: {},
    branches: {},
    features: {},
    questions: {},
    notes: {},
    links: {},
    lamport: 1,
    touchedAt: now,
  }
}

function mergeItems<T>(a: Items<T> = {}, b: Items<T> = {}): Items<T> {
  const out: Items<T> = { ...a }
  for (const [id, it] of Object.entries(b)) {
    const mine = out[id]
    if (!mine || newer(it, mine)) out[id] = it
  }
  return out
}

const pick = <T>(a: Scalar<T>, b: Scalar<T>) => (newer(b, a) ? b : a)

/** Both replicas' edits, whichever order they are merged in. */
export function merge(a: Thread, b: Thread): Thread {
  if (a.id !== b.id) throw new Error(`cannot merge thread ${a.id} with ${b.id}`)
  const out: Thread = {
    ...a,
    meta: pick(a.meta, b.meta),
    lamport: Math.max(a.lamport, b.lamport),
    touchedAt: Math.max(a.touchedAt, b.touchedAt),
  }
  for (const k of LISTS) (out as any)[k] = mergeItems((a as any)[k], (b as any)[k])
  return out
}

/** Same content, ignoring key order. */
export function same(a: Thread | undefined, b: Thread | undefined): boolean {
  return canonical(a) === canonical(b)
}

export function canonical(v: unknown): string {
  if (v === undefined) return "null"
  return JSON.stringify(v, (_k, x) =>
    x && typeof x === "object" && !Array.isArray(x)
      ? Object.fromEntries(Object.entries(x).sort(([p], [q]) => (p < q ? -1 : p > q ? 1 : 0)))
      : x,
  )
}

/** What the sections that earn a commit look like, to tell whether they changed. */
export function committedDigest(t: Thread): string {
  const h = crypto.createHash("sha256")
  for (const s of COMMITTED) {
    const v = s === "notes" ? Object.fromEntries(Object.entries(t.notes).filter(([, n]) => COMMITTED_NOTES.has(n.kind))) : (t as any)[s]
    h.update(s + canonical(v))
  }
  return h.digest("hex").slice(0, 16)
}

// --- editing ------------------------------------------------------------------

/** The next stamp on this replica. Every edit takes one. */
export function tick(t: Thread, by: string, now = Date.now()): Stamp {
  t.lamport += 1
  t.touchedAt = Math.max(t.touchedAt, now)
  return { l: t.lamport, by }
}

export function setMeta(t: Thread, by: string, patch: Partial<Meta>, now = Date.now()): boolean {
  const next = { ...t.meta.value, ...patch }
  if (canonical(next) === canonical(t.meta.value)) return false
  t.meta = { ...tick(t, by, now), value: next }
  return true
}

/** The thread's recap, or "" when it has none. */
export function recap(t: Thread): string {
  const r = t.notes[RECAP_ID]
  return r && !r.gone && r.kind === "recap" ? r.text : ""
}

export function setRecap(t: Thread, by: string, text: string, now = Date.now()): boolean {
  if (recap(t) === text) return false
  t.notes[RECAP_ID] = { kind: "recap", text, who: "", at: now, ...tick(t, by, now), id: RECAP_ID }
  return true
}

/** The live notes, oldest first; of one kind when `kind` is given. An empty recap is no note. */
export function notes<K extends NoteKind>(t: Thread, kind: K): Item<NoteOf<K>>[]
export function notes(t: Thread, kind?: NoteKind | readonly NoteKind[]): Item<Note>[]
export function notes(t: Thread, kind?: NoteKind | readonly NoteKind[]): Item<Note>[] {
  const want = kind === undefined ? null : new Set(typeof kind === "string" ? [kind] : kind)
  return live(t, "notes").filter((n) => (!want || want.has(n.kind)) && !(n.kind === "recap" && !n.text))
}

/** Add or replace a note. The id's prefix says its kind, as ids always have (d_, f_, t_, r_). */
export function note(t: Thread, data: Note, by: string, now = Date.now(), id = newItemId(data.kind[0]!)): string {
  put(t, "notes", id, data, by, now)
  return id
}

/** One note by id, of a kind; undefined when gone or of another kind. */
export function noteOf<K extends NoteKind>(t: Thread | undefined, id: string | undefined, kind: K): Item<NoteOf<K>> | undefined {
  const n = t && id ? t.notes[id] : undefined
  return n && !n.gone && n.kind === kind ? (n as Item<NoteOf<K>>) : undefined
}

/** An item without its stamp and id: what an edit writes. Distributes over a union (a note of each kind). */
export type Data<T> = T extends unknown ? Omit<T, keyof Stamp | "id" | "gone"> : never

/** Add or replace one item. No change, no stamp, so a repeated observation costs nothing. */
export function put<K extends ListName>(
  t: Thread,
  list: K,
  id: string,
  data: Data<Thread[K][string]>,
  by: string,
  now = Date.now(),
): boolean {
  const items = t[list] as Items<any>
  const before = items[id]
  if (before && !before.gone) {
    const { l: _l, by: _b, id: _i, gone: _g, ...rest } = before
    if (canonical(rest) === canonical(data)) return false
  }
  items[id] = { ...(data as object), ...tick(t, by, now), id }
  return true
}

export function remove(t: Thread, list: ListName, id: string, by: string, now = Date.now()): boolean {
  const items = t[list] as Items<any>
  const before = items[id]
  if (!before || before.gone) return false
  items[id] = { ...before, ...tick(t, by, now), id, gone: true }
  return true
}

/** The items that are still there, oldest first by their own time when they have one. */
export function live<K extends ListName>(t: Thread, list: K): Thread[K][string][] {
  return Object.values(t[list] as Items<any>)
    .filter((i) => !i.gone)
    .sort((a, b) => (a.at ?? 0) - (b.at ?? 0) || (a.id < b.id ? -1 : 1)) as any
}

export const ids = (t: Thread, list: ListName) => live(t, list).map((i: any) => i.id as string)

export const isLive = (t: Thread) => !t.meta.value.combinedInto && t.meta.value.status !== "archived"

/** A slug for names and ids: lower case, letters, digits and dashes. */
export function slug(s: string, max = 40): string {
  return (
    s
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, max)
      .replace(/-+$/g, "") || "thread"
  )
}

/** A plain object anyone can read: what the tool and the summary show. */
export function view(t: Thread) {
  const m = t.meta.value
  return {
    id: t.id,
    name: m.name,
    status: m.status,
    public: m.public,
    repo: m.repo,
    combinedInto: m.combinedInto,
    people: live(t, "people").map((p) => p.label),
    sessions: live(t, "sessions").map((s) => `${s.label}/${s.name}${s.branch ? ` @ ${s.branch}` : ""}`),
    files: ids(t, "files"),
    branches: ids(t, "branches"),
    features: live(t, "features").map((f) => ({ name: f.name, risk: f.risk, ...(f.flag ? { flag: f.flag } : {}) })),
    recap: recap(t),
    questions: live(t, "questions").map((q) => ({ id: q.id, text: q.text, blocking: !!q.blocking, who: q.who, ...(q.answer ? { answer: q.answer, answeredBy: q.answeredBy } : {}) })),
    notes: notes(t, ["decision", "fact", "task", "rule"]).map(noteView),
    touchedAt: t.touchedAt,
  }
}

/** A note as the tool and the summary show it: its kind and text, who and when, and its kind's own fields. */
export type NoteView = { id: string; kind: NoteKind; text: string; who: string; at: number; state?: TaskState; claimedBy?: string; doneBy?: string; note?: string; rationale?: string; when?: string; then?: string; confirmed?: string[] }

export function noteView(n: Item<Note>): NoteView {
  const base = { id: n.id, kind: n.kind, text: n.text, who: n.who, at: n.at }
  switch (n.kind) {
    case "decision":
      return { ...base, ...(n.rationale ? { rationale: n.rationale } : {}) }
    case "task":
      return { ...base, state: n.state, ...(n.claimedBy ? { claimedBy: n.claimedBy } : {}), ...(n.doneBy ? { doneBy: n.doneBy } : {}), ...(n.note ? { note: n.note } : {}) }
    case "fact":
      return { ...base, ...(n.confirmed?.length ? { confirmed: n.confirmed.map((c) => c.by) } : {}) }
    case "rule":
      return { ...base, ...(n.when ? { when: n.when } : {}), ...(n.then ? { then: n.then } : {}) }
  }
  return base
}


/** Accept a thread from a peer or a file only if it has the shape; anything else is absent. */
export function parseThread(v: unknown): Thread | null {
  if (!v || typeof v !== "object") return null
  const o = v as any
  if ((o.v !== 1 && o.v !== 2) || typeof o.id !== "string" || !/^[0-9a-f]{8,32}$/.test(o.id)) return null
  const stamp = (s: any) => s && typeof s.l === "number" && typeof s.by === "string"
  if (!stamp(o.meta) || !o.meta.value || typeof o.meta.value.name !== "string" || !STATUSES.includes(o.meta.value.status))
    return null
  const out: any = {
    v: 2,
    id: o.id,
    meta: { l: o.meta.l, by: o.meta.by, value: { ...o.meta.value, name: slug(o.meta.value.name), public: !!o.meta.value.public, repo: String(o.meta.value.repo ?? "") } },
    lamport: Number(o.lamport) || 0,
    touchedAt: Number(o.touchedAt) || 0,
  }
  const itemsOf = (src: any) => {
    const items: Record<string, any> = {}
    for (const [id, it] of Object.entries(src && typeof src === "object" ? src : {}).slice(0, 2000))
      if (stamp(it) && typeof id === "string" && id.length <= 300 && (it as any).id === id) items[id] = it
    return items
  }
  for (const k of LISTS) out[k] = itemsOf(o[k])
  // Notes: their kind must be one of ours. Then version 1's lists and recap
  // fold in, item by item, the newer stamp winning where an id is in both: a
  // replica that holds both shapes (one updated mid-thread) merges as one.
  const notes: Record<string, any> = {}
  for (const [id, n] of Object.entries(out.notes as Record<string, any>)) if (NOTE_KINDS.includes(n.kind)) notes[id] = n
  const fold = (id: string, n: any) => {
    if (!notes[id] || newer(n, notes[id])) notes[id] = n
  }
  for (const [list, kind] of Object.entries(LEGACY_LISTS))
    for (const [id, it] of Object.entries(itemsOf(o[list]))) fold(id, { ...it, kind })
  if (stamp(o.recap) && typeof o.recap.value === "string")
    fold(RECAP_ID, { kind: "recap", text: o.recap.value, who: "", at: 0, l: o.recap.l, by: o.recap.by, id: RECAP_ID })
  const r = notes[RECAP_ID]
  if (r) notes[RECAP_ID] = { ...r, text: String(r.text ?? "").slice(0, 4000) }
  out.notes = notes
  for (const k of [out.meta, ...LISTS.flatMap((k) => Object.values(out[k]))] as Stamp[]) out.lamport = Math.max(out.lamport, k.l)
  return out as Thread
}

/** True when a value is in version 1's shape: it is written back as notes on the next commit. */
export const isLegacy = (v: unknown) => !!v && typeof v === "object" && ((v as any).v === 1 || LEGACY_SECTIONS.some((k) => (v as any)[k] !== undefined))

/** The fingerprints of everyone in a thread. */
export const people = (t: Thread) => ids(t, "people")
