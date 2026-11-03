// The thread pane's content (docs/design/next-generation.md, "Three nouns"):
// status and people, what is waiting, then a thread's four parts: Notes,
// Features, Running and History, and recent messages.
//
// The mod draws it; `crosstalk ui pane` prints it as one JSON line, and
// `crosstalk ui pane --watch` once more each time it changes. Nothing here is
// model context: it goes to the pane and nowhere else.

import * as M from "../threads/model.ts"
import * as ui from "../uistate.ts"
import type { PaneModel, PaneNote, PaneRunning } from "./pure.ts"
import { defaultThread, findThread, readThreads, type ThreadState } from "./threadfile.ts"
import type * as Svc from "../services/service.ts"
import { currentMain } from "../main.ts"
import { running } from "../threads/running.ts"
import { paneHistory } from "../threads/history.ts"
import { readPaneQr } from "../urls/history/phone.ts"
import { agents as allAgents } from "./agents.ts"

const oneLine = (s: string) => s.replace(/\s+/g, " ").trim()

/** The notes a pane shows: open tasks first, then the newest decisions, facts and rules. */
export function paneNotes(t: M.Thread, max = 6): PaneNote[] {
  const open = M.notes(t, "task").filter((k) => k.state !== "done")
  const rest = M.notes(t, ["decision", "fact", "rule"]).sort((a, b) => b.at - a.at)
  return [...open, ...rest].slice(0, max).map((n) => ({
    kind: n.kind as PaneNote["kind"],
    text: oneLine(n.text),
    ...(n.kind === "task" ? { state: n.state, ...(n.claimedBy ? { who: n.claimedBy } : {}) } : { who: n.who, at: n.at }),
  }))
}

export function paneModel(t: M.Thread, items: Record<string, ui.UiItem>, o: { recent?: number } = {}): PaneModel {
  const name = t.meta.value.name
  const about = (it: ui.UiItem) => (it.thread ?? "").toLowerCase() === name
  const open = Object.values(items).filter((i) => !ui.FINAL.has(i.state) && about(i))
  const waiting = [
    ...M.live(t, "questions")
      .filter((q) => !q.answer)
      .sort((a, b) => Number(!!b.blocking) - Number(!!a.blocking))
      .map((q) => `${oneLine(q.text)}${q.blocking ? " (blocking)" : ""}`),
    ...open.filter((i) => i.kind === "ask").map((i) => `${i.from} asks: ${oneLine(i.text ?? "")}`),
    ...open.filter((i) => i.question && i.kind !== "message" && i.kind !== "ask").map((i) => oneLine(i.question!)),
  ]
  const recent = Object.values(items)
    .filter((i) => (i.kind === "message" || i.kind === "ask") && about(i))
    .sort((a, b) => (b.ts ?? b.createdAt) - (a.ts ?? a.createdAt))
    .slice(0, o.recent ?? 5)
    .map((i) => ({ from: i.from ?? "someone", text: oneLine(i.text ?? ""), ts: i.ts ?? i.createdAt }))
  const notes = paneNotes(t)
  const recap = M.recap(t)
  return {
    thread: name,
    status: t.meta.value.status,
    repo: t.meta.value.repo || undefined,
    recap: recap ? oneLine(recap) : undefined,
    people: M.live(t, "people").map((p) => p.label),
    sessions: M.live(t, "sessions").length,
    waiting,
    ...(notes.length ? { notes } : {}),
    recent,
    features: M.live(t, "features").map((f) => ({
      name: f.name,
      risk: f.risk,
      ...(f.flag ? { flag: f.flag } : {}),
      ...(f.ship?.stage ? { stage: f.ship.stage } : {}),
      ...(f.ship?.state ? { state: f.ship.state } : {}),
    })),
  }
}

export type PaneOut = { ok: true; pane: PaneModel } | { ok: false; error: string; threads: string[] }

/** The pane for a thread by name, or this session's own. */
/** Thread names that mean "every agent", not a thread. */
export const AGENTS = /^(agents?|all|everything|sessions|my agents|all my agents|overview)$/i

/** Every agent on this machine, as a pane of its own. */
export function agentsPane(sessionId?: string, list = allAgents(sessionId)): PaneOut {
  const waiting = list.filter((a) => a.state === "waiting").length
  const working = list.filter((a) => a.state === "working").length
  const status = [`${list.length} open`, working ? `${working} working` : "", waiting ? `${waiting} waiting on you` : ""].filter(Boolean).join(" · ")
  return { ok: true, pane: { thread: "your agents", status, people: [], sessions: 0, waiting: [], recent: [], features: [], agents: list } }
}

export function pane(o: { sessionId?: string; thread?: string; st?: ThreadState; items?: Record<string, ui.UiItem>; services?: Svc.Shown[] }): PaneOut {
  if (o.thread && AGENTS.test(o.thread.trim())) return agentsPane(o.sessionId)
  const isMain = !!o.sessionId && currentMain()?.sessionId === o.sessionId
  // The main session's pane is the overview: every agent, first.
  if (isMain && !o.thread) return agentsPane(o.sessionId)
  const st = o.st ?? readThreads()
  const t = o.thread ? findThread(st, o.thread, o.sessionId) : defaultThread(st, o.sessionId)
  // A QR code for the phone (crosstalk_look action "qr"), shown in the pane even with no thread to show.
  const qr = readPaneQr(o.sessionId)
  if (!t && qr && !o.thread) return { ok: true, pane: { thread: "phone", status: "QR code", people: [], sessions: 0, waiting: [], recent: [], features: [], qr } }
  if (!t) {
    const names = Object.values(st.threads).filter((x) => !x.meta.value.combinedInto).map((x) => x.meta.value.name)
    return { ok: false, error: o.thread ? `no thread called "${o.thread}"` : "no thread yet", threads: names }
  }
  const model = paneModel(t, o.items ?? ui.snapshot())
  let items: PaneRunning[] = []
  try {
    items = running(model.thread, { sessionId: o.sessionId, main: !!o.sessionId && currentMain()?.sessionId === o.sessionId, servers: o.services })
  } catch {}
  // History: what the thread had and no longer runs or knows, the latest few.
  const now = new Set(items.map((r) => r.url).filter(Boolean))
  const history = paneHistory(t, 12).filter((h) => !h.url || !now.has(h.url)).slice(0, 5)
  return { ok: true, pane: { ...model, ...(items.length ? { running: items } : {}), ...(history.length ? { history } : {}), ...(qr ? { qr } : {}) } }
}

/** One line now, then one each time the pane changes, while the session that started this lives. */
export async function watchPane(o: { sessionId: string; thread?: string; interval?: number; write?: (s: string) => void; parent?: number }) {
  const write = o.write ?? ((s: string) => void process.stdout.write(s))
  const parent = o.parent ?? process.ppid
  let last = ""
  for (;;) {
    try {
      process.kill(parent, 0)
    } catch {
      return
    }
    const line = JSON.stringify(pane(o))
    if (line !== last) {
      last = line
      write(line + "\n")
    }
    await new Promise((r) => setTimeout(r, Math.max(250, o.interval ?? 1000)))
  }
}
