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
//   meta, recap     one value each, last writer wins
//   everything else a set of items keyed by id, last writer wins per item,
//                   removal is a tombstone (`gone`) so it wins over a stale add
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
  /** A shipping question (src/shipping/remote.ts): what a person on another machine needs to answer it. */
  ship?: { kind: string; feature: string; options: string[]; asker: string; stage?: string }
  /** A person's answer to a shipping question from another machine, signed with their key. */
  vote?: { pick: string; fp: string; label: string; at: number; sig: string }
}
export type Decision = { text: string; who: string; at: number; rationale?: string; session?: string }
export type Fact = { text: string; who: string; at: number }
export type TaskState = "open" | "claimed" | "done"
export type Task = { text: string; who: string; at: number; state: TaskState; claimedBy?: string; doneBy?: string; note?: string }
/**
 * A standing rule ("Answers become rules"). Another build decides what a rule
 * matches and does; the format only keeps a place for them. `when` describes
 * the kind of question, `then` the standing answer.
 */
export type Rule = { text: string; who: string; at: number; when?: string; then?: string; sig?: string }
/** Files and branches are sets of strings: the id is the value. */
export type Mark = { at: number }

export type Thread = {
  v: 1
  id: string
  meta: Scalar<Meta>
  recap: Scalar<string>
  people: Items<Person>
  sessions: Items<SessionRef>
  files: Items<Mark>
  branches: Items<Mark>
  features: Items<Feature>
  questions: Items<Question>
  decisions: Items<Decision>
  facts: Items<Fact>
  tasks: Items<Task>
  rules: Items<Rule>
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
  "decisions",
  "facts",
  "tasks",
  "rules",
  "links",
] as const
export type ListName = (typeof LISTS)[number]
export const SECTIONS = ["meta", "recap", ...LISTS] as const
export type SectionName = (typeof SECTIONS)[number]

/** Sections whose change is worth a commit on the ref. The rest travels over the relay only. */
export const COMMITTED: readonly SectionName[] = ["meta", "features", "decisions", "questions", "rules"]

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
    v: 1,
    id: o.id ?? newThreadId(),
    meta: { ...s, value: { name: o.name, status: "active", public: !!o.public, repo: o.repo, createdAt: now, createdBy: o.by } },
    recap: { ...s, value: "" },
    people: { [o.by]: { ...s, id: o.by, label: o.label } },
    sessions: {},
    files: {},
    branches: {},
    features: {},
    questions: {},
    decisions: {},
    facts: {},
    tasks: {},
    rules: {},
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
    recap: pick(a.recap, b.recap),
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
  for (const s of COMMITTED) h.update(s + canonical((t as any)[s]))
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

export function setRecap(t: Thread, by: string, text: string, now = Date.now()): boolean {
  if (t.recap.value === text) return false
  t.recap = { ...tick(t, by, now), value: text }
  return true
}

/** Add or replace one item. No change, no stamp, so a repeated observation costs nothing. */
export function put<K extends ListName>(
  t: Thread,
  list: K,
  id: string,
  data: Omit<Thread[K][string], keyof Stamp | "id" | "gone">,
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
    recap: t.recap.value,
    questions: live(t, "questions").map((q) => ({ id: q.id, text: q.text, blocking: !!q.blocking, who: q.who, ...(q.answer ? { answer: q.answer, answeredBy: q.answeredBy } : {}) })),
    decisions: live(t, "decisions").map((d) => ({ id: d.id, text: d.text, who: d.who, at: d.at, ...(d.rationale ? { rationale: d.rationale } : {}) })),
    facts: live(t, "facts").map((f) => ({ id: f.id, text: f.text, who: f.who, at: f.at })),
    tasks: live(t, "tasks").map((k) => ({ id: k.id, text: k.text, who: k.who, state: k.state, ...(k.claimedBy ? { claimedBy: k.claimedBy } : {}), ...(k.note ? { note: k.note } : {}) })),
    rules: live(t, "rules").map((r) => ({ id: r.id, text: r.text, who: r.who })),
    touchedAt: t.touchedAt,
  }
}

/** Accept a thread from a peer or a file only if it has the shape; anything else is absent. */
export function parseThread(v: unknown): Thread | null {
  if (!v || typeof v !== "object") return null
  const o = v as any
  if (o.v !== 1 || typeof o.id !== "string" || !/^[0-9a-f]{8,32}$/.test(o.id)) return null
  const stamp = (s: any) => s && typeof s.l === "number" && typeof s.by === "string"
  if (!stamp(o.meta) || !o.meta.value || typeof o.meta.value.name !== "string" || !STATUSES.includes(o.meta.value.status))
    return null
  if (!stamp(o.recap) || typeof o.recap.value !== "string") return null
  const out: any = {
    v: 1,
    id: o.id,
    meta: { l: o.meta.l, by: o.meta.by, value: { ...o.meta.value, name: slug(o.meta.value.name), public: !!o.meta.value.public, repo: String(o.meta.value.repo ?? "") } },
    recap: { l: o.recap.l, by: o.recap.by, value: o.recap.value.slice(0, 4000) },
    lamport: Number(o.lamport) || 0,
    touchedAt: Number(o.touchedAt) || 0,
  }
  for (const k of LISTS) {
    const src = o[k] && typeof o[k] === "object" ? o[k] : {}
    const items: Record<string, unknown> = {}
    for (const [id, it] of Object.entries(src).slice(0, 2000))
      if (stamp(it) && typeof id === "string" && id.length <= 300 && (it as any).id === id) items[id] = it
    out[k] = items
  }
  for (const k of [out.meta, out.recap, ...LISTS.flatMap((k) => Object.values(out[k]))] as Stamp[])
    out.lamport = Math.max(out.lamport, k.l)
  return out as Thread
}

/** The fingerprints of everyone in a thread. */
export const people = (t: Thread) => ids(t, "people")
