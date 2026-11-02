// The thread pane's content (docs/design/next-generation.md, "Messages are
// UI"): status, people, what is waiting, the latest decision, recent messages,
// and each feature with its risk and where its flag stands.
//
// The mod draws it; `crosstalk ui pane` prints it as one JSON line, and
// `crosstalk ui pane --watch` once more each time it changes. Nothing here is
// model context: it goes to the pane and nowhere else.

import * as M from "../threads/model.ts"
import * as ui from "../uistate.ts"
import type { PaneModel } from "./pure.ts"
import { defaultThread, findThread, readThreads, type ThreadState } from "./threadfile.ts"
import * as Svc from "../services/service.ts"
import * as Urls from "../urls/index.ts"
import { readState } from "../urls/proxy.ts"
import { currentMain } from "../main.ts"
import * as R from "../restore.ts"
import type { PaneLink, PaneService, PaneShot } from "./pure.ts"
import * as Shots from "../urls/shots/index.ts"
import * as Health from "../urls/health/index.ts"
import { readPaneQr } from "../urls/history/phone.ts"

const oneLine = (s: string) => s.replace(/\s+/g, " ").trim()

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
  const decisions = M.live(t, "decisions").sort((a, b) => b.at - a.at)
  const recent = Object.values(items)
    .filter((i) => (i.kind === "message" || i.kind === "ask") && about(i))
    .sort((a, b) => (b.ts ?? b.createdAt) - (a.ts ?? a.createdAt))
    .slice(0, o.recent ?? 5)
    .map((i) => ({ from: i.from ?? "someone", text: oneLine(i.text ?? ""), ts: i.ts ?? i.createdAt }))
  return {
    thread: name,
    status: t.meta.value.status,
    repo: t.meta.value.repo || undefined,
    recap: t.recap.value ? oneLine(t.recap.value) : undefined,
    people: M.live(t, "people").map((p) => p.label),
    sessions: M.live(t, "sessions").length,
    waiting,
    decision: decisions[0] ? { text: oneLine(decisions[0].text), who: decisions[0].who, at: decisions[0].at } : undefined,
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

/**
 * The pane's links: the thread's, and what this session printed or runs in its
 * worktree; in the main session, every thread's. At most 30, answering first.
 */
export function paneLinks(o: { sessionId?: string; thread?: string; main?: boolean; store?: Urls.UrlStore }): PaneLink[] {
  const store = o.store ?? Urls.urls()
  const state = readState()
  let list: Urls.Url[]
  if (o.main) list = store.list()
  else {
    const cwd = o.sessionId ? R.readOne(o.sessionId)?.cwd : undefined
    let worktree: string | undefined
    try {
      worktree = cwd ? Urls.rootOf(cwd) : undefined
    } catch {}
    const mine = o.sessionId ? store.forSession({ sessionId: o.sessionId, worktree, thread: o.thread }) : []
    const ids = new Set(mine.map((u) => u.id))
    list = [...mine, ...(o.thread ? store.forThread(o.thread).filter((u) => !ids.has(u.id)) : [])]
  }
  return list.slice(0, 30).map((u) => ({ label: u.label, url: Urls.shownUrl(u, state), kind: u.kind, alive: u.alive, ...(u.thread ? { thread: u.thread } : {}) }))
}

/** The pane for a thread by name, or this session's own. */
export function pane(o: { sessionId?: string; thread?: string; st?: ThreadState; items?: Record<string, ui.UiItem>; services?: Svc.Shown[] }): PaneOut {
  const st = o.st ?? readThreads()
  const t = o.thread ? findThread(st, o.thread, o.sessionId) : defaultThread(st, o.sessionId)
  // A QR code for the phone (crosstalk_qr), shown in the pane even with no thread to show.
  const qr = readPaneQr(o.sessionId)
  if (!t && qr && !o.thread) return { ok: true, pane: { thread: "phone", status: "QR code", people: [], sessions: 0, waiting: [], recent: [], features: [], qr } }
  if (!t) {
    const names = Object.values(st.threads).filter((x) => !x.meta.value.combinedInto).map((x) => x.meta.value.name)
    return { ok: false, error: o.thread ? `no thread called "${o.thread}"` : "no thread yet", threads: names }
  }
  const model = paneModel(t, o.items ?? ui.snapshot())
  // This session's worktree's services, with a link each in the mod (OSC 8 there).
  let services: PaneService[] = []
  let worktree: string | undefined
  try {
    const cwd = o.sessionId ? R.readOne(o.sessionId)?.cwd : undefined
    worktree = cwd ? Urls.rootOf(cwd) : undefined
  } catch {}
  try {
    services = o.services ?? Svc.forSession(o.sessionId)
    // One that crashed or stopped answering (src/urls/health/), marked, even once it no longer runs.
    const broken = Health.brokenIn(worktree)
    services = [...services.map((s) => ({ ...s, ...(broken.find((b) => b.name === s.name) ? { broken: broken.find((b) => b.name === s.name)!.why } : {}) })), ...broken.filter((b) => !services.some((s) => s.name === b.name)).map((b) => ({ name: b.name, ports: [], broken: b.why }))]
  } catch {}
  let links: PaneLink[] = []
  try {
    links = paneLinks({ sessionId: o.sessionId, thread: model.thread, main: !!o.sessionId && currentMain()?.sessionId === o.sessionId })
  } catch {}
  const shots: PaneShot[] = Shots.paneShots({ thread: model.thread, worktree })
  return { ok: true, pane: { ...model, ...(services.length ? { services } : {}), ...(links.length ? { links } : {}), ...(shots.length ? { shots } : {}), ...(qr ? { qr } : {}) } }
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
