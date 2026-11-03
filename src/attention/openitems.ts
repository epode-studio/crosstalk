// "Tackle all open": an agent's turn that ends with an Open list.
//
// When a turn's last reply has an "Open" section (Open, Open items, Still
// open, Remaining, Next steps, To do), at Stop:
//
//   - each item becomes a task in the session's thread, once, so nothing on the
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

export const hashOf = (items: string[]) => crypto.createHash("sha256").update(items.join("\n")).digest("hex").slice(0, 12)

// --- the preference and what was already taken in --------------------------------------

type Prefs = { always?: boolean; seen?: Record<string, number> }
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
  const tmp = `${file()}.${process.pid}.tmp`
  fs.writeFileSync(tmp, JSON.stringify({ ...p, seen }), { mode: 0o600 })
  fs.renameSync(tmp, file())
}

export const setAlways = (on: boolean) => writePrefs({ ...readPrefs(), always: on })

// --- words ----------------------------------------------------------------------------

export const TACKLE = "Tackle them"
export const ALWAYS = "Always"
export const NOT_NOW = "Not now"

export const question = (n: number) => `Tackle the ${n} open item${n === 1 ? "" : "s"} from that reply?`

/** The turn that tackles them, in crosstalk's words (the person picked it, or said Always). */
export function tacklePrompt(items: string[]): string {
  return [
    `Tackle the open items you listed:`,
    ...items.map((x, i) => `${i + 1}. ${x}`),
    ``,
    `Do each one you can do yourself. For any that needs a decision or an action only the person can take, ask them (one question for all of those, at the end) instead of guessing. When you finish, list only what is still open.`,
  ].join("\n")
}

/**
 * What to do at a Stop: the items, and whether they are new. Pure apart from
 * the preference file, which it updates: a list is taken in once.
 */
export function atStop(o: { reply: string; sessionId: string; continuing: boolean; now?: number }): { items: string[]; id: string; fresh: boolean; auto: boolean } | null {
  const items = parseOpen(o.reply)
  if (!items.length) return null
  const id = hashOf(items)
  const p = readPrefs()
  const key = `${o.sessionId}:${id}`
  const fresh = !p.seen?.[key]
  if (fresh) writePrefs({ ...p, seen: { ...(p.seen ?? {}), [key]: o.now ?? Date.now() } })
  // Continuing by itself once per prompt the person typed: Claude Code says when a turn is already one.
  return { items, id, fresh, auto: !!p.always && !o.continuing && fresh }
}
