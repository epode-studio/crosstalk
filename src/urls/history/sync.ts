// Feeding the threads' `links` sections (links.ts) in the daemon: every URL
// record urls.json has for a thread, and every screenshot noted, goes into
// that thread's history. urls.json forgets; the thread keeps.
//
//   noteShot()      any process (the screenshots build, a CLI): appends to
//                   <crosstalk home>/history-shots.jsonl, which the daemon
//                   drains into the thread at its next sync
//   syncOnce()      one pass: records → threads, the shots file → threads
//   startHistory()  the daemon's: syncOnce every CROSSTALK_HISTORY_MS (30 s)
//
// Edits go through the thread service's mutate(), so they are saved, sealed,
// sent to the thread's people and committed like any other.

import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { P } from "../../config.ts"
import * as M from "../../threads/model.ts"
import { urls, type Url, type UrlStore } from "../index.ts"
import * as H from "./links.ts"

/** What the history needs of the thread service. */
export type Threads = { all(): M.Thread[]; mutate(id: string, fn: (t: M.Thread, by: string, now: number) => unknown): void }

export const shotsFile = () => path.join(P.root, "history-shots.jsonl")

/** This machine's name, for a screenshot's "taken on". */
export const machine = () => {
  try {
    return os.hostname().split(".")[0] || "this machine"
  } catch {
    return "this machine"
  }
}

export type ShotNote = {
  /** The URL record the screenshot is of (urls.json's id), or its URL. */
  urlId?: string
  url?: string
  /** The thread, by name; else the record's. */
  thread?: string
  /** Where the image is, on this machine. */
  path: string
  at?: number
  note?: string
}

/** A screenshot, for the thread's history. Cheap and safe from any process: one line appended. */
export function noteShot(s: ShotNote) {
  if (!s.path || (!s.urlId && !s.url)) return
  fs.mkdirSync(P.root, { recursive: true, mode: 0o700 })
  const line = JSON.stringify({ ...s, at: s.at ?? Date.now(), machine: machine() })
  fs.appendFileSync(shotsFile(), line + "\n", { mode: 0o600 })
}

function takeShots(): (ShotNote & { machine: string; at: number })[] {
  const f = shotsFile()
  const tmp = `${f}.${process.pid}.take`
  try {
    fs.renameSync(f, tmp)
  } catch {
    return []
  }
  let text = ""
  try {
    text = fs.readFileSync(tmp, "utf8")
  } catch {}
  try {
    fs.unlinkSync(tmp)
  } catch {}
  const out: (ShotNote & { machine: string; at: number })[] = []
  for (const l of text.split("\n").slice(-2000))
    try {
      const o = JSON.parse(l)
      if (typeof o?.path === "string" && (typeof o.urlId === "string" || typeof o.url === "string")) out.push({ ...o, at: Number(o.at) || Date.now(), machine: String(o.machine ?? machine()) })
    } catch {}
  return out
}

/** A thread by name: the live one touched last. */
function byName(all: M.Thread[], name: string): M.Thread | undefined {
  const n = name.toLowerCase()
  return all.filter((t) => t.meta.value.name === n && !t.meta.value.combinedInto).sort((a, b) => Number(M.isLive(b)) - Number(M.isLive(a)) || b.touchedAt - a.touchedAt)[0]
}

export const seenOf = (u: Url, shot?: H.Shot): H.Seen => ({
  url: u.url,
  kind: u.kind,
  label: u.label,
  ...(u.name ? { name: u.name } : {}),
  ...(u.service ? { service: u.service } : {}),
  ...(u.feature ? { feature: u.feature } : {}),
  seen: u.lastSeen,
  first: u.firstSeen,
  ...(shot ? { shot } : {}),
})

/** One pass. Returns how many thread entries changed. */
export function syncOnce(o: { threads: Threads; store?: UrlStore; log?: (s: string) => void }): number {
  const store = o.store ?? urls()
  const all = o.threads.all()
  const records = store.list({ all: true })
  const pending = new Map<string, H.Seen[]>()
  const add = (t: M.Thread | undefined, s: H.Seen) => {
    if (!t) return
    if (!H.next(t, s)) return
    pending.set(t.id, [...(pending.get(t.id) ?? []), s])
  }
  for (const u of records) if (u.thread) add(byName(all, u.thread), seenOf(u))
  for (const s of takeShots()) {
    const u = records.find((r) => r.id === s.urlId) ?? records.find((r) => r.url === s.url)
    const shot: H.Shot = { path: String(s.path).slice(0, 500), at: s.at, machine: s.machine.slice(0, 64), ...(s.note ? { note: String(s.note).slice(0, 200) } : {}) }
    const thread = s.thread ?? u?.thread
    if (!thread) continue
    const seen: H.Seen = u ? seenOf(u, shot) : { url: String(s.url), kind: /localhost|127\.0\.0\.1|\[::1\]/.test(String(s.url)) ? "local" : "link", label: `${thread} · ${String(s.url).replace(/^https?:\/\//, "").slice(0, 40)}`, seen: s.at, shot }
    add(byName(all, thread), { ...seen, seen: Math.max(seen.seen, s.at) })
  }
  let n = 0
  for (const [id, list] of pending)
    o.threads.mutate(id, (t, by, now) => {
      for (const s of list) if (H.record(t, by, s, now)) n++
    })
  if (n) o.log?.(`history: ${n} link${n === 1 ? "" : "s"} recorded in threads`)
  return n
}

export function startHistory(o: { threads: Threads; log: (s: string) => void }): { stop: () => void } {
  const run = () => {
    try {
      syncOnce(o)
    } catch (e) {
      o.log(`history: ${(e as Error).message}`)
    }
  }
  const timer = setInterval(run, Number(process.env.CROSSTALK_HISTORY_MS ?? 30_000))
  timer.unref?.()
  setTimeout(run, 2000).unref?.()
  return { stop: () => clearInterval(timer) }
}
