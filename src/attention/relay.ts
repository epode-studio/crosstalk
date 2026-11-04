// An agent's own question, answered from the main session.
//
// When a working session's agent asks the person something (Claude Code's
// AskUserQuestion) and a main session is open, and the person is not looking
// at that session, crosstalk's mod in that session asks here first:
//
//   relay      the question goes to main as crosstalk's picker: which session
//              and thread asks, the question, its options (and "Type
//              something", as always). The asking tab notes where it went.
//   answer     the pick in main is the answer: the asking session's mod
//              returns it to its agent as the AskUserQuestion result, exactly
//              as if it had been picked there.
//   fallback   main ended meanwhile, or the item was dropped: the question is
//              asked in its own tab after all.
//
// Only a single question with 2 to 4 choices is relayed; several questions at
// once, multi-select and free-text forms stay where they were asked.

import crypto from "node:crypto"
import * as R from "../restore.ts"
import * as ui from "../uistate.ts"
import { currentMain } from "../main.ts"
import * as F from "./focus.ts"
import * as N from "../sessions/names.ts"

export type Question = { question: string; header?: string; options?: { label: string; description?: string }[]; multiSelect?: boolean; kind?: string }

/** Whether this question can go to main at all: one question, 2-4 choices, single-select. */
export function relayable(qs: unknown): qs is [Question] {
  if (!Array.isArray(qs) || qs.length !== 1) return false
  const q = qs[0] as Question
  if (!q || typeof q.question !== "string" || q.multiSelect || (q.kind && q.kind !== "choice")) return false
  return Array.isArray(q.options) && q.options.length >= 2 && q.options.length <= 4 && q.options.every((o) => typeof o?.label === "string" && o.label.trim())
}

/**
 * Where the question should be asked: main's session id, or null to ask in
 * its own tab (no main, this is main, or the person is looking at this tab).
 */
export function target(sessionId: string, o: { main?: string | null; focused?: { sessionId: string; sure: boolean } | null } = {}): string | null {
  const main = o.main !== undefined ? o.main : (currentMain()?.sessionId ?? null)
  if (!main || main === sessionId) return null
  let f = o.focused
  if (f === undefined)
    try {
      f = F.focused({ recs: F.liveRecs(), sys: F.liveSys() })
    } catch {
      f = null
    }
  if (f && f.sure && f.sessionId === sessionId) return null
  return main
}

const clean = (s: string, n: number) => s.replace(/[\u0000-\u001f\u007f-\u009f]+/g, " ").replace(/\s+/g, " ").trim().slice(0, n)

/** Put the question to main. Returns the item's id. */
export function relay(sessionId: string, q: Question, main: string, now = Date.now()): string {
  const rec = R.readOne(sessionId)
  const name = N.nameOf(sessionId) ?? rec?.name ?? sessionId.slice(0, 8)
  const id = `relay:${sessionId}:${crypto.randomBytes(4).toString("hex")}`
  const opts = (q.options ?? []).slice(0, 4)
  const described = opts.filter((o) => o.description).map((o) => `${clean(o.label, 60)}: ${clean(o.description!, 160)}`)
  ui.withStore((items, t) =>
    ui.upsert(
      items,
      {
        id,
        kind: "attention",
        sessionId: main,
        from: clean(name, 60),
        ...(rec?.thread ? { thread: rec.thread } : {}),
        question: `${clean(name, 60)} asks: ${clean(q.question, 400)}`,
        ...(described.length ? { text: described.join("\n") } : {}),
        options: opts.map((o) => clean(o.label, 60)),
        ts: now,
      },
      t,
    ),
  )
  return id
}

/** Where a relayed question stands: answered (and with what), waiting, or gone back to its tab. */
export function poll(id: string, o: { mainAlive?: () => boolean } = {}): { answer?: string; fallback?: boolean } {
  const it = ui.snapshot()[id]
  if (!it) return { fallback: true }
  if (it.state === "answered") return typeof it.answer === "string" && it.answer.trim() ? { answer: it.answer } : { fallback: true }
  if (it.state === "muted") return { fallback: true }
  const alive = o.mainAlive ?? (() => currentMain()?.sessionId === it.sessionId)
  if (!alive()) {
    ui.withStore((items, now) => ui.act(items, id, "answer", now, ""))
    return { fallback: true }
  }
  return {}
}
