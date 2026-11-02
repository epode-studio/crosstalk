// Past sessions: every one that ended or was closed, so "find the session
// where I fixed the token refresh" and "resume it" work weeks later.
//
// Two sources, merged by session id:
//
//   crosstalk's own    the restore records (<crosstalk home>/open/, src/restore.ts)
//                      of sessions that ended or whose process is gone, copied
//                      into <crosstalk home>/sessions/past.json by sweep(), since
//                      restore prunes an ended record after a day. They carry
//                      the name, the thread and whether it was archived.
//   Claude Code's      transcripts under the config dir (src/sessions/transcripts.ts)
//                      whose folder still exists, read-only: sessions from
//                      before crosstalk, or that never had it.
//
// Each entry has its folder, repository, branch, threads, title, last recap,
// files touched, start and end, and client. Search is plain word overlap with
// a weight per field; no model is asked anything.

import fs from "node:fs"
import path from "node:path"
import { P } from "../config.ts"
import * as R from "../restore.ts"
import * as T from "./transcripts.ts"
import { words } from "../attention/recap.ts"
import { readRegistry } from "../gather.ts"

export type Past = {
  id: string
  cwd: string
  client: string
  /** The session's name in crosstalk, or its title in Claude Code. */
  title?: string
  repo?: string
  branch?: string
  threads: string[]
  recap?: string
  files: string[]
  startedAt?: number
  endedAt?: number
  /** Closed on purpose with crosstalk_close: not a crash, and not offered by restore. */
  archived?: number
  /** Where it was found: crosstalk's own records, or only Claude Code's transcripts. */
  source: "crosstalk" | "claude"
  resumedAt?: number
}

type File = { v: 1; items: Record<string, Past> }

const file = () => path.join(P.root, "sessions", "past.json")
const KEEP_MS = 180 * 24 * 3600_000
const MAX = 3000

export function load(): Record<string, Past> {
  try {
    const f = JSON.parse(fs.readFileSync(file(), "utf8")) as File
    if (f?.v === 1 && f.items && typeof f.items === "object") return f.items
  } catch {}
  return {}
}

export function save(items: Record<string, Past>) {
  const now = Date.now()
  const kept = Object.values(items)
    .filter((p) => now - (p.endedAt ?? p.startedAt ?? now) < KEEP_MS)
    .sort((a, b) => (b.endedAt ?? 0) - (a.endedAt ?? 0))
    .slice(0, MAX)
  fs.mkdirSync(path.dirname(file()), { recursive: true, mode: 0o700 })
  const tmp = `${file()}.${process.pid}.tmp`
  fs.writeFileSync(tmp, JSON.stringify({ v: 1, items: Object.fromEntries(kept.map((p) => [p.id, p])) } satisfies File), { mode: 0o600 })
  fs.renameSync(tmp, file())
}

/** One past entry from a restore record, filled in from its transcript when it has one. */
export function fromRec(r: R.Rec, before: Past | undefined, sum: T.Summary | null): Past {
  const threads = [...new Set([...(before?.threads ?? []), ...(r.thread ? [r.thread] : [])])]
  const name = r.name && !/^session-\d+$/.test(r.name) ? r.name : undefined
  return {
    ...before,
    id: r.sessionId,
    cwd: r.cwd,
    client: r.client,
    ...(name ?? sum?.title ?? before?.title ? { title: name ?? sum?.title ?? before?.title } : {}),
    ...(sum?.branch ?? before?.branch ? { branch: sum?.branch ?? before?.branch } : {}),
    threads,
    ...(sum?.recap ?? before?.recap ? { recap: sum?.recap ?? before?.recap } : {}),
    files: sum?.files.length ? sum.files : (before?.files ?? []),
    startedAt: r.startedAt,
    endedAt: r.endedAt ?? r.seenAt,
    ...(r.archived ? { archived: r.archived } : before?.archived ? { archived: before.archived } : {}),
    source: "crosstalk",
  }
}

/**
 * Copy every ended or vanished session's record into the index. Cheap enough
 * for a session start: only records not yet indexed, or seen since, are read.
 */
