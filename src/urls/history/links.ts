// A thread's history of what there was to look at (docs/urls.md, "History"):
// every link, preview, pull request and screenshot the thread ever had, kept
// in the thread itself as its `links` section, so it outlives urls.json (which
// forgets dead records after a week) and reaches the thread's people.
//
// The section is a set of items like every other list in a thread
// (src/threads/model.ts): merged per item, last writer wins, sealed with the
// rest of a sealed thread. What goes in is chosen so it can travel:
//
//   local servers   by name (`auth.localhost`, else the label's `auth · :5173`)
//                   and path, never the port's query string or anything after #
//   everything else the URL as urls.json keeps it (credentials already taken
//                   out, src/urls/extract.ts), without its fragment
//   screenshots     the path on the machine that took it, and that machine's
//                   name: the file itself never leaves that machine
//
// Bounded: MAX_LINKS kept in full; the least recently seen beyond that are
// folded, which leaves a small tombstone (so a replica that still has one
// does not bring it back) counted as "N older links"; past MAX_FOLDED
// tombstones the oldest are dropped into a single running count.

import crypto from "node:crypto"
import type { Item, Items, Stamp, Thread } from "../../threads/model.ts"
import { tick } from "../../threads/model.ts"

export type LinkKind = "local" | "preview" | "pr" | "link"

/** One screenshot of a link, where it was taken. */
export type Shot = { path: string; at: number; machine: string; note?: string }

/** One entry of a thread's `links` section. `at` is when it was first seen (what lists sort by). */
export type Link = {
  url: string
  kind: LinkKind
  label: string
  /** A local server's name through crosstalk's proxy, `auth.localhost`. */
  name?: string
  service?: string
  feature?: string
  first: number
  last: number
  at: number
  shots?: Shot[]
  /** A folded entry's tombstone. */
  folded?: true
  /** Only on FOLD_ID: how many folded entries were dropped altogether. */
  count?: number
}

export const MAX_LINKS = 100
export const MAX_FOLDED = 300
export const MAX_SHOTS = 12
/** `last` is moved forward at most this often, so a URL seen every few seconds is not an edit every few seconds. */
export const SEEN_STEP_MS = 60 * 60_000
export const FOLD_ID = "ln__folded"

export const linkId = (key: string) => `ln_${crypto.createHash("sha1").update(key).digest("hex").slice(0, 12)}`

/** What a link is stored as: local URLs by name and path, nothing after `?` or `#`; others without the fragment. */
export function storedUrl(o: { url: string; kind: LinkKind; name?: string }): string {
  let u: URL
  try {
    u = new URL(o.url)
  } catch {
    return ""
  }
  if (!/^https?:$/.test(u.protocol)) return ""
  if (o.kind === "local") {
    const host = o.name ? o.name : u.host
    const p = u.pathname === "/" ? "" : u.pathname
    return `${u.protocol}//${host}${p}`.slice(0, 300)
  }
  u.hash = ""
  u.username = ""
  u.password = ""
  return u.toString().slice(0, 400)
}

/** The identity of a link across sessions and ports: a local server by its name or label, anything else by its URL. */
export function keyOf(o: { url: string; kind: LinkKind; name?: string; label: string }): string {
  if (o.kind === "local") return `local:${o.name ?? o.label}`
  if (o.kind === "preview") return `preview:${o.label}`
  return `${o.kind}:${storedUrl(o)}`
}

export type Seen = { url: string; kind: LinkKind; label: string; name?: string; service?: string; feature?: string; seen: number; first?: number; shot?: Shot }

const live = (t: Thread) => Object.values(t.links ?? {}).filter((i) => !i.gone) as Item<Link>[]

/** What the entry would be after `s`, or null when nothing would change. Pure. */
export function next(t: Thread, s: Seen): { id: string; data: Link } | null {
  const url = storedUrl(s)
  if (!url) return null
  const id = linkId(keyOf(s))
  const before = (t.links ?? {})[id]
  const was = before && !before.gone ? before : undefined
  const shots = [...(was?.shots ?? [])]
  if (s.shot && !shots.some((x) => x.path === s.shot!.path && x.machine === s.shot!.machine)) shots.push(s.shot)
  shots.sort((a, b) => a.at - b.at)
  const first = Math.min(was?.first ?? Infinity, s.first ?? s.seen, s.seen)
  const last = was && s.seen - was.last < SEEN_STEP_MS ? was.last : Math.max(was?.last ?? 0, s.seen)
  const data: Link = {
    url: s.kind === "local" && was?.url && !s.name ? was.url : url,
    kind: s.kind,
    label: s.label.slice(0, 120),
    ...(s.name || was?.name ? { name: s.name ?? was?.name } : {}),
    ...(s.service || was?.service ? { service: s.service ?? was?.service } : {}),
    ...(s.feature || was?.feature ? { feature: s.feature ?? was?.feature } : {}),
    first,
    last,
    at: first,
    ...(shots.length ? { shots: shots.slice(-MAX_SHOTS) } : {}),
  }
  if (was) {
    const { l: _l, by: _b, id: _i, gone: _g, ...rest } = was
    if (JSON.stringify(sortKeys(rest)) === JSON.stringify(sortKeys(data))) return null
  }
  return { id, data }
}

