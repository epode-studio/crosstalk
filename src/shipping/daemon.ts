// Shipping, plugged into the daemon: the engine over the daemon's threads,
// its questions as the mod's pickers, its heads-ups as held messages, and the
// `ship` op every tool and command goes through.
//
// Also on timers here: reviewers that never answered (every 10 minutes), the
// watch over flags being ramped (every 5 minutes, CROSSTALK_RAMP_POLL_MS),
// and answers to this machine's questions from people on other machines,
// plus pickers for other machines' questions (every 2 seconds,
// CROSSTALK_SHIP_VOTE_MS).
//
// CROSSTALK_SHIP_CLOCK names a file holding a time in ms since the epoch: the
// engine's clock while it is there (tests use it to move time forward).

import fs from "node:fs"
import path from "node:path"
import { P, loadIdentity, loadPeers } from "../config.ts"
import * as ui from "../uistate.ts"
import * as cleanup from "../cleanup.ts"
import type { ThreadService } from "../threads/service.ts"
import * as M from "../threads/model.ts"
import { ShipEngine, type Out, type Question, type ThreadPort } from "./engine.ts"
import { cliCommand } from "./reviewer.ts"
import { refuseBot } from "../ui-extra/bots.ts"

export const uiId = (q: string, sid: string) => `ship:${q}:${sid}`
export const qOf = (uiItemId: string) => uiItemId.split(":")[1] ?? ""

export function portFor(svc: ThreadService): ThreadPort {
  return {
    me: svc.me,
    label: svc.label,
    get: (id) => svc.thread(id),
    find: (sid, n) => svc.find(sid, n),
    all: () => svc.all(),
    mutate: (id, fn) => svc.mutate(id, fn),
    notify: (id, text) => svc.notify(id, text),
    open: (o) => svc.open(o),
    sessionsIn: (id) => svc.sessionsIn([id]),
    session: (sid) => svc.local(sid),
    rootFor: (repo) => svc.rootFor(repo),
  }
}

/** The engine's clock: the test clock file while there is one, else the wall. */
export function clock(file = process.env.CROSSTALK_SHIP_CLOCK): () => number {
  if (!file) return () => Date.now()
  return () => {
    try {
      const n = Number(fs.readFileSync(file, "utf8").trim())
      return Number.isFinite(n) && n > 0 ? n : Date.now()
    } catch {
      return Date.now()
    }
  }
}

export type Shipping = {
  engine: ShipEngine
  op: (req: Record<string, any>, sessionId: string | undefined) => Promise<Out>
  /** The picker's answer: a person pressed it. */
  uiAnswer: (itemId: string, value: string) => Promise<Out & { item?: ui.UiItem }>
  /** crosstalk_work may not lower a risk or answer a shipping question; returns the refusal, or the request to go on with. */
  guardThreadEdit: (sid: string | undefined, req: Record<string, any>) => Promise<{ stop?: Record<string, unknown>; req: Record<string, any> }>
}

