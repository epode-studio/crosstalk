// The main session (docs/design/next-generation.md, "Focus-aware, plus a main
// session").
//
// Any session becomes main when the person says so ("make this my main
// session"). There is at most one per machine: the last one asked for wins and
// the one before is told. While main is open:
//
//   - everything that cuts across threads goes to main and only to main:
//     questions from other threads, messages nothing matched (route), threads
//     combining, a collaborator's key that changed, the gather and cleanup
//     offers;
//   - a working session sees only what is about its own threads;
//   - main itself leaves its threads, so its footprint places it nowhere and
//     cross-cutting talk never mixes with code work.
//
// Closing or ending main puts everything back to focus-aware.
//
// The record is a file, not daemon memory, because the hook and `crosstalk ui`
// decide where the gather and cleanup offers go without a daemon.

import fs from "node:fs"
import path from "node:path"
import { P } from "./config.ts"
import type { UiItem, UiKind } from "./uistate.ts"

export type MainRec = { sessionId: string; name: string; pid?: number; at: number }

const file = () => path.join(P.root, "main.json")

export function readMain(): MainRec | null {
  try {
    const r = JSON.parse(fs.readFileSync(file(), "utf8"))
    if (r && typeof r.sessionId === "string" && r.sessionId) return r
  } catch {}
  return null
}

export function writeMain(rec: MainRec | null) {
  fs.mkdirSync(P.root, { recursive: true, mode: 0o700 })
  if (!rec) {
    try {
      fs.unlinkSync(file())
    } catch {}
    return
  }
  const tmp = `${file()}.${process.pid}.tmp`
  fs.writeFileSync(tmp, JSON.stringify(rec), { mode: 0o600 })
  fs.renameSync(tmp, file())
}

const pidAlive = (pid?: number) => {
  if (!pid || pid <= 1) return true
  try {
    process.kill(pid, 0)
    return true
  } catch (e) {
    return (e as NodeJS.ErrnoException).code === "EPERM"
  }
}

/** The main session, if one is open. A main whose process has gone is no main. */
export function currentMain(alive: (rec: MainRec) => boolean = (r) => pidAlive(r.pid)): MainRec | null {
  const m = readMain()
  return m && alive(m) ? m : null
}

/** True when a main session is open and it is not this one: cross-cutting things are not for this session. */
export const mainElsewhere = (sessionId: string, m: MainRec | null = currentMain()) => !!m && m.sessionId !== sessionId

/**
 * Make `sessionId` main, or stop it being main. Returns the session that was
 * main before, so it can be told it no longer is.
 */
export function setMain(on: boolean, s: { sessionId: string; name: string; pid?: number }, now = Date.now()): { previous?: MainRec; changed: boolean } {
  const before = readMain()
  if (on) {
    if (before?.sessionId === s.sessionId) return { changed: false }
    writeMain({ sessionId: s.sessionId, name: s.name, pid: s.pid, at: now })
    return { previous: before ?? undefined, changed: true }
  }
  if (before?.sessionId !== s.sessionId) return { changed: false }
  writeMain(null)
  return { changed: true }
}

// --- what goes where -------------------------------------------------------------

/** Kinds that are never about one session's own thread. */
export const CROSS_CUTTING: ReadonlySet<UiKind> = new Set<UiKind>(["route", "team", "gather", "cleanup"])

export const isCrossCutting = (it: Pick<UiItem, "kind">) => CROSS_CUTTING.has(it.kind)

/**
 * What one session's mod shows, from the open items of every session.
 *
 *   no main          its own items, as always (focus-aware)
 *   it is main       its own items, and every cross-cutting item anywhere
 *   main elsewhere   its own items, minus anything cross-cutting
 */
export function itemsFor(open: UiItem[], sessionId: string, mainId?: string): UiItem[] {
  const own = open.filter((i) => i.sessionId === sessionId).sort((a, b) => a.createdAt - b.createdAt)
  if (!mainId) return own
  if (mainId !== sessionId) return own.filter((i) => !isCrossCutting(i))
  const seen = new Set(own.map((i) => i.id))
  const cross = open.filter((i) => i.sessionId !== sessionId && isCrossCutting(i) && !seen.has(i.id))
  // One offer of each machine-wide kind is enough: two sessions' gather offers are one question.
  const kinds = new Set<string>()
  const out: UiItem[] = [...own]
  for (const i of own) if (i.kind === "gather" || i.kind === "cleanup") kinds.add(i.kind)
  for (const i of cross) {
    if ((i.kind === "gather" || i.kind === "cleanup") && kinds.has(i.kind)) continue
    if (i.kind === "gather" || i.kind === "cleanup") kinds.add(i.kind)
    out.push(i)
  }
  return out.sort((a, b) => a.createdAt - b.createdAt)
}

/** Thread notices that are about more than one thread: two combining, someone new joining. */
export const crossNote = (id: string) => /^(combine|join):/.test(id)

/**
 * Where an inbound message goes once routing picked a session. With a main
 * session open, a question that is not about the target's own thread, and
 * anything nothing matched, goes to main instead.
 */
export function redirect(o: { how: string; kind: string; intent: string; target?: string; mainId?: string }): string | undefined {
  if (!o.mainId || o.target === o.mainId) return o.target
  if (o.how === "thread" || o.how === "named") return o.target
  const question = o.kind === "ask" || o.intent === "question" || o.intent === "blocking"
  return question || !o.target ? o.mainId : o.target
}