const sortKeys = (o: object) => Object.fromEntries(Object.entries(o).sort(([a], [b]) => (a < b ? -1 : 1)))

/** Record that the thread had this link (and maybe a screenshot of it). True when the thread changed. */
export function record(t: Thread, by: string, s: Seen, now = Date.now()): boolean {
  t.links ??= {}
  const n = next(t, s)
  if (!n) return false
  t.links[n.id] = { ...n.data, ...tick(t, by, now), id: n.id }
  cap(t, by, now)
  return true
}

/** Keep MAX_LINKS; fold the least recently seen; past MAX_FOLDED tombstones, a running count. */
export function cap(t: Thread, by: string, now = Date.now(), max = MAX_LINKS, maxFolded = MAX_FOLDED): number {
  const items = (t.links ??= {}) as Items<Link>
  const all = live(t).filter((i) => i.id !== FOLD_ID)
  let folded = 0
  if (all.length > max) {
    const drop = [...all].sort((a, b) => a.last - b.last || (a.id < b.id ? -1 : 1)).slice(0, all.length - max)
    for (const d of drop) {
      const st: Stamp = tick(t, by, now)
      items[d.id] = { id: d.id, ...st, gone: true, folded: true, url: "", kind: d.kind, label: "", first: d.first, last: d.last, at: d.first } as Item<Link>
      folded++
    }
  }
  const tombs = Object.values(items).filter((i) => i.gone && i.folded && i.id !== FOLD_ID)
  if (tombs.length > maxFolded) {
    const gone = [...tombs].sort((a, b) => a.last - b.last || (a.id < b.id ? -1 : 1)).slice(0, tombs.length - Math.floor(maxFolded / 2))
    const prev = items[FOLD_ID]
    const st: Stamp = tick(t, by, now)
    items[FOLD_ID] = {
      id: FOLD_ID,
      ...st,
      gone: true,
      url: "",
      kind: "link",
      label: "",
      first: Math.min(prev?.first ?? Infinity, ...gone.map((g) => g.first)),
      last: Math.max(prev?.last ?? 0, ...gone.map((g) => g.last)),
      at: 0,
      count: (prev?.count ?? 0) + gone.length,
    } as Item<Link>
    for (const g of gone) delete items[g.id]
  }
  return folded
}

/** How many older links were folded away: tombstones and the running count. */
export function foldedCount(t: Thread): number {
  const items = t.links ?? {}
  return (items[FOLD_ID]?.count ?? 0) + Object.values(items).filter((i) => i.gone && i.folded && i.id !== FOLD_ID).length
}

/** The links a thread has, most recently seen first. */
export function links(t: Thread): Link[] {
  return live(t)
    .filter((i) => i.id !== FOLD_ID)
    .sort((a, b) => b.last - a.last || (a.id < b.id ? -1 : 1))
    .map(({ l: _l, by: _b, gone: _g, ...rest }) => rest as Link)
}

const STOP = /^(the|a|an|of|on|in|for|page|url|link|links|what|did|look|like|show|me|it)$/

/** The ones matching every word of `query` (label, URL, name, kind, service, feature), and dates. */
export function search(all: Link[], o: { query?: string; before?: number; after?: number } = {}): Link[] {
  const words = (o.query ?? "")
    .toLowerCase()
    .replace(/#/g, " ")
    .split(/[\s·]+/)
    .filter((w) => w && !STOP.test(w))
  const kindWords: Record<LinkKind, string> = { local: "local server dev", preview: "preview deploy", pr: "pr pull request", link: "link" }
  const hay = (l: Link) => `${l.label} ${l.url} ${l.name ?? ""} ${l.service ?? ""} ${l.feature ?? ""} ${kindWords[l.kind]} ${l.shots?.length ? "screenshot screenshots shot" : ""}`.toLowerCase()
  return all.filter((l) => {
    if (o.before !== undefined && l.first >= o.before) return false
    if (o.after !== undefined && l.last < o.after) return false
    return words.every((w) => hay(l).includes(w))
  })
}
