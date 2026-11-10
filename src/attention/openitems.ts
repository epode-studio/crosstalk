// "Tackle all open": an agent's turn that ends with an Open list.
//
// When a turn's last reply has an "Open" section (Open, Open items, Still
// open, Remaining, Next steps, To do), at Stop. Items that only wait on
// something ("B is not live until its checks pass", "when B is live, Marie…",
// "CI still running") are told apart (isWaiting) and left alone: mentioned in
// the question, never kept or tackled. A list that only waits asks nothing.
//
//   - each item to do becomes a task in the session's thread, once, so nothing on the
//     list is lost when the session ends or another agent picks the thread up;
//   - the person is asked once, in crosstalk's picker: "Tackle the 4 open
//     items?" Tackle them / Always / Not now. "Tackle them" starts the turn;
//     "Always" does that and from then on the turn goes on by itself, on this
//     machine (`open-items.json`). "Stop tackling open items by itself", said
//     to any session, turns that off (crosstalk_doctor action "open_items").
//
// Continuing by itself is Claude Code's Stop hook block, with one turn of it per
// prompt the person typed (Claude Code's own stop_hook_active), so an agent
// whose list is all decisions for the person cannot loop. Items that need the
// person are the agent's to say so; the prompt tells it to.

import crypto from "node:crypto"
import fs from "node:fs"
import path from "node:path"
import { P } from "../config.ts"
import * as recap from "./recap.ts"

const HEAD = /^\s*(?:#{1,4}\s*)?\**\s*(open|open items|still open|open questions|remaining|left to do|next steps|to do|todo)\s*\**\s*:?\s*\**\s*$/i
const BULLET = /^\s*(?:[-*•]|\d+[.)])\s+(.+)$/

/** The items under an Open heading at the end of a reply, as plain lines. Empty when there is none. */
export function parseOpen(text: string): string[] {
  const lines = text.split("\n")
  let at = -1
  for (let i = lines.length - 1; i >= 0; i--)
    if (HEAD.test(lines[i])) {
      at = i
      break
    }
  if (at < 0) return []
  const out: string[] = []
  for (let i = at + 1; i < lines.length; i++) {
    const l = lines[i]
    const b = BULLET.exec(l)
    if (b) {
      out.push(clean(b[1]))
      continue
    }
    if (!l.trim()) {
      if (out.length) break
      continue
    }
    // A continuation of the bullet above (wrapped), indented.
    if (out.length && /^\s{2,}\S/.test(l)) {
      out[out.length - 1] = clean(`${out[out.length - 1]} ${l}`)
      continue
    }
    break
  }
  return out.filter((x) => x.length >= 4).slice(0, 12)
}