export function createShipping(o: {
  threads: ThreadService
  root: string
  log: (...a: unknown[]) => void
  /** Hand text to an agent's session: held, with a notice, read with crosstalk_people action "read". */
  wake: (sessionId: string, text: string) => void
  /** Where a question goes when no session is in its thread. */
  fallbackSession: () => string | undefined
}): Shipping {
  const settle = (qid: string) =>
    ui.withStore((items, now) => {
      for (const it of Object.values(items)) if (it.kind === "ship" && it.id.startsWith(`ship:${qid}:`)) ui.settle(items, it.id, "answered", now)
    })
  const picker = (q: { id: string; text: string; options: string[]; at: number }, sessions: string[], threadName?: string) => {
    try {
      ui.withStore((items, now) => {
        for (const sid of sessions) ui.upsert(items, { id: uiId(q.id, sid), kind: "ship", sessionId: sid, thread: threadName, question: q.text, options: q.options, ts: q.at }, now)
      })
    } catch (e) {
      o.log(`ship: picker not stored: ${(e as Error).message}`)
    }
  }
  const ask = (q: Question) => {
    const sessions = q.sessions.length ? q.sessions : [o.fallbackSession()].filter((s): s is string => !!s)
    picker(q, sessions, o.threads.thread(q.thread)?.meta.value.name)
  }
  const engine = new ShipEngine({
    threads: portFor(o.threads),
    file: path.join(P.root, "shipping.json"),
    home: path.join(P.root, "shipping"),
    cli: cliCommand(o.root),
    wake: o.wake,
    ask,
    settle,
    merged: (sid) => {
      if (!sid) return
      try {
        cleanup.surface(sid, cleanup.offerOnce({ force: true }))
      } catch {}
    },
    log: o.log,
    now: clock(),
    identity: () => loadIdentity(),
    peers: () => Object.values(loadPeers()),
  })
  const every = (ms: number, fn: () => unknown) => {
    const t = setInterval(async () => {
      try {
        await fn()
      } catch (e) {
        o.log(`ship: ${(e as Error).message}`)
      }
    }, ms)
    t.unref?.()
    return t
  }
  every(10 * 60_000, () => engine.sweep())
  let watching = false
  every(Number(process.env.CROSSTALK_RAMP_POLL_MS) || 5 * 60_000, async () => {
    if (watching) return
    watching = true
    try {
      await engine.watch()
    } finally {
      watching = false
    }
  })
  // Other machines' questions get a picker here too; one answered anywhere comes down.
  const shown = new Set<string>()
  let voting = false
  every(Number(process.env.CROSSTALK_SHIP_VOTE_MS) || 2000, async () => {
    if (voting) return
    voting = true
    try {
      await engine.pollVotes()
      const open = engine.elsewhere()
      for (const q of open) {
        if (shown.has(q.id)) continue
        shown.add(q.id)
        const sessions = o.threads.sessionsIn([q.thread])
        if (sessions.length) picker({ id: q.id, text: q.text, options: q.options, at: Date.now() }, sessions, q.threadName)
      }
      const still = new Set(open.map((q) => q.id))
      for (const id of [...shown])
        if (!still.has(id)) {
          shown.delete(id)
          settle(id)
        }
    } finally {
      voting = false
    }
  })

  const op = async (req: Record<string, any>, sid: string | undefined): Promise<Out> => {
    const bot = refuseBot(req.peer ? String(req.peer) : undefined, "start reviewers, merge or change a flag here")
    if (bot) return { ok: false, text: bot }
    switch (req.action) {
      case "feature":
        return engine.feature(sid, { thread: req.thread, name: req.name ?? req.feature, risk: req.risk, why: req.why, flag: req.flag, branch: req.branch })
      case "ready":
        return engine.ready(sid, { thread: req.thread, feature: req.feature ?? req.name, response: req.response })
      case "review":
        // Only the run's wrapper (its secret) or the reviewer's own session (in the run's copy) counts.
        return engine.review({ run: req.run, verdict: req.verdict, findings: req.findings, output: req.output, secret: typeof req.secret === "string" ? req.secret : undefined, sid })
      case "evidence":
        return engine.evidence(sid, req)
      case "flag":
        return engine.flag(sid, { thread: req.thread, feature: req.feature, flag: req.flag, stage: req.stage, why: req.why })
      case "incident":
        if (req.link || req.cause) return engine.link(sid, { incident: req.link?.incident ?? req.thread, cause: req.link?.cause ?? req.cause })
        return engine.incident(
          {
            source: String(req.source ?? "unknown").slice(0, 60),
            title: String(req.title ?? "").slice(0, 300),
            details: String(req.details ?? "").slice(0, 4000),
            ...(req.flag ? { flag: String(req.flag) } : {}),
            ...(req.files ? { files: (Array.isArray(req.files) ? req.files : String(req.files).split(",")).map(String).slice(0, 50) } : {}),
            ...(req.sha ? { sha: String(req.sha) } : {}),
          },
          { cwd: req.cwd },
        )
      case "status":
        return engine.status(sid, { thread: req.thread })
      case "watch":
        // One pass of the ramp watch now, instead of at the next five minutes.
        return engine.watch()
      case "questions": {
        const here = engine.open().map((q) => ({ id: q.id, kind: q.kind, text: q.text, options: q.options }))
        const there = engine.elsewhere().map((q) => ({ id: q.id, kind: q.kind, text: q.text, options: q.options, thread: q.threadName, elsewhere: true }))
        return { ok: true, text: `${here.length + there.length} waiting${there.length ? ` (${there.length} asked on another machine)` : ""}`, questions: [...here, ...there] }
      }
      case "answer":
        // Only `crosstalk ship answer` in a person's terminal says person.
        return engine.answer(String(req.id ?? ""), String(req.value ?? ""), { person: req.person === true })
      default:
        return { ok: false, text: `unknown shipping action ${req.action}` }
    }
  }

  const uiAnswer = async (itemId: string, value: string) => {
    const claim = ui.withStore((items, now) => ui.act(items, itemId, "answer", now, value))
    if (!claim.ok) return { ok: false, text: claim.error, item: claim.item }
    const r = await engine.answer(qOf(itemId), value, { person: true })
    if (!r.ok && (engine.question(qOf(itemId)) || engine.elsewhere().some((q) => q.id === qOf(itemId)))) ui.withStore((items, now) => ui.reopen(items, itemId, now))
    return { ...r, item: claim.item }
  }

  const guardThreadEdit = async (sid: string | undefined, req: Record<string, any>) => {
    const qid = typeof req.answer?.id === "string" ? req.answer.id : undefined
    if (qid && (engine.question(qid) || o.threads.all().some((t) => t.questions[qid]?.ship)))
      return { stop: { ok: false, error: "that is a shipping question, and a person answers it themselves: in crosstalk's picker, or with `crosstalk ship answer` in a terminal" }, req }
    // Matched the way the thread keys features (by slug), removed ones included:
    // "Login V2", or a remove and re-add, is the same risky feature.
    if (req.feature?.name && req.feature.risk === "everyday" && !req.feature.remove) {
      const t = o.threads.find(sid, req.thread)
      const name = String(req.feature.name)
      const f = t && (t.features[M.slug(name, 60)] ?? Object.values(t.features).find((x) => x.name === name || x.id === name || x.name.toLowerCase() === name.toLowerCase()))
      if (t && f && (f.risk === "risky" || engine.isRisky(t, f))) {
        const r = await engine.feature(sid, { thread: t!.id, name: f.name, risk: "everyday", why: req.feature.why })
        return { stop: { ok: r.ok, note: r.text, ...(r.question ? { question: r.question } : {}) }, req }
      }
    }
    return { req }
  }

  return { engine, op, uiAnswer, guardThreadEdit }
}
