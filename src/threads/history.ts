// History: everything a thread once had in Running and in Notes, searchable
// (docs/design/next-generation.md, "Three nouns").
//
//   links   every server, preview, pull request and link the thread ever had,
//           with its screenshots: the thread's `links` section
//           (src/urls/history/links.ts), which outlives what runs now
//   notes   notes that ended: a fact corrected or removed, a task done, a
//           decision or rule taken back, a recap replaced on archiving. A
//           removed note is a tombstone that keeps its text, so nothing here
//           is a second store: it is what the thread already holds.
//
// One function searches both, by words, kind and date.

import * as M from "./model.ts"
import * as H from "../urls/history/links.ts"

export type HistoryEntry = {
  /** A link's kind (local, preview, pr, link), or a note's (decision, fact, task, rule, recap). */
  kind: H.LinkKind | M.NoteKind
  label: string
  url?: string
  /** When it was first and last there. */
  first: number
  last: number
  who?: string
  /** A note's: ended because it was done, corrected (and by which), or removed. */
  why?: "done" | "corrected" | "removed"
  shots?: H.Shot[]
  /** What the entry is from: "link" or "note". */
  from: "link" | "note"
}

/** A note that is no longer one: gone, or a task that is done. */
function endedNotes(t: M.Thread): HistoryEntry[] {
  const out: HistoryEntry[] = []
  for (const n of Object.values(t.notes)) {
    const done = !n.gone && n.kind === "task" && n.state === "done"
    if (!n.gone && !done) continue
    if (!n.text) continue
    const why = done ? "done" : n.kind === "fact" && n.supersededBy ? "corrected" : "removed"
    out.push({ kind: n.kind, label: n.text, first: n.at || 0, last: n.at || 0, ...(n.who ? { who: n.who } : {}), why, from: "note" })
  }
  return out
}

/** Every entry, most recently there first. */
export function history(t: M.Thread): HistoryEntry[] {
  const links: HistoryEntry[] = H.links(t).map((l) => ({ kind: l.kind, label: l.label, url: l.url, first: l.first, last: l.last, ...(l.shots?.length ? { shots: l.shots } : {}), from: "link" as const }))
  return [...links, ...endedNotes(t)].sort((a, b) => b.last - a.last)
}

const STOP = /^(the|a|an|of|in|on|what|did|was|were|when|show|me|find|look|like|before|after|page|url|link|history)$/

/** Entries whose label, URL, kind or author has every word of `query`; `before` and `after` are times. */
export function searchHistory(t: M.Thread, o: { query?: string; before?: number; after?: number; kind?: string } = {}): HistoryEntry[] {
  const words = (o.query ?? "")
    .toLowerCase()
    .replace(/#/g, " ")
    .split(/[\s·]+/)
    .filter((w) => w && !STOP.test(w))
  const kindWords: Record<string, string> = { local: "local server dev", preview: "preview deploy", pr: "pr pull request", link: "link", decision: "decision decided", fact: "fact", task: "task done", rule: "rule", recap: "recap" }
  const hay = (e: HistoryEntry) => `${e.label} ${e.url ?? ""} ${e.who ?? ""} ${kindWords[e.kind] ?? e.kind} ${e.why ?? ""} ${e.shots?.length ? "screenshot screenshots shot" : ""}`.toLowerCase()
  return history(t).filter((e) => {
    if (o.kind && e.kind !== o.kind && e.from !== o.kind) return false
    if (o.before !== undefined && e.first >= o.before) return false
    if (o.after !== undefined && e.last < o.after) return false
    return words.every((w) => hay(e).includes(w))
  })
}

/** A History line for the pane: what it was, of which kind, how long ago. */
export function paneHistory(t: M.Thread, max = 5): { kind: string; label: string; at: number; url?: string }[] {
  return history(t)
    .slice(0, max)
    .map((e) => ({ kind: e.from === "note" ? `${e.kind}, ${e.why}` : e.kind === "pr" ? "pull request" : e.kind === "local" ? "server" : e.kind, label: e.label, at: e.last, ...(e.url ? { url: e.url } : {}) }))
}