export function sweep(o: { alive?: (r: R.Rec) => boolean; env?: NodeJS.ProcessEnv } = {}): number {
  const alive = o.alive ?? R.recAlive
  const items = load()
  let n = 0
  for (const r of R.readAll()) {
    if (r.interactive === false) continue
    if (!r.endedAt && alive(r)) continue
    const before = items[r.sessionId]
    const end = r.endedAt ?? r.seenAt
    if (before && before.source === "crosstalk" && (before.endedAt ?? 0) >= end && !!before.archived === !!r.archived) continue
    const sum = r.client === "claude" ? safeSummary(T.transcriptOf(r.sessionId, r.cwd, o.env)) : null
    items[r.sessionId] = fromRec(r, before, sum)
    n++
  }
  if (n) save(items)
  return n
}

function safeSummary(f: string | null): T.Summary | null {
  if (!f) return null
  try {
    return T.summarize(f)
  } catch {
    return null
  }
}

/** Note on the index that a session was closed on purpose (or resumed: archived no more). */
export function mark(id: string, fields: Partial<Past>) {
  const items = load()
  const before = items[id]
  if (!before) return
  items[id] = { ...before, ...fields }
  if (fields.archived === undefined && "archived" in fields) delete items[id].archived
  save(items)
}

/** Ids of sessions running now: crosstalk's live records and Claude Code's registry. */
export function liveIds(): Set<string> {
  const ids = new Set<string>()
  for (const r of R.readAll()) if (!r.endedAt && R.recAlive(r)) ids.add(r.sessionId)
  try {
    for (const e of readRegistry()) ids.add(e.sessionId)
  } catch {}
  return ids
}

/**
 * Every past session: the index first, then Claude Code's transcripts for
 * whatever it lacks, newest first. Running sessions and folders that no
 * longer exist are left out.
 */
export function all(o: { env?: NodeJS.ProcessEnv; transcripts?: boolean; limit?: number; live?: Set<string> } = {}): Past[] {
  try {
    sweep({ env: o.env })
  } catch {}
  const live = o.live ?? liveIds()
  const out = new Map<string, Past>()
  for (const p of Object.values(load())) if (!live.has(p.id)) out.set(p.id, p)
  if (o.transcripts !== false) {
    const cache = loadCache()
    const fresh: Cache = {}
    for (const f of T.recent(o.env, o.limit ?? 400)) {
      const id = path.basename(f, ".jsonl")
      const have = out.get(id)
      if (live.has(id) || (have && have.recap && have.files.length)) continue
      // A transcript read once is not read again until it changes.
      let mtime = 0
      try {
        mtime = fs.statSync(f).mtimeMs
      } catch {}
      const s = cache[f]?.mtime === mtime ? cache[f].s : safeSummary(f)
      fresh[f] = { mtime, s }
      if (!s || live.has(s.sessionId)) continue
      if (have) {
        out.set(id, { ...have, recap: have.recap ?? s.recap, files: have.files.length ? have.files : s.files, branch: have.branch ?? s.branch, title: have.title ?? s.title })
        continue
      }
      out.set(s.sessionId, {
        id: s.sessionId,
        cwd: s.cwd,
        client: "claude",
        ...(s.title ? { title: s.title } : {}),
        ...(s.branch ? { branch: s.branch } : {}),
        threads: [],
        ...(s.recap ? { recap: s.recap } : {}),
        files: s.files,
        ...(s.startedAt ? { startedAt: s.startedAt } : {}),
        ...(s.endedAt ? { endedAt: s.endedAt } : {}),
        source: "claude",
      })
    }
    saveCache(fresh)
  }
  return [...out.values()].filter((p) => exists(p.cwd)).sort((a, b) => (b.endedAt ?? 0) - (a.endedAt ?? 0))
}

type Cache = Record<string, { mtime: number; s: T.Summary | null }>
const cacheFile = () => path.join(P.root, "sessions", "transcripts.json")
function loadCache(): Cache {
  try {
    const c = JSON.parse(fs.readFileSync(cacheFile(), "utf8"))
    return c && typeof c === "object" ? c : {}
  } catch {
    return {}
  }
}
function saveCache(c: Cache) {
  try {
    fs.mkdirSync(path.dirname(cacheFile()), { recursive: true, mode: 0o700 })
    const tmp = `${cacheFile()}.${process.pid}.tmp`
    fs.writeFileSync(tmp, JSON.stringify(c), { mode: 0o600 })
    fs.renameSync(tmp, cacheFile())
  } catch {}
}

