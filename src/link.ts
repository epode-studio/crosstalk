// The encrypted link between a daemon and the relay.
//
// Before this, frames crossed the wire in plaintext. Bodies were sealed, so a
// listener on your network learned no message contents, but it learned who talks
// to whom and how often, and it could inject frames into an authenticated TCP
// connection because nothing bound a frame to the handshake.
//
// Now both ends do an ephemeral X25519 exchange, each side signing its ephemeral
// key with its long-term Ed25519 identity, and every frame after that is
// authenticated encryption with a strictly increasing counter. A listener sees
// only sizes and timing. An injected frame fails to authenticate.
//
// The relay's identity key reaches the joiner inside the join offer, which is
// sealed under the four-word phrase, so an attacker who can rewrite traffic
// still cannot pass itself off as the relay.

import crypto from "node:crypto"

const b64 = (b: Buffer | Uint8Array) => Buffer.from(b).toString("base64")
const un64 = (s: string) => Buffer.from(s, "base64")

export type Keypair = { pub: string; priv: string }

export function newEd25519(): Keypair {
  const k = crypto.generateKeyPairSync("ed25519")
  return {
    pub: b64(k.publicKey.export({ type: "spki", format: "der" })),
    priv: b64(k.privateKey.export({ type: "pkcs8", format: "der" })),
  }
}

const edPrivKey = (priv: string) =>
  crypto.createPrivateKey({ key: un64(priv), type: "pkcs8", format: "der" })
const edPubKey = (pub: string) =>
  crypto.createPublicKey({ key: un64(pub), type: "spki", format: "der" })

export const signWith = (priv: string, data: Buffer) => b64(crypto.sign(null, data, edPrivKey(priv)))

export function verifyWith(pub: string, data: Buffer, sig: string) {
  try {
    return crypto.verify(null, data, edPubKey(pub), un64(sig))
  } catch {
    return false
  }
}

export function newEphemeral() {
  const k = crypto.generateKeyPairSync("x25519")
  return {
    pub: b64(k.publicKey.export({ type: "spki", format: "der" })),
    key: k.privateKey,
  }
}

const xPubKey = (pub: string) =>
  crypto.createPublicKey({ key: un64(pub), type: "spki", format: "der" })

/**
 * Both ends must agree on the transcript, so it is built from the same bytes in
 * the same order regardless of who is deriving it.
 */
export const transcript = (relayEph: string, clientEph: string, nonce: string) =>
  Buffer.from(`crosstalk/link/v1|${relayEph}|${clientEph}|${nonce}`)

export type LinkKeys = { send: Buffer; recv: Buffer }

export function derive(
  ownEphemeral: crypto.KeyObject,
  peerEphPub: string,
  transcriptBytes: Buffer,
  role: "relay" | "client",
): LinkKeys {
  const shared = crypto.diffieHellman({ privateKey: ownEphemeral, publicKey: xPubKey(peerEphPub) })
  const okm = Buffer.from(
    crypto.hkdfSync("sha256", shared, transcriptBytes, "crosstalk/link/keys/v1", 64),
  )
  const relayToClient = okm.subarray(0, 32)
  const clientToRelay = okm.subarray(32, 64)
  return role === "relay"
    ? { send: relayToClient, recv: clientToRelay }
    : { send: clientToRelay, recv: relayToClient }
}

/** A framed, counted AEAD channel. Reused counters are refused on receipt. */
export class Channel {
  private out = 0
  private lastIn = -1
  constructor(private keys: LinkKeys) {}

  seal(payload: unknown): string {
    const n = this.out++
    const nonce = Buffer.alloc(12)
    nonce.writeUInt32BE(n, 8)
    const c = crypto.createCipheriv("aes-256-gcm", this.keys.send, nonce)
    const ct = Buffer.concat([c.update(JSON.stringify(payload), "utf8"), c.final()])
    return JSON.stringify({ n, c: b64(Buffer.concat([c.getAuthTag(), ct])) })
  }

  open(raw: string): unknown {
    const { n, c } = JSON.parse(raw) as { n: number; c: string }
    if (typeof n !== "number" || n <= this.lastIn) throw new Error("replayed or reordered frame")
    const nonce = Buffer.alloc(12)
    nonce.writeUInt32BE(n, 8)
    const buf = un64(c)
    const d = crypto.createDecipheriv("aes-256-gcm", this.keys.recv, nonce)
    d.setAuthTag(buf.subarray(0, 16))
    const out = Buffer.concat([d.update(buf.subarray(16)), d.final()]).toString("utf8")
    this.lastIn = n
    return JSON.parse(out)
  }
}
