// Every URL crosstalk knows of, labelled (docs/urls.md).
//
// One record per thing a person might look at: a local server (a crosstalk
// service's port, or a localhost URL a command printed), a preview, a pull
// request, or a link a command printed. Kept in <crosstalk home>/urls.json,
// read and written under a lock by the hook, the MCP server, `crosstalk ui`
// and the daemon alike.
//
//   bounded    dead ones go after 7 days, links not seen again after 7 days,
//              at most CAP_PER_GROUP per thread (or worktree) and CAP_ALL in all
//   listed     dead ones stay in lists for a grace period (10 minutes,
//              CROSSTALK_URL_GRACE_MS), marked dead, then drop out
//
// This is the boundary later builds use (sharing, screenshots, self-healing,
// history): open a store with urlStore() (or `urls()` from ./index.ts, which
// also knows the thread of a session or worktree) and use add / update / get /
// list / forThread / forSession / markOk / markDead / remove / prune.

import crypto from "node:crypto"
import fs from "node:fs"
import path from "node:path"
import { P } from "../config.ts"

/** `shared`: a running server shared with a teammate, or by one (src/share/); never checked for liveness. */
export type UrlKind = "local" | "preview" | "pr" | "link" | "shared"
/** Where crosstalk learnt of it. Only `output` links are never fetched (liveness checks local ones alone). */
export type UrlSource = "service" | "preview" | "pr" | "output" | "manual" | "share"

export type Url = {
  /** Stable for the thing it names: `svc:<service id>`, `preview:<thread>:<feature>`, `pr:<url>`, `out:<hash>`. */
  id: string
  url: string
  kind: UrlKind
  /** What it is, for a person: `auth · dev server`, `auth · preview`, `auth · PR #12`. */
  label: string
  source: UrlSource
  thread?: string
  sessionId?: string
  /** The worktree's top folder. */
  worktree?: string
  /** The crosstalk service it belongs to, by name. */
  service?: string
  /** A shipping feature it belongs to (previews, PRs). */
  feature?: string
  /** Its name through the local proxy, `auth.localhost` (no port: the proxy's port is added when shown). */
  name?: string
  firstSeen: number
  /** Last time something reported it again (a sync, a command printing it). */
  lastSeen: number
  /** Last time it answered. */
  lastOk?: number
  /** Last time it was checked; 0 when never. */
  lastCheck: number
  alive: boolean
  /** Since when it has been dead. */
  deadSince?: number
  /** Failed checks in a row. */
  fails?: number
  /** The HTTP status of its last answer. */
  status?: number
  /** A PR's state from gh (OPEN, MERGED, CLOSED). */
  state?: string
  /** A PR's checks (src/urls/ci.ts): running, passed, failed or none. */
  checks?: "running" | "passed" | "failed" | "none"
  /** Which checks failed. */
  failed?: string[]
  /** Since when its checks have been running, for the ETA. */
  checksSince?: number
  draft?: boolean
  /** A PR's own title (gh). */
  title?: string
  /** In its repository's merge queue, as last seen, and what crosstalk keeps about it (src/urls/queue.ts). */
  queued?: boolean
  queuedAt?: number
  queueRetries?: number
  queueStuckTold?: number
  queueSeenRemoval?: number
  /**
   * A public https link to this local server while one is open (src/share/,
   * `public: true` only): what a phone's QR code encodes. Never set for a share
   * with people, which only opens through their own crosstalk proxy.
   */
  shareUrl?: string
}

/** What a caller gives `add`: the record without the bookkeeping. */
export type NewUrl = Omit<Url, "id" | "firstSeen" | "lastSeen" | "lastCheck" | "alive"> & {
  id?: string
  alive?: boolean
  lastCheck?: number
}

export type Filter = {
  thread?: string
  kind?: UrlKind
  /** true: answering only; false: dead only; undefined: both, dead ones within the grace period. */
  alive?: boolean
  sessionId?: string
  worktree?: string
  /** Dead ones past the grace period too. */
  all?: boolean
}

export const DAY = 24 * 60 * 60 * 1000
export const KEEP_DEAD_MS = 7 * DAY
export const KEEP_UNSEEN_LINK_MS = 7 * DAY
export const CAP_PER_GROUP = 40
export const CAP_ALL = 400
export const graceMs = () => Number(process.env.CROSSTALK_URL_GRACE_MS ?? 10 * 60_000)

export const idFor = (kind: UrlKind, url: string, scope = "") => `${kind === "link" || kind === "local" ? "out" : kind}:${crypto.createHash("sha1").update(`${url}\0${scope}`).digest("hex").slice(0, 16)}`

/** The group a record counts against for the cap: its thread, else its worktree, else its session. */
export const groupKey = (u: Pick<Url, "thread" | "worktree" | "sessionId">) => u.thread ?? u.worktree ?? u.sessionId ?? ""