const exists = (d: string) => {
  try {
    return fs.statSync(d).isDirectory()
  } catch {
    return false
  }
}

// --- search ----------------------------------------------------------------------

/** How much a word found in each field counts. */
export const WEIGHTS = { title: 4, threads: 4, branch: 3, files: 2, folder: 2, recap: 1 } as const

const pathWords = (p: string) => words(p.replace(/[/._-]+/g, " "))

export type Hit = { past: Past; score: number; matched: string[] }

/**
 * Score each past session against the query: every query word found in a
 * field adds that field's weight (the best field it is in), and the whole
 * query found in a title or thread adds a little more. An id or its first
 * eight characters is an exact hit. Ties go to the most recent.
 */
export function find(query: string, entries: Past[], max = 8): Hit[] {
  const q = query.trim().toLowerCase()
  if (!q) return entries.slice(0, max).map((past) => ({ past, score: 0, matched: [] }))
  const qw = [...words(q)]
  const hits: Hit[] = []
  for (const p of entries) {
    if (q.length >= 6 && /^[0-9a-f-]+$/.test(q) && p.id.toLowerCase().startsWith(q)) {
      hits.push({ past: p, score: 1000, matched: ["id"] })
      continue
    }
    const fields: [keyof typeof WEIGHTS, Set<string>][] = [
      ["title", words(p.title ?? "")],
      ["threads", words(p.threads.join(" "))],
      ["branch", pathWords(p.branch ?? "")],
      ["files", pathWords(p.files.join(" "))],
      ["folder", pathWords(path.basename(p.cwd) + " " + (p.repo ?? ""))],
      ["recap", words(p.recap ?? "")],
    ]
    let score = 0
    const matched = new Set<string>()
    for (const w of qw) {
      let best = 0
      let where = ""
      for (const [k, set] of fields)
        if (set.has(w) && WEIGHTS[k] > best) {
          best = WEIGHTS[k]
          where = k
        }
      if (best) {
        score += best
        matched.add(where)
      }
    }
    if (q.length >= 3 && [p.title ?? "", ...p.threads].some((t) => t.toLowerCase().includes(q))) score += 2
    if (score > 0) hits.push({ past: p, score, matched: [...matched] })
  }
  return hits.sort((a, b) => b.score - a.score || (b.past.endedAt ?? 0) - (a.past.endedAt ?? 0)).slice(0, max)
}

/** A past session by id, id prefix, or exact title. */
export function lookup(ref: string, entries: Past[]): Past | null {
  const r = ref.trim()
  if (!r) return null
  return (
    entries.find((p) => p.id === r) ??
    (r.length >= 6 ? entries.find((p) => p.id.startsWith(r)) : undefined) ??
    entries.find((p) => (p.title ?? "").toLowerCase() === r.toLowerCase()) ??
    entries.find((p) => p.threads.some((t) => t.toLowerCase() === r.toLowerCase())) ??
    null
  )
}

const ago = (t: number | undefined, now = Date.now()) => {
  if (!t) return "some time ago"
  const m = Math.round((now - t) / 60_000)
  if (m < 60) return `${Math.max(1, m)} min ago`
  const h = Math.round(m / 60)
  if (h < 48) return `${h} h ago`
  return `${Math.round(h / 24)} days ago`
}

/** One line per hit, for the person. */
export function describeHits(hits: Hit[], now = Date.now()): string {
  if (!hits.length) return "◢ crosstalk: no past session matches that."
  const lines = [`◢ crosstalk: ${hits.length} past session${hits.length === 1 ? "" : "s"}:`]
  for (const { past: p } of hits) {
    const label = p.title || path.basename(p.cwd)
    const where = [p.threads.length ? p.threads.join(", ") : "", p.branch ?? ""].filter(Boolean).join(" · ")
    lines.push(`  ${p.id.slice(0, 8)}  ${label}${where ? ` (${where})` : ""}, ended ${ago(p.endedAt, now)}${p.archived ? ", closed" : ""}${p.source === "claude" ? ", from Claude Code's history" : ""}`)
    lines.push(`            ${p.cwd}`)
    if (p.recap) lines.push(`            ${p.recap.length > 160 ? p.recap.slice(0, 159) + "…" : p.recap}`)
  }
  lines.push(`Say "resume <id>" to reopen one in a new tab.`)
  return lines.join("\n")
}
