// What one person sends the other. Four words when both sides already point at
// the same relay, four words and an address when they do not.
//
//   otter-basalt-thunder-anvil
//   otter-basalt-thunder-anvil @ 100.87.4.21
//
// The phrase is the whole secret. The relay files the offer under a hash of it
// and never sees the phrase, so nothing else has to stay confidential — but the
// phrase itself must reach the other person over something you trust, and never
// through the relay.

import { normalisePhrase } from "./crypto.ts"

export type Invite = { phrase: string; relay?: string }

const DEFAULT_PORT = 8787

export function formatInvite(phrase: string, relayUrl: string, omitRelay: boolean): string {
  if (omitRelay) return phrase
  const u = new URL(relayUrl.replace(/^ws/, "http"))
  const port = u.port && Number(u.port) !== DEFAULT_PORT ? `:${u.port}` : ""
  return `${phrase} @ ${u.hostname}${port}`
}

export function parseInvite(input: string): Invite {
  const raw = input.trim().replace(/^["']|["']$/g, "")
  const [left, right] = raw.split("@").map((s) => s?.trim())
  const phrase = normalisePhrase(left ?? "")
  if (!phrase || phrase.split("-").length < 3)
    throw new Error(`"${input}" does not look like a pairing phrase (expected four words)`)
  if (!right) return { phrase }
  const [host, port] = right.split(":")
  return { phrase, relay: `ws://${host}:${port || DEFAULT_PORT}` }
}
