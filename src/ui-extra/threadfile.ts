// The daemon's replica of every thread (threads.json, written by
// src/threads/service.ts), read without the daemon. The pane, the digest and
// the standup only read; nothing here writes a thread.

import fs from "node:fs"
import path from "node:path"
import { P } from "../config.ts"
import * as M from "../threads/model.ts"

export type ThreadState = {
  threads: Record<string, M.Thread>
  placed: Record<string, { threads: string[] }>
  roots: Record<string, string>
}

export const threadsFile = () => path.join(P.root, "threads.json")

export function readThreads(file = threadsFile()): ThreadState {
  try {
    const raw = JSON.parse(fs.readFileSync(file, "utf8"))
    const threads: Record<string, M.Thread> = {}
    for (const [id, t] of Object.entries(raw?.threads ?? {})) {
      const ok = M.parseThread(t)
      if (ok) threads[id] = ok
    }
    return { threads, placed: raw?.placed ?? {}, roots: raw?.roots ?? {} }
  } catch {
    return { threads: {}, placed: {}, roots: {} }
  }
}

/** Threads nobody combined into another. */
export const liveThreads = (st: ThreadState) => Object.values(st.threads).filter((t) => !t.meta.value.combinedInto)

/** A thread by name, id or the start of a name; this session's own first. */
export function findThread(st: ThreadState, nameOrId: string | undefined, sessionId?: string): M.Thread | undefined {
  const mine = sessionId ? (st.placed[sessionId]?.threads ?? []).map((id) => st.threads[id]).filter(Boolean) : []
  if (!nameOrId) return mine[0]
  const n = M.slug(nameOrId)
  const all = [...mine, ...liveThreads(st)]
  const hit = all.find((t) => t.id === nameOrId || t.meta.value.name === n) ?? all.find((t) => t.meta.value.name.startsWith(n))
  if (!hit) return undefined
  let t = hit
  for (let i = 0; i < 10 && t.meta.value.combinedInto && st.threads[t.meta.value.combinedInto]; i++) t = st.threads[t.meta.value.combinedInto]
  return t
}

/** The thread worth showing when none was named: this session's, else the one touched last. */
export function defaultThread(st: ThreadState, sessionId?: string): M.Thread | undefined {
  return findThread(st, undefined, sessionId) ?? liveThreads(st).filter(M.isLive).sort((a, b) => b.touchedAt - a.touchedAt)[0]
}

/** A fingerprint's name, from the people of any thread that knows it. */
export function labelOf(st: ThreadState, fp: string): string {
  for (const t of Object.values(st.threads)) {
    const p = t.people[fp]
    if (p && !p.gone) return p.label
  }
  return fp.slice(0, 9)
}
