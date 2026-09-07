// Triage. The sender's Claude says what it wants (intent); the receiver's
// state decides when that lands. This replaces the spec's urgency flag, which
// asked the sender to predict the receiver's state from the other side of a
// relay.

import type { Delivery, PeerPolicy } from "./config.ts"
import type { Intent, Kind } from "./protocol.ts"

export type Decision = {
  action: Delivery
  why: string
}

/**
 * Escalation is downward-safe: intent can lift `quiet` to `notify`, and never
 * lifts anything to `deliver`. Only the human, by setting a peer to `deliver`,
 * gets in-turn interruption.
 */
export function triage(
  policy: PeerPolicy,
  intent: Intent,
  kind: Kind,
  receiverStatus: string,
  now = Date.now(),
): Decision {
  if (policy.mutedUntil && policy.mutedUntil > now) {
    return { action: "quiet", why: `muted for ${Math.ceil((policy.mutedUntil - now) / 60000)}m` }
  }

  if (policy.delivery === "deliver") {
    return { action: "deliver", why: "peer is set to deliver" }
  }

  if (policy.delivery === "quiet") {
    // A blocking question still earns a notice; nothing earns an interruption.
    if (intent === "blocking") return { action: "notify", why: "blocking intent lifts quiet to notify" }
    return { action: "quiet", why: "peer is set to quiet" }
  }

  // policy.delivery === "notify"
  const idle = receiverStatus === "idle"
  if (kind === "answer") {
    return { action: "notify", why: "answer to a question this session asked" }
  }
  if (intent === "fyi" && !idle) {
    return { action: "quiet", why: "fyi while busy, batched until idle" }
  }
  return { action: "notify", why: `${intent} intent, session ${receiverStatus}` }
}

/** Held messages surface when the session next goes idle. */
export const shouldFlushOnIdle = (d: Decision) => d.action === "quiet"