const clean = (s: string) =>
  s
    .replace(/\*\*([^*]+)\*\*/g, "$1")
    .replace(/`([^`]+)`/g, "$1")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 300)

/** The last reply's text, from the transcript's tail. */
export function lastReply(file: string | undefined): string {
  if (!file) return ""
  try {
    const es = recap.lines(recap.tail(file, 128 * 1024))
    for (let i = es.length - 1; i >= 0; i--) {
      const e = es[i]
      if ((e?.message?.role ?? e?.type) !== "assistant") continue
      const t = recap.textOf(e.message?.content).trim()
      if (t) return t
    }
  } catch {}
  return ""
}

/**
 * Whether an open item is only waiting on something (checks running, a merge
 * landing, someone else's move, a release) rather than work to do. Waiting
 * items are mentioned, never kept as tasks or tackled.
 */
const WAITING = [
  /\bwait(?:s|ing)?\b(?: (?:for|on|until))?/i,
  /\b(?:is|are|isn't|aren't) not (?:live|merged|out|done|in|released|deployed)(?: yet)?\b/i,
  /\bnot (?:live|merged|released|deployed) (?:yet|until)\b/i,
  /^\s*(?:once|after|when)\b[^.:]*\b(?:is|are|lands?|landed|merges?|merged|ships?|shipped|passes|passed|goes|is live|finishes|finished|done|out|released|deployed)\b/i,
  /\buntil\b[^.]*\b(?:pass(?:es)?|lands?|merges?|ships?|finish(?:es)?|is|are|comes?)\b/i,
  /\b(?:pending|blocked (?:on|by)|depends on|in progress|in the (?:merge )?(?:queue|train))\b/i,
  /\b(?:ci|checks?|tests?|build|review|deploy(?:ment)?|train|pipeline|release)\b[^.]*\b(?:still )?(?:running|in progress|pending|queued)\b/i,
]

export function isWaiting(item: string): boolean {
  return WAITING.some((r) => r.test(item))
}

/**
 * Whether an item is the person's, not work for an agent: a question, a
 * decision, something they have to do or report ("your console output", "run
 * this in Terminal", "approve", "merge", "deploy"). Mentioned, never kept as a
 * task or tackled.
 */
const PERSON = [
  /\?\s*$/,
  /^\s*(?:decide|should|approve|confirm|choose|pick|sign|log ?in|merge|deploy|release|ship it|your call)\b/i,
  /\b(?:you|your|yours|the person|the user|only you|up to you|on your side|in your browser)\b/i,
  /\b(?:needs?|waiting on|waits on|awaiting)\b[^.]*\b(?:you|approval|review|sign-?off|decision|answer)\b/i,
  /\bneeds? to (?:approve|review|sign|decide|confirm|answer|test)\b/i,
]

export function isPersons(item: string): boolean {
  return PERSON.some((r) => r.test(item))
}

/** A reply that says, in its own words, that what is left is the person's. */
const ALL_PERSONS = /\b(?:(?:all|everything|each)\b[^.\n]{0,40}\b(?:waiting on|waits on|needs|is up to) you|i can'?t do (?:any|all|these|this|them)\b|only you can|is on your side|waiting on you\b)/i

/** Lowercase words only: the same item, however it was bolded, punctuated or reworded slightly. */
export const norm = (s: string) =>
  s
    .toLowerCase()
    .replace(/[^a-z0-9#]+/g, " ")
    .trim()

/** Near enough the same item: most of the shorter one's words are in the other. */
export function same(a: string, b: string): boolean {
  const x = new Set(norm(a).split(" ").filter((w) => w.length > 2))
  const y = new Set(norm(b).split(" ").filter((w) => w.length > 2))
  if (!x.size || !y.size) return norm(a) === norm(b)
  const small = x.size <= y.size ? x : y
  const big = small === x ? y : x
  let hit = 0
  for (const w of small) if (big.has(w)) hit++
  return hit / small.size >= 0.75
}

/** An Open list split into work to do, things only waited on, and the person's own. */
export function split(items: string[]): { todo: string[]; waiting: string[]; persons: string[] } {
  const todo: string[] = []
  const waiting: string[] = []
  const persons: string[] = []
  for (const x of items) (isWaiting(x) ? waiting : isPersons(x) ? persons : todo).push(x)
  return { todo, waiting, persons }
}

export const hashOf = (items: string[]) => crypto.createHash("sha256").update(items.join("\n")).digest("hex").slice(0, 12)

// --- the preference and what was already taken in --------------------------------------

type Prefs = { /** What each session's last open list only waited on: chased when it happens. */ waitingOn?: Record<string, { items: string[]; at: number }>; always?: boolean; seen?: Record<string, number>; seenItems?: Record<string, { t: string; at: number }[]>; /** Rounds carried on in a row since the person last typed, per session. */ chain?: Record<string, number> }
const file = () => path.join(P.root, "open-items.json")

export function readPrefs(): Prefs {
  try {
    return JSON.parse(fs.readFileSync(file(), "utf8")) ?? {}
  } catch {
    return {}
  }
}

export function writePrefs(p: Prefs) {
  fs.mkdirSync(P.root, { recursive: true, mode: 0o700 })
  // The seen list stays small: a week of lists.
  const week = Date.now() - 7 * 86_400_000
  const seen = Object.fromEntries(Object.entries(p.seen ?? {}).filter(([, at]) => at > week))
  const seenItems = Object.fromEntries(Object.entries(p.seenItems ?? {}).filter(([, l]) => l.some((x) => x.at > week)))
  const tmp = `${file()}.${process.pid}.tmp`
  fs.writeFileSync(tmp, JSON.stringify({ ...p, seen, seenItems }), { mode: 0o600 })
  fs.renameSync(tmp, file())
}

export const setAlways = (on: boolean) => writePrefs({ ...readPrefs(), always: on })

// --- words ----------------------------------------------------------------------------

export const DONE = "I've done it"
export const LATER = "Remind me later"
export const NOT_MINE = "Not for me"

export const TACKLE = "Tackle them"
export const ALWAYS = "Always"
export const NOT_NOW = "Not now"

export const question = (n: number) => `Tackle the ${n} open item${n === 1 ? "" : "s"} from that reply?`

/** The picker's context: the work, then what is only waited on and what is the person's (neither tackled nor kept). */
export const context = (todo: string[], waiting: string[], persons: string[] = []) =>
  [...todo.map((x) => `· ${x}`), ...(persons.length ? [`For you (left to you): ${persons.join("; ")}`] : []), ...(waiting.length ? [`Waiting on (left alone): ${waiting.join("; ")}`] : [])].join("\n")

/** The turn that tackles them, in crosstalk's words (the person picked it, or said Always). */
export function tacklePrompt(items: string[], ids: string[] = [], persons: string[] = []): string {
  return [
    ...(items.length
      ? [
          `Tackle the open items you listed:`,
          ...items.map((x, i) => `${i + 1}. ${x}${ids[i] ? ` (task ${ids[i]})` : ""}`),
          ``,
          `Do each one you can do yourself${ids.length ? `, and mark it done with crosstalk_thread action "note", kind "task", op "done" and its task id` : ""}. Leave alone anything that only needs waiting (checks running, a merge or release landing, someone else's move). For any that needs a decision only the person can make, ask them (one question for all of those, at the end) instead of guessing.`,
        ]
      : []),
    ...(persons.length
      ? [
          ...(items.length ? [``] : []),
          `You left these for the person:`,
          ...persons.map((x, i) => `${i + 1}. ${x}`),
          ``,
          `They want you to do these, not to be handed them: they often cannot find this session. Do whatever your tools can (gh, a browser, a script, a command). Where it needs their yes or a choice only they can make (approving, merging, deploying, spending, choosing between options), ask with AskUserQuestion, one question for all of them: name each exact action with its link, and offer options such as "Yes, do it" and "Not now", none marked recommended (so nothing is decided for them while they are away). It reaches them wherever they are. Then do what they chose. Ask them to act themselves only when it is beyond you (a device, a login only on their machine), and then say exactly where, with the link.`,
        ]
      : []),
    ``,
    `When you finish, list only what is still open; if nothing is, say so and leave out the Open list.`,
  ].join("\n")
}

