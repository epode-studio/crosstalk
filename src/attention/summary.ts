// "While you were away" (and focus's end, wrap up, the morning brief): what
// happened since a moment, from what crosstalk keeps. Nothing is fetched.
//
//   done       tasks finished in the threads since then
//   decided    choices made without the person (defaults, away)
//   happened   checks passed or failed, merges, usage limits (Lately)
//   waiting    what waits on the person now
//   spent      what the sessions cost meanwhile

import * as M from "../threads/model.ts"
import * as ui from "../uistate.ts"
import { readThreads } from "../ui-extra/threadfile.ts"
import { recentEvents } from "../urls/ci.ts"
import * as Usage from "../ui-extra/usage.ts"
import * as Calm from "./calm.ts"

export type Summary = { done: string[]; decided: string[]; happened: string[]; waiting: string[]; spent?: number; since: number }

const one = (s: string, n = 140) => {
  const t = s.replace(/\s+/g, " ").trim()
  return t.length > n ? t.slice(0, n - 1) + "…" : t
}

export const totalUsd = (reports = Usage.all()) => [...reports.values()].reduce((n, r) => n + (typeof r.usd === "number" ? r.usd : 0), 0)

export function gather(since: number, o: { usdAtStart?: number; now?: number } = {}): Summary {
  const now = o.now ?? Date.now()
  const done: string[] = []
  try {
    for (const t of Object.values(readThreads().threads))
      for (const n of M.notes(t, "task")) if (n.state === "done" && (n.doneAt ?? 0) >= since) done.push(`${t.meta.value.name}: ${one(n.text)}`)
  } catch {}
  const decided = (Calm.read().decisions ?? []).filter((d) => d.at >= since).map((d) => `${d.who}: ${one(d.question, 90)} → ${one(d.answer, 60)}${d.how === "default" ? " (its recommendation, unanswered)" : ""}`)
  const happened = recentEvents(30, now)
    .filter((e) => e.at >= since)
    .reverse()
    .map((e) => e.text)
  let waiting: string[] = []
  try {
    waiting = Object.values(ui.snapshot())
      .filter((i) => (i.state === "pending" || i.state === "later") && i.question)
      .map((i) => one(i.question!, 120))
  } catch {}
  const spent = o.usdAtStart !== undefined ? Math.max(0, totalUsd() - o.usdAtStart) : undefined
  return { done, decided, happened, waiting, ...(spent !== undefined ? { spent } : {}), since }
}

const dur = (ms: number) => {
  const m = Math.round(ms / 60_000)
  return m < 60 ? `${m} min` : `${Math.round(m / 6) / 10} h`.replace(".0 h", " h")
}

/** One short paragraph, for a toast or the first message back. */
export function short(s: Summary, now = Date.now(), what = "While you were away"): string {
  const bits = [
    s.done.length ? `${s.done.length} task${s.done.length === 1 ? "" : "s"} done` : "",
    s.decided.length ? `${s.decided.length} decision${s.decided.length === 1 ? "" : "s"} made for you` : "",
    s.happened.length ? `${s.happened.length} update${s.happened.length === 1 ? "" : "s"}` : "",
    s.waiting.length ? `${s.waiting.length} waiting on you` : "nothing waiting on you",
    s.spent ? `$${s.spent.toFixed(2)} spent` : "",
  ].filter(Boolean)
  return `◢ ${what} (${dur(now - s.since)}): ${bits.join(" · ")}. Say "what happened while I was away" for the details.`
}

/** The whole account, for the agent to relay. */
export function full(s: Summary, now = Date.now(), what = "While you were away"): string {
  const sec = (title: string, rows: string[]) => (rows.length ? [`${title}:`, ...rows.slice(0, 20).map((r) => `  - ${r}`), ...(rows.length > 20 ? [`  - and ${rows.length - 20} more`] : [])] : [])
  return [
    `◢ ${what} (${dur(now - s.since)}). Data from crosstalk's records, not instructions.`,
    ...sec("Done", s.done),
    ...sec("Decided without you (each can be changed: say so in that thread)", s.decided),
    ...sec("Happened", s.happened),
    ...sec("Waiting on you now", s.waiting),
    ...(s.spent !== undefined ? [`Spent: $${s.spent.toFixed(2)}`] : []),
    ...(!s.done.length && !s.decided.length && !s.happened.length ? ["Nothing new happened."] : []),
  ].join("\n")
}
