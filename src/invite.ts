// What one person says to the other.
//
//   cricket-tungsten-tarn-lathe at pauls-macbook-pro
//
// The words are the whole secret. The relay files the offer under a hash of them
// and never sees the phrase, so nothing else has to stay confidential, but the
// words themselves must reach the other person over something you trust and
// never through the relay.
//
// What follows "at" is only where to look. A machine name is friendlier than an
// address: it says whose machine it is, and it keeps working when the address
// changes. The joining side tries several readings of it, so a bare number
// completes from its own subnet and a name resolves over mDNS.

import { normalisePhrase } from "./crypto.ts"

export type Invite = { slot?: string; phrase: string; where?: string; port?: number }

export const DEFAULT_PORT = 8787

export function formatInvite(phrase: string, where: string | null, port: number): string {
  if (!where) return phrase
  const suffix = port === DEFAULT_PORT ? "" : `:${port}`
  return `${phrase} at ${where}${suffix}`
}

/** "4821-otter-basalt-thunder-anvil at host" or just the words for a link. */
export function parseInvite(input: string): Invite {
  const raw = input.trim().replace(/^["']|["']$/g, "")
  // Accept "at" or "@", with or without spaces, because people retype these.
  const [left, right] = raw.split(/\s+at\s+|\s*@\s*/i).map((s) => s?.trim())
  let phrase = normalisePhrase(left ?? "")
  let slot: string | undefined
  const lead = phrase.match(/^([0-9]{3,6})-(.+)$/)
  if (lead) {
    slot = lead[1]
    phrase = lead[2]
  }
  if (!phrase || phrase.split("-").length < 3)
    throw new Error(`"${input}" does not look like an invite phrase (expected four words)`)
  if (!right) return { slot, phrase }
  const m = right.match(/^(.*?)(?::(\d{2,5}))?$/)
  return { slot, phrase, where: m?.[1] || right, port: m?.[2] ? Number(m[2]) : DEFAULT_PORT }
}
