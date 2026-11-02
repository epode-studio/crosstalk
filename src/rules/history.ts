// Answers this machine's person gave, and the "Always do this?" offers they
// led to. Local: the history is how one person answers, and only a rule they
// say yes to becomes the team's (doc.ts).
//
// The second time the same key gets the same answer, crosstalk offers once.
// Yes makes it a rule; No (or never answering) is remembered, and that key is
// not offered again, so nobody is asked "always?" over and over.

import fs from "node:fs"
import path from "node:path"
import crypto from "node:crypto"
import { P } from "../config.ts"
import { neverAuto, normaliseAnswer, ruleKey, describe, type Question } from "./key.ts"

export type Offer = {
  id: string
  key: string
  q: Question
  answer: string
  repo: string
  sessionId?: string
  at: number
  state: "open" | "yes" | "no"
  /** The rule it became. */
  ruleId?: string
}

export type Note = { id: string; text: string }

export type History = {
  v: 1
  answers: Record<string, { answer: string; at: number }[]>
  offers: Record<string, Offer>
  /** Keys offered once already, whatever the answer was. */
  offered: string[]
  /** Rule ids whose arrival or removal this machine has been told of. */
  seen: string[]
  /** Lines for the digest, by session ("*" for whichever session asks first). */
  digest: Record<string, Note[]>
}

export const emptyHistory = (): History => ({ v: 1, answers: {}, offers: {}, offered: [], seen: [], digest: {} })

const file = () => path.join(P.root, "rules.json")

export function loadHistory(): History {
  try {
    const h = JSON.parse(fs.readFileSync(file(), "utf8"))
    if (h?.v === 1) return { ...emptyHistory(), ...h }
  } catch {}
  return emptyHistory()
}

export function saveHistory(h: History) {
  fs.mkdirSync(P.root, { recursive: true, mode: 0o700 })
  for (const k of Object.keys(h.answers)) h.answers[k] = h.answers[k].slice(-5)
  h.offered = h.offered.slice(-500)
  h.seen = h.seen.slice(-1000)
  const tmp = `${file()}.${process.pid}.tmp`
  fs.writeFileSync(tmp, JSON.stringify(h), { mode: 0o600 })
  fs.renameSync(tmp, file())
}

/**
 * Record a person's answer. Returns the offer to make when this is the second
 * time in a row the key got the same answer, and the key was never offered.
 */
export function recordAnswer(h: History, q: Question, answer: string, o: { repo: string; sessionId?: string; now?: number }): Offer | null {
  const now = o.now ?? Date.now()
  const key = ruleKey(q)
  const list = (h.answers[key] ??= [])
  list.push({ answer: normaliseAnswer(answer), at: now })
  if (list.length < 2) return null
  const [a, b] = list.slice(-2)
  if (a.answer !== b.answer || !a.answer) return null
  if (h.offered.includes(key)) return null
  if (neverAuto(q, answer)) return null
  h.offered.push(key)
  const offer: Offer = {
    id: `rule-offer:${crypto.createHash("sha256").update(key).digest("hex").slice(0, 12)}`,
    key,
    q,
    answer: answer.trim(),
    repo: o.repo,
    sessionId: o.sessionId,
    at: now,
    state: "open",
  }
  h.offers[offer.id] = offer
  return offer
}

export const offerQuestion = (o: Offer) =>
  `You answered ${describe(o.q)} with "${o.answer.slice(0, 60)}" twice. Always do this, for everyone in ${o.repo.split("/").slice(-2).join("/") || "this repo"}?`

export const ALWAYS = "Always do this"
export const NOT_NOW = "Not now"

/** The latest open offer, for "make that a rule" with nothing named. */
export function lastOpen(h: History, sessionId?: string): Offer | undefined {
  const open = Object.values(h.offers).filter((o) => o.state === "open")
  return (open.filter((o) => !sessionId || o.sessionId === sessionId).sort((a, b) => b.at - a.at)[0] ?? open.sort((a, b) => b.at - a.at)[0])
}

export function addDigest(h: History, to: string, n: Note) {
  const list = (h.digest[to] ??= [])
  if (!list.some((x) => x.id === n.id)) list.push(n)
}

/** Digest lines for one session: its own, and the ones waiting for whoever comes first. */
export function takeDigest(h: History, sessionId: string): Note[] {
  const out = [...(h.digest[sessionId] ?? []), ...(h.digest["*"] ?? [])]
  delete h.digest[sessionId]
  delete h.digest["*"]
  return out
}
