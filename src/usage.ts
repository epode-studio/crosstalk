// Cost visibility. A delivered message counts toward the receiver's usage like
// a prompt they typed, so two agents chatting spends real money on both
// accounts. Track it and show it, per peer, both directions.

import fs from "node:fs"
import path from "node:path"
import { ROOT } from "./config.ts"

const FILE = path.join(ROOT, "usage.json")

export type PeerUsage = {
  sentMessages: number
  sentChars: number
  recvMessages: number
  recvChars: number
  /** Messages the receiver's Claude was actually handed, notice or inline. */
  recvDelivered: number
  firstAt: number
  lastAt: number
}

export type Usage = Record<string, PeerUsage>

const empty = (): PeerUsage => ({
  sentMessages: 0,
  sentChars: 0,
  recvMessages: 0,
  recvChars: 0,
  recvDelivered: 0,
  firstAt: Date.now(),
  lastAt: Date.now(),
})

export function load(): Usage {
  try {
    return JSON.parse(fs.readFileSync(FILE, "utf8"))
  } catch {
    return {}
  }
}

function save(u: Usage) {
  try {
    fs.mkdirSync(ROOT, { recursive: true, mode: 0o700 })
    fs.writeFileSync(FILE, JSON.stringify(u, null, 2), { mode: 0o600 })
  } catch {}
}

export function record(
  peer: string,
  direction: "sent" | "recv",
  chars: number,
  delivered = false,
) {
  const u = load()
  const p = (u[peer] ??= empty())
  if (direction === "sent") {
    p.sentMessages++
    p.sentChars += chars
  } else {
    p.recvMessages++
    p.recvChars += chars
    if (delivered) p.recvDelivered++
  }
  p.lastAt = Date.now()
  save(u)
}

/**
 * Rough token estimate. Four characters per token is the usual rule of thumb
 * for English prose; this is for orientation, not billing.
 */
export const estTokens = (chars: number) => Math.round(chars / 4)

export function summarise(u: Usage = load()) {
  const rows = Object.entries(u).map(([peer, p]) => ({
    peer,
    sent: p.sentMessages,
    received: p.recvMessages,
    deliveredToClaude: p.recvDelivered,
    estTokensOut: estTokens(p.sentChars),
    estTokensIn: estTokens(p.recvChars),
    since: p.firstAt,
  }))
  return {
    rows,
    totals: {
      sent: rows.reduce((a, r) => a + r.sent, 0),
      received: rows.reduce((a, r) => a + r.received, 0),
      estTokensOut: rows.reduce((a, r) => a + r.estTokensOut, 0),
      estTokensIn: rows.reduce((a, r) => a + r.estTokensIn, 0),
    },
  }
}
