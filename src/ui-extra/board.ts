// The board: every thread on one page, and a review page for each, rebuilt
// from what crosstalk keeps (threads, their notes, features, questions and
// Running), so nothing has to be pieced together from terminal output.
//
//   board.html   in crosstalk's folder, refreshed by the daemon every minute
//                while it is being looked at, and reloading itself; opened
//                with "show me the board" (crosstalk_look action "board")
//   each thread  what it is doing, what waits on you, open tasks, decisions,
//                features and where they stand, pull requests and checks,
//                what runs, and the latest messages
//
// A viewer only: answers are given in crosstalk's pickers, and the record is
// the thread itself. Plain HTML, no scripts, nothing fetched.

import fs from "node:fs"
import path from "node:path"
import { P } from "../config.ts"
import * as M from "../threads/model.ts"
import * as ui from "../uistate.ts"
import { paneModel } from "./pane.ts"
import { readThreads } from "./threadfile.ts"
import { running } from "../threads/running.ts"
import { ago, featureLine, prState, runningLine, type PaneModel, type PaneRunning } from "./pure.ts"
import { dotFor } from "../terminal/hook.ts"

export const boardFile = () => path.join(P.root, "board.html")

const esc = (s: string) => s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!)
const slug = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "") || "thread"
const safeUrl = (u: string) => (/^https?:\/\/[^\s"'<>]+$/.test(u) ? u : "")

export type BoardThread = PaneModel & { running?: PaneRunning[]; updatedAt?: number }

/** The page, from the threads' pane models. Pure. */
export function boardHtml(threads: BoardThread[], now: number): string {
  const live = threads.filter((t) => t.status !== "done")
  const done = threads.filter((t) => t.status === "done")
  const waitingTotal = live.reduce((n, t) => n + t.waiting.length, 0)
  const tasksOpen = (t: BoardThread) => (t.notes ?? []).filter((n) => n.kind === "task" && n.state !== "done")
  const card = (t: BoardThread) => `
    <a class="card" href="#${esc(slug(t.thread))}">
      <div class="name">${dotFor(t.thread)} ${esc(t.thread)}</div>
      <div class="meta">${esc(t.status)}${t.sessions ? ` · ${t.sessions} working` : ""}${t.waiting.length ? ` · <b>${t.waiting.length} for you</b>` : ""}${tasksOpen(t).length ? ` · ${tasksOpen(t).length} open tasks` : ""}</div>
      ${t.recap ? `<div class="recap">${esc(t.recap)}</div>` : ""}
    </a>`
  const list = (title: string, rows: string[]) => (rows.length ? `<h3>${esc(title)}</h3><ul>${rows.map((r) => `<li>${r}</li>`).join("")}</ul>` : "")
  const section = (t: BoardThread) => {
    const prs = (t.running ?? []).filter((r) => r.kind === "pr")
    const other = (t.running ?? []).filter((r) => r.kind !== "pr" && r.kind !== "screenshot")
    return `
    <section id="${esc(slug(t.thread))}">
      <h2>${dotFor(t.thread)} ${esc(t.thread)} <span class="meta">${esc(t.status)}${t.repo ? ` · ${esc(t.repo)}` : ""}</span></h2>
      ${t.recap ? `<p class="recap">${esc(t.recap)}</p>` : ""}
      ${t.people.length ? `<p class="meta">With ${esc(t.people.join(", "))}</p>` : ""}
      ${list("Waiting on you", t.waiting.map(esc))}
      ${list("Open tasks", tasksOpen(t).map((n) => `${esc(n.text)}${n.who ? ` <span class="meta">· ${esc(n.who)}</span>` : ""}`))}
      ${list("Decided", (t.notes ?? []).filter((n) => n.kind === "decision" || n.kind === "rule").map((n) => `${esc(n.text)}${n.at ? ` <span class="meta">· ${esc(ago(n.at, now))}</span>` : ""}`))}
      ${list("Features", t.features.map((f) => esc(featureLine(f))))}
      ${list("Pull requests", prs.map((r) => `${safeUrl(r.url ?? "") ? `<a href="${esc(r.url!)}">${esc(r.label)}</a>` : esc(r.label)}${esc(prState(r))}`))}
      ${list("Running", other.map((r) => esc(runningLine(r, now))))}
      ${list("Latest", t.recent.map((m) => `<b>${esc(m.from)}</b>: ${esc(m.text)}`))}
    </section>`
  }
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<meta http-equiv="refresh" content="60"><title>crosstalk board</title>
<style>
:root{--bg:#fbfaf8;--fg:#1d1c1a;--dim:#6b6862;--line:#e6e2dc;--card:#fff;--accent:#5b4bd6}
@media (prefers-color-scheme:dark){:root{--bg:#161514;--fg:#ecebe8;--dim:#9a968f;--line:#2c2a27;--card:#1e1d1b;--accent:#a99cff}}
body{margin:0;background:var(--bg);color:var(--fg);font:15px/1.5 -apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif}
main{max-width:980px;margin:0 auto;padding:24px 16px 64px}
h1{font-size:22px;margin:0 0 4px}h2{font-size:18px;margin:40px 0 4px;padding-top:16px;border-top:1px solid var(--line)}h3{font-size:13px;text-transform:uppercase;letter-spacing:.04em;color:var(--dim);margin:18px 0 6px}
.meta{color:var(--dim);font-size:13px;font-weight:400}.recap{margin:6px 0}
.cards{display:grid;grid-template-columns:repeat(auto-fill,minmax(260px,1fr));gap:12px;margin:20px 0}
.card{display:block;background:var(--card);border:1px solid var(--line);border-radius:10px;padding:12px 14px;color:inherit;text-decoration:none}
.card:hover{border-color:var(--accent)}.name{font-weight:600}
ul{margin:0;padding-left:20px}li{margin:3px 0}a{color:var(--accent)}
</style></head><body><main>
<h1>Your threads</h1>
<p class="meta">${live.length} going${waitingTotal ? ` · ${waitingTotal} waiting on you` : ""} · updated ${esc(new Date(now).toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit" }))} · answers go in crosstalk's questions, in your main session</p>
<div class="cards">${live.map(card).join("") || `<p class="meta">No threads yet.</p>`}</div>
${live.map(section).join("")}
${done.length ? `<h2>Done</h2><ul>${done.map((t) => `<li>${esc(t.thread)}${t.recap ? ` <span class="meta">· ${esc(t.recap)}</span>` : ""}</li>`).join("")}</ul>` : ""}
</main></body></html>
`
}

/** Write the board from what is kept now. Returns its path. */
export function writeBoard(now = Date.now()): string {
  const st = readThreads()
  const items = ui.snapshot()
  const threads: BoardThread[] = Object.values(st.threads)
    .filter((t) => !t.meta.value.combinedInto)
    .map((t) => {
      const m = paneModel(t, items)
      let run: PaneRunning[] = []
      try {
        run = running(m.thread, {})
      } catch {}
      return { ...m, ...(run.length ? { running: run } : {}) }
    })
    .sort((a, b) => b.waiting.length - a.waiting.length || a.thread.localeCompare(b.thread))
  fs.mkdirSync(P.root, { recursive: true, mode: 0o700 })
  const file = boardFile()
  const tmp = `${file}.${process.pid}.tmp`
  fs.writeFileSync(tmp, boardHtml(threads, now), { mode: 0o600 })
  fs.renameSync(tmp, file)
  return file
}

/** Kept current while someone looks at it: refreshed when opened in the last day. */
export function boardWanted(now = Date.now()): boolean {
  try {
    return now - fs.statSync(boardFile() + ".opened").mtimeMs < 86_400_000
  } catch {
    return false
  }
}

export function markOpened() {
  try {
    fs.writeFileSync(boardFile() + ".opened", String(Date.now()), { mode: 0o600 })
  } catch {}
}

void M
