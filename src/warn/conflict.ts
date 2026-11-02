// Conflicts agreed before they happen (docs/design/next-generation.md,
// "Agents talk without being told").
//
// Two threads with unmerged edits to the same top-level symbol are a conflict
// in waiting. Both agents are told at once, each proposes who changes the
// symbol (its own thread, or the other one, which then rebases onto it), and
// each proposal is recorded as a decision in the proposer's thread. Two
// proposals naming the same owner are an agreement. Proposals that keep
// disagreeing become one question to the people after N rounds.

import crypto from "node:crypto"

export type Side = { thread: string; name: string; label: string }
export type Proposal = { owner: string; text: string; at: number; by: string }

export type Conflict = {
  id: string
  repo: string
  file: string
  symbol: string
  sides: [Side, Side]
  proposals: Record<string, Proposal>
  disagreements: number
  state: "open" | "agreed" | "asked" | "decided"
  owner?: string
  at: number
}

export const ROUNDS = () => Math.max(1, Number(process.env.CROSSTALK_CONFLICT_ROUNDS ?? 2))

export function conflictId(repo: string, file: string, symbol: string, a: string, b: string): string {
  const [x, y] = [a, b].sort()
  return `c_${crypto.createHash("sha256").update(`${repo}\0${file}\0${symbol}\0${x}\0${y}`).digest("hex").slice(0, 12)}`
}

export function newConflict(o: { repo: string; file: string; symbol: string; a: Side; b: Side; now?: number }): Conflict {
  const sides = [o.a, o.b].sort((p, q) => (p.thread < q.thread ? -1 : 1)) as [Side, Side]
  return {
    id: conflictId(o.repo, o.file, o.symbol, o.a.thread, o.b.thread),
    repo: o.repo,
    file: o.file,
    symbol: o.symbol,
    sides,
    proposals: {},
    disagreements: 0,
    state: "open",
    at: o.now ?? Date.now(),
  }
}

export const other = (c: Conflict, thread: string) => c.sides.find((s) => s.thread !== thread)!
export const side = (c: Conflict, thread: string) => c.sides.find((s) => s.thread === thread)

/** Who a proposal names, from words an agent would use: "mine", "theirs", or a thread's name or id. */
export function ownerOf(c: Conflict, from: string, who: string): string | undefined {
  const w = who.trim().toLowerCase()
  if (/^(mine|me|us|ours|this|we)$/.test(w)) return from
  if (/^(theirs|them|they|other|you)$/.test(w)) return other(c, from)?.thread
  return c.sides.find((s) => s.thread === who || s.name.toLowerCase() === w)?.thread
}

export type Outcome = "waiting" | "agreed" | "ask" | "disagree" | "settled"

/** One side's proposal. Idempotent for a repeat of the same proposal. */
export function propose(c: Conflict, from: string, p: Proposal): Outcome {
  if (c.state === "agreed" || c.state === "decided") return "settled"
  if (!side(c, from)) return "settled"
  const before = c.proposals[from]
  const same = before && before.owner === p.owner && before.text === p.text
  c.proposals[from] = p
  const mine = c.proposals[from]
  const theirs = c.proposals[other(c, from).thread]
  if (!theirs) return "waiting"
  if (mine.owner === theirs.owner) {
    c.state = "agreed"
    c.owner = mine.owner
    return "agreed"
  }
  if (c.state === "asked") return "disagree"
  if (!same) c.disagreements++
  if (c.disagreements >= ROUNDS()) {
    c.state = "asked"
    return "ask"
  }
  return "disagree"
}

/** The people decided. */
export function decide(c: Conflict, owner: string): boolean {
  if (c.state === "decided" || !side(c, owner)) return false
  c.state = "decided"
  c.owner = owner
  return true
}
