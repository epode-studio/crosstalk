// Shipping, plugged into the daemon: the engine over the daemon's threads,
// its questions as the mod's pickers, its heads-ups as held messages, and the
// `ship` op every tool and command goes through.

import path from "node:path"
import { P } from "../config.ts"
import * as ui from "../uistate.ts"
import * as cleanup from "../cleanup.ts"
import type { ThreadService } from "../threads/service.ts"
import { ShipEngine, type Out, type Question, type ThreadPort } from "./engine.ts"
import { cliCommand } from "./reviewer.ts"

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

export type Shipping = {
  engine: ShipEngine
  op: (req: Record<string, any>, sessionId: string | undefined) => Promise<Out>
  /** The picker's answer: a person pressed it. */
  uiAnswer: (itemId: string, value: string) => Promise<Out & { item?: ui.UiItem }>
  /** crosstalk_thread may not lower a risk or answer a shipping question; returns the refusal, or the request to go on with. */
  guardThreadEdit: (sid: string | undefined, req: Record<string, any>) => Promise<{ stop?: Record<string, unknown>; req: Record<string, any> }>
}

export function createShipping(o: {
  threads: ThreadService
  root: string
  log: (...a: unknown[]) => void
  /** Hand text to an agent's session: held, with a notice, read with crosstalk_read. */
  wake: (sessionId: string, text: string) => void
  /** Where a question goes when no session is in its thread. */
  fallbackSession: () => string | undefined
}): Shipping {
  const settle = (qid: string) =>
    ui.withStore((items, now) => {
      for (const it of Object.values(items)) if (it.kind === "ship" && it.id.startsWith(`ship:${qid}:`)) ui.settle(items, it.id, "answered", now)
    })
  const ask = (q: Question) => {
    const sessions = q.sessions.length ? q.sessions : [o.fallbackSession()].filter((s): s is string => !!s)
    const t = o.threads.thread(q.thread)
    try {
      ui.withStore((items, now) => {
        for (const sid of sessions)
          ui.upsert(items, { id: uiId(q.id, sid), kind: "ship", sessionId: sid, thread: t?.meta.value.name, question: q.text, options: q.options, ts: q.at }, now)
      })
    } catch (e) {
      o.log(`ship: picker not stored: ${(e as Error).message}`)
    }
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
  })
  const sweep = setInterval(() => {
    try {
      engine.sweep()
    } catch (e) {
      o.log(`ship: ${(e as Error).message}`)
    }
  }, 10 * 60_000)
  sweep.unref?.()

  const op = async (req: Record<string, any>, sid: string | undefined): Promise<Out> => {
    switch (req.action) {
      case "feature":
        return engine.feature(sid, { thread: req.thread, name: req.name ?? req.feature, risk: req.risk, why: req.why, flag: req.flag, branch: req.branch })
      case "ready":
        return engine.ready(sid, { thread: req.thread, feature: req.feature ?? req.name, response: req.response })
      case "review":
        return engine.review({ run: req.run, verdict: req.verdict, findings: req.findings, output: req.output })
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
      case "questions":
        return { ok: true, text: `${engine.open().length} waiting`, questions: engine.open().map((q) => ({ id: q.id, kind: q.kind, text: q.text, options: q.options })) }
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
    if (!r.ok && engine.question(qOf(itemId))) ui.withStore((items, now) => ui.reopen(items, itemId, now))
    return { ...r, item: claim.item }
  }

  const guardThreadEdit = async (sid: string | undefined, req: Record<string, any>) => {
    if (typeof req.answer?.id === "string" && engine.question(req.answer.id))
      return { stop: { ok: false, error: "that is a shipping question, and a person answers it themselves: in crosstalk's picker, or with `crosstalk ship answer` in a terminal" }, req }
    if (req.feature?.name && req.feature.risk === "everyday" && !req.feature.remove) {
      const t = o.threads.find(sid, req.thread)
      const f = t && Object.values(t.features).find((x) => !x.gone && (x.name === req.feature.name || x.id === req.feature.name))
      if (f?.risk === "risky") {
        const r = await engine.feature(sid, { thread: t!.id, name: f.name, risk: "everyday", why: req.feature.why })
        return { stop: { ok: r.ok, note: r.text, ...(r.question ? { question: r.question } : {}) }, req }
      }
    }
    return { req }
  }

  return { engine, op, uiAnswer, guardThreadEdit }
}