/** Shown in a list now: alive, or dead for less than the grace period. */
export const shown = (u: Url, now: number, grace = graceMs()) => u.alive || (u.deadSince ?? u.lastCheck) > now - grace

/**
 * Pruning, pure: dead ones older than a week, links nobody printed again in a
 * week, then the caps (dead first, then links, then the least recently seen).
 */
export function pruned(all: Url[], now: number, o: { perGroup?: number; total?: number } = {}): Url[] {
  const perGroup = o.perGroup ?? CAP_PER_GROUP
  const total = o.total ?? CAP_ALL
  let keep = all.filter((u) => {
    if (!u.alive && now - (u.deadSince ?? u.lastSeen) > KEEP_DEAD_MS) return false
    if (u.source === "output" && now - u.lastSeen > KEEP_UNSEEN_LINK_MS) return false
    return true
  })
  // Worst first: dead, then a link found in output, then the oldest.
  const worth = (u: Url) => [u.alive ? 1 : 0, u.source === "output" ? 0 : 1, u.lastSeen] as const
  const cmp = (a: Url, b: Url) => {
    const x = worth(a)
    const y = worth(b)
    return x[0] - y[0] || x[1] - y[1] || x[2] - y[2]
  }
  const groups = new Map<string, Url[]>()
  for (const u of keep) groups.set(groupKey(u), [...(groups.get(groupKey(u)) ?? []), u])
  const drop = new Set<string>()
  for (const g of groups.values()) if (g.length > perGroup) for (const u of [...g].sort(cmp).slice(0, g.length - perGroup)) drop.add(u.id)
  keep = keep.filter((u) => !drop.has(u.id))
  if (keep.length > total) {
    const out = new Set([...keep].sort(cmp).slice(0, keep.length - total).map((u) => u.id))
    keep = keep.filter((u) => !out.has(u.id))
  }
  return keep
}

const sleepSync = (ms: number) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms)

export type StoreOptions = {
  /** Default <crosstalk home>/urls.json. */
  file?: string
  now?: () => number
  /** The thread a record belongs to when it was not known as it was added: a session's or a worktree's. */
  threadOf?: (u: Url) => string | undefined
}

export class UrlStore {
  readonly file: string
  private now: () => number
  private threadOf?: (u: Url) => string | undefined
  constructor(o: StoreOptions = {}) {
    this.file = o.file ?? path.join(P.root, "urls.json")
    this.now = o.now ?? Date.now
    this.threadOf = o.threadOf
  }

  /** Every record, as stored. */
  read(): Url[] {
    try {
      const raw = JSON.parse(fs.readFileSync(this.file, "utf8"))
      return Array.isArray(raw?.urls) ? raw.urls.filter((u: any) => u && typeof u.id === "string" && typeof u.url === "string") : []
    } catch {
      return []
    }
  }

  private write(all: Url[]) {
    fs.mkdirSync(path.dirname(this.file), { recursive: true, mode: 0o700 })
    const tmp = `${this.file}.${process.pid}.tmp`
    fs.writeFileSync(tmp, JSON.stringify({ v: 1, urls: all }, null, 1), { mode: 0o600 })
    fs.renameSync(tmp, this.file)
  }

  /** Read, change and write under a lock (a directory; one held for over five seconds is taken as abandoned). */
  mutate<T>(fn: (all: Url[], now: number) => T): T {
    fs.mkdirSync(path.dirname(this.file), { recursive: true, mode: 0o700 })
    const lock = `${this.file}.lock`
    let held = false
    for (let i = 0; i < 300 && !held; i++) {
      try {
        fs.mkdirSync(lock)
        held = true
      } catch {
        try {
          if (Date.now() - fs.statSync(lock).mtimeMs > 5000) fs.rmdirSync(lock)
        } catch {}
        sleepSync(10)
      }
    }
    try {
      const all = this.read()
      const now = this.now()
      const out = fn(all, now)
      this.write(pruned(all, now))
      return out
    } finally {
      if (held)
        try {
          fs.rmdirSync(lock)
        } catch {}
    }
  }

  /**
   * Add one, or refresh the one with the same id: its url, label and the rest
   * as given, seen now. A new one is taken as alive until a check says not; an
   * existing one keeps what the checks found unless `alive` is given.
   */
  add(n: NewUrl): Url {
    return this.mutate((all, now) => {
      const id = n.id ?? idFor(n.kind, n.url, n.worktree ?? n.thread ?? n.sessionId ?? "")
      const i = all.findIndex((u) => u.id === id)
      const given = Object.fromEntries(Object.entries(n).filter(([, v]) => v !== undefined)) as Partial<Url>
      if (i === -1) {
        const u: Url = { ...given, id, firstSeen: now, lastSeen: now, lastCheck: n.lastCheck ?? 0, alive: n.alive ?? true } as Url
        all.push(u)
        return u
      }
      const was = all[i]
      // The URL moved (a service on another port): what was found about the old one no longer holds.
      const moved = was.url !== n.url
      const u: Url = {
        ...was,
        ...given,
        id,
        firstSeen: was.firstSeen,
        lastSeen: now,
        lastCheck: moved ? 0 : was.lastCheck,
        alive: n.alive ?? (moved ? true : was.alive),
      }
      if (u.alive) {
        delete u.deadSince
        if (moved) delete u.fails
      }
      all[i] = u
      return u
    })
  }

