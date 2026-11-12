// crosstalk proposes, the person delegates.
//
// Whatever crosstalk would once have done by itself (carry on with a session's open items, pick up what it
// waited on, fix a PR that fell out of the merge queue) is a proposal in the inbox instead: one question,
// what it is about, and a one-key yes. The yes hands the work to the session it is for, as crosstalk's own
// message (the mod's tackle: item, sent once that session is idle); no is nothing at all.

import * as ui from "../uistate.ts"

export const DO_IT = "Carry on"
export const NOT_NOW = "Not now"

export type Proposal = {
  /** Unique per thing proposed: the same id twice is one proposal. */
  key: string
  /** Where it is asked: main's session, else the session it is for. */
  askIn: string
  /** The session that does the work on a yes. */
  forSession: string
  from: string
  thread?: string
  question: string
  text?: string
  /** What that session's agent is told on a yes. */
  prompt: string
  yes?: string
}

export const idOf = (key: string) => `propose:${key}`

/** Put it in the inbox, once. */
export function propose(p: Proposal, items?: Record<string, ui.UiItem>, now = Date.now()) {
  const put = (all: Record<string, ui.UiItem>, t: number) => {
    if (all[idOf(p.key)]) return
    ui.upsert(
      all,
      {
        id: idOf(p.key),
        kind: "attention",
        sessionId: p.askIn,
        from: p.from,
        ...(p.thread ? { thread: p.thread } : {}),
        question: p.question,
        ...(p.text ? { text: p.text } : {}),
        options: [p.yes ?? DO_IT, NOT_NOW],
        delegate: { sessionId: p.forSession, prompt: p.prompt },
        ts: t,
      },
      t,
    )
  }
  if (items) put(items, now)
  else ui.withStore(put)
}

/** The person's answer: a yes hands the prompt to its session; anything else lets it go. */
export function answer(id: string, value: string, now = Date.now()): { ok: boolean; text: string } {
  return ui.withStore((items, t) => {
    const it = items[id]
    if (!it || !it.delegate) return { ok: false, text: "nothing waiting with that id" }
    const yes = value === (it.options?.[0] ?? DO_IT)
    const r = ui.act(items, id, yes ? "answer" : "mute", t, value)
    if (!r.ok) return { ok: false, text: r.error ?? "already answered" }
    if (!yes) return { ok: true, text: "◢ crosstalk: left as it is." }
    ui.upsert(items, { id: `tackle:${it.delegate.sessionId}:${id}`, kind: "attention", sessionId: it.delegate.sessionId, text: it.delegate.prompt, auto: true, ts: t }, t)
    return { ok: true, text: `◢ crosstalk: handed to ${it.from ?? "the session"}.` }
  })
}