/**
 * What to do at a Stop: the items, and whether they are new. Pure apart from
 * the preference file, which it updates: a list is taken in once.
 */
export const CHAIN_MAX = 3

/** Remember what a session's open list only waits on, even when nothing else in it is new. */
export function noteWaiting(sessionId: string, items: string[], now = Date.now()) {
  if (!items.length) return
  const p = readPrefs()
  writePrefs({ ...p, waitingOn: { ...(p.waitingOn ?? {}), [sessionId]: { items, at: now } } })
}

/**
 * Something a session waited on happened (its PR's checks passed, it merged):
 * the prompt that carries it on, and its waiting items forgotten. Null when it
 * waited on nothing, or that was more than two days ago.
 */
export function chase(sessionId: string, what: string, now = Date.now()): string | null {
  const p = readPrefs()
  const w = p.waitingOn?.[sessionId]
  if (!w || now - w.at > 2 * 86_400_000) return null
  const waitingOn = { ...(p.waitingOn ?? {}) }
  delete waitingOn[sessionId]
  writePrefs({ ...p, waitingOn })
  return [
    `What you were waiting on has moved: ${what}`,
    `You had left these waiting:`,
    ...w.items.map((x, i) => `${i + 1}. ${x}`),
    ``,
    `Carry on with whichever of them this unblocks. Leave the rest as they are, and list only what is still open.`,
  ].join("\n")
}

