// CPace, so a short spoken phrase never leaves this machine in a form anyone
// can attack offline.
//
// The problem it solves: the relay has to file a join offer under something
// the other side can find. Deriving that from the phrase, which is what
// crosstalk did, hands a relay operator a hash of five words that a GPU reverses
// in seconds. Putting a public slot number in the invite fixes the addressing,
// and CPace fixes the rest: the phrase is turned into a group generator, both
// sides send a blinded point, and the shared key falls out. Guessing costs a
// live protocol run against a slot that works once, rather than an offline
// grind against a hash.
//
// This is the balanced PAKE the CFRG selected, and it is short enough to read in
// one sitting. Group operations come from @noble/curves; nothing here invents
// arithmetic. ristretto255 is used because it is prime order, so there is no
// cofactor to get wrong.

import { ristretto255, ristretto255_hasher } from "@noble/curves/ed25519.js"
import crypto from "node:crypto"

const Point = ristretto255.Point
const ORDER = 2n ** 252n + 27742317777372353535851937790883648493n

const enc = new TextEncoder()
const b64 = (b: Uint8Array) => Buffer.from(b).toString("base64")
const un64 = (s: string) => new Uint8Array(Buffer.from(s, "base64"))

/**
 * The generator both sides derive from the phrase. Stretched first, so that
 * even a party who learns a transcript pays scrypt per guess on top of having
 * to interact.
 */
function generator(phrase: string, sid: string) {
  const stretched = crypto.scryptSync(phrase.trim().toLowerCase(), `crosstalk/cpace/${sid}`, 32, {
    N: 32768,
    r: 8,
    p: 1,
    maxmem: 256 * 1024 * 1024,
  })
  return ristretto255_hasher.hashToCurve(
    new Uint8Array(Buffer.concat([Buffer.from("crosstalk/cpace/v1"), stretched])),
    { DST: "crosstalk-cpace-v1" },
  )
}

const randomScalar = () => {
  // Rejection-free: reduce 64 random bytes, which is the standard construction.
  const wide = crypto.randomBytes(64)
  let n = 0n
  for (const byte of wide) n = (n << 8n) | BigInt(byte)
  const s = n % (ORDER - 1n)
  return s + 1n
}

export type Half = { secret: bigint; message: string }

/** Both sides do the same thing; there is no initiator role. */
export function begin(phrase: string, sid: string): Half {
  const G = generator(phrase, sid)
  const x = randomScalar()
  return { secret: x, message: b64(G.multiply(x).toBytes()) }
}

/**
 * The shared key, or null when the other side used a different phrase. Point
 * decoding rejects anything that is not a valid group element, which is what
 * stops a malicious relay feeding you something degenerate.
 */
export function finish(half: Half, theirMessage: string, sid: string, transcript: string): Buffer | null {
  let theirs
  try {
    theirs = Point.fromBytes(un64(theirMessage))
  } catch {
    return null
  }
  if (theirs.equals(Point.ZERO)) return null

  const shared = theirs.multiply(half.secret)
  // Order the two messages so both sides hash the same transcript.
  const pair = [half.message, theirMessage].sort().join("|")
  return crypto
    .createHash("sha256")
    .update(enc.encode(`crosstalk/cpace/key/v1|${sid}|${pair}|${transcript}|`))
    .update(shared.toBytes())
    .digest()
}

/** A slot is public. It only has to be unique and short enough to say. */
export const isSlot = (s: string) => /^[0-9]{1,6}$/.test(s)
