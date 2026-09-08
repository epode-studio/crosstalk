// When something is allowed to reach you.
//
// The level says what a source may do at all; this says when. The sender
// declares an intent, which is a claim about their own situation, and what that
// earns is decided here from your level and what your session is doing.
//
// Escalation is downward-safe: an intent can lift a held message to a notice and
// can never lift a notice into your turn. Only your own level does that.

import { atLeast, type Level } from "./trust.ts"
import type { Intent, Kind } from "./protocol.ts"

export type Action = "deliver" | "notify" | "quiet" | "refuse" | "drop"

export type Decision = {
  action: Action
  why: string
  /** Only counts against the attention budget when something actually reached you. */
  interrupts: boolean
}

/** What a kind of message needs before it is allowed at all. */
const REQUIRES: Partial<Record<Kind, Level>> = {
  ask: "ask",
  handoff: "handoff",
}

export function triage(
  level: Level,
  intent: Intent,
  kind: Kind,
  receiverStatus: string,
  muted = false,
): Decision {
  if (level === "mute")
    return { action: "drop", why: "muted permanently at this level", interrupts: false }

  if (muted) return { action: "quiet", why: "held while muted", interrupts: false }

  const needed = REQUIRES[kind]
  if (needed && !atLeast(level, needed))
    return {
      action: "refuse",
      why: `a ${kind} needs ${needed}, and this source is at ${level}`,
      interrupts: false,
    }

  // An answer to something this session asked for is always worth a line.
  if (kind === "answer") return { action: "notify", why: "an answer you asked for", interrupts: true }

  if (level === "deliver")
    return { action: "deliver", why: "this source is set to deliver", interrupts: true }

  const idle = receiverStatus === "idle"
  if (intent === "fyi" && !idle)
    return { action: "quiet", why: "fyi while busy, held until idle", interrupts: false }

  return { action: "notify", why: `${intent} intent, session ${receiverStatus}`, interrupts: true }
}

export const shouldFlushOnIdle = (d: Decision) => d.action === "quiet"