  /** Change fields of one; undefined when there is no such record. */
  update(id: string, patch: Partial<Omit<Url, "id">>): Url | undefined {
    return this.mutate((all) => {
      const i = all.findIndex((u) => u.id === id)
      if (i === -1) return undefined
      all[i] = { ...all[i], ...patch }
      return all[i]
    })
  }

  get(id: string): Url | undefined {
    return this.read().find((u) => u.id === id)
  }

  remove(id: string): boolean {
    return this.mutate((all) => {
      const i = all.findIndex((u) => u.id === id)
      if (i !== -1) all.splice(i, 1)
      return i !== -1
    })
  }

  /** It answered: alive, checked now. */
  markOk(id: string, o: { status?: number; state?: string; at?: number } = {}): Url | undefined {
    return this.mutate((all, now) => {
      const u = all.find((x) => x.id === id)
      if (!u) return undefined
      const at = o.at ?? now
      Object.assign(u, { alive: true, lastOk: at, lastCheck: at, fails: 0 }, o.status !== undefined ? { status: o.status } : {}, o.state !== undefined ? { state: o.state } : {})
      delete u.deadSince
      return u
    })
  }

  /** It does not answer (or a PR is no longer open): dead from now, kept in lists for the grace period. */
  markDead(id: string, o: { at?: number; state?: string; status?: number } = {}): Url | undefined {
    return this.mutate((all, now) => {
      const u = all.find((x) => x.id === id)
      if (!u) return undefined
      const at = o.at ?? now
      u.lastCheck = at
      if (u.alive || u.deadSince === undefined) u.deadSince = at
      u.alive = false
      if (o.state !== undefined) u.state = o.state
      if (o.status !== undefined) u.status = o.status
      return u
    })
  }

  /** A check failed: counted, and dead at `after` failures in a row. */
  markFailed(id: string, after = 2): Url | undefined {
    const u = this.mutate((all, now) => {
      const x = all.find((y) => y.id === id)
      if (!x) return undefined
      x.fails = (x.fails ?? 0) + 1
      x.lastCheck = now
      return { ...x }
    })
    return u && (u.fails ?? 0) >= after ? this.markDead(id) : u
  }

  /** Apply the pruning rules now. */
  prune(): number {
    return this.mutate((all, now) => all.length - pruned(all, now).length)
  }

  /** A record's thread: as stored, else from its session or worktree. */
  thread(u: Url): string | undefined {
    if (u.thread) return u.thread
    try {
      return this.threadOf?.(u)
    } catch {
      return undefined
    }
  }

  /** Records, newest first, matching the filter; dead ones past the grace period left out unless asked for. */
  list(f: Filter = {}): Url[] {
    const now = this.now()
    const want = f.thread?.toLowerCase()
    return this.read()
      .filter((u) => (f.all || f.alive === false ? true : shown(u, now)))
      .filter((u) => f.alive === undefined || u.alive === f.alive)
      .filter((u) => !f.kind || u.kind === f.kind)
      .filter((u) => !f.sessionId || u.sessionId === f.sessionId)
      .filter((u) => !f.worktree || u.worktree === f.worktree)
      .map((u) => (u.thread ? u : { ...u, ...(this.thread(u) ? { thread: this.thread(u) } : {}) }))
      .filter((u) => !want || (u.thread ?? "").toLowerCase() === want)
      .sort((a, b) => Number(b.alive) - Number(a.alive) || b.lastSeen - a.lastSeen)
  }

  /** A thread's: by its name. */
  forThread(name: string, f: Omit<Filter, "thread"> = {}): Url[] {
    return this.list({ ...f, thread: name })
  }

  /** A session's: what it printed, what runs in its worktree, and its thread's. */
  forSession(o: { sessionId: string; worktree?: string; thread?: string }, f: Omit<Filter, "sessionId" | "worktree" | "thread"> = {}): Url[] {
    const all = this.list(f)
    return all.filter((u) => u.sessionId === o.sessionId || (o.worktree && u.worktree === o.worktree) || (o.thread && u.thread === o.thread))
  }
}

export const urlStore = (o: StoreOptions = {}) => new UrlStore(o)