/** A prompt the person typed: the next open lists may carry on again. */
export function resetChain(sessionId: string) {
  const p = readPrefs()
  if (!p.chain?.[sessionId]) return
  const chain = { ...(p.chain ?? {}) }
  delete chain[sessionId]
  writePrefs({ ...p, chain })
}

export function atStop(o: { reply: string; sessionId: string; continuing: boolean; now?: number }): { items: string[]; waiting: string[]; persons: string[]; id: string; fresh: boolean; auto: boolean } | null {
  const all = parseOpen(o.reply)
  if (!all.length) return null
  // The agent said it in so many words: what is left is the person's.
  const before = o.reply.slice(0, Math.max(0, o.reply.lastIndexOf(all[0]!.slice(0, 20)))) || o.reply
  const { todo, waiting, persons } = ALL_PERSONS.test(before) ? { todo: [] as string[], waiting: [] as string[], persons: all } : split(all)
  const now = o.now ?? Date.now()
  const p = readPrefs()
  // Seen before in this session, however it was reworded: not new. Only what is new is acted on.
  const seen = (p.seenItems?.[o.sessionId] ?? []).map((x) => x.t)
  const isNew = (x: string) => !seen.some((y) => same(x, y))
  const items = todo.filter(isNew)
  const newPersons = persons.filter(isNew)
  const id = hashOf([...todo, ...persons])
  if (!items.length && !newPersons.length) return todo.length || persons.length || waiting.length ? { items: [], waiting, persons: [], id, fresh: false, auto: false } : null
  const kept = [...(p.seenItems?.[o.sessionId] ?? []).filter((x) => now - x.at < 3 * 86_400_000), ...[...items, ...newPersons].map((t) => ({ t, at: now }))].slice(-200)
  // crosstalk manages open items itself unless told not to: work the agent can do, it carries on
  // with, at most CHAIN_MAX rounds in a row before the person types again.
  const on = p.always !== false
  const rounds = p.chain?.[o.sessionId] ?? 0
  // What was left for the person is carried on with too: the agent does it, or asks them in main and then does it.
  const auto = on && !o.continuing && (items.length > 0 || newPersons.length > 0) && rounds < CHAIN_MAX
  writePrefs({ ...p, seenItems: { ...(p.seenItems ?? {}), [o.sessionId]: kept }, ...(auto ? { chain: { ...(p.chain ?? {}), [o.sessionId]: rounds + 1 } } : {}), ...(waiting.length ? { waitingOn: { ...(p.waitingOn ?? {}), [o.sessionId]: { items: waiting, at: now } } } : {}) })
  return { items, waiting, persons: newPersons, id, fresh: !o.continuing, auto }
}

/**
 * A prompt crosstalk sent itself (open items carried on, a chase, a merge-queue fix, a handed message),
 * never the person typing: it must not end away, reset the rounds, or count as them being here.
 */
export const isCrosstalkPrompt = (prompt: string) =>
  /^\s*(Tackle the open items you listed|You left these for the person|I handed you the crosstalk message|What you were waiting on has moved|.{0,200}was taken out of the merge queue, and crosstalk asks you)/.test(prompt)
