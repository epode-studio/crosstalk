// Sealing a thread to its people.
//
// Each thread has one random content key. Every section of the file is sealed
// with it separately (AES-256-GCM, the same seal() every envelope uses), so an
// edit to the decisions changes one line of the file and two people editing
// different sections produce changes git can merge line by line.
//
// The content key itself is wrapped once per person, under the pairwise key
// that person already shares with whoever wrote the wrap (X25519 + HKDF, the
// channel key from src/crypto.ts). Nothing new is exchanged: being able to open
// a thread is exactly having a channel with someone who could.
//
// Until repo trust lands, the trust set is the people you share a room with,
// and only the ones with a direct channel can be wrapped for. A room member
// you have no channel with cannot be added to a sealed thread from this side;
// someone who does have a channel to them can (deferred: wrapping under a room
// key).

import crypto from "node:crypto"
import { channelKey, fingerprint, open, seal } from "../crypto.ts"
import type { Identity, Peer } from "../config.ts"

export type Wrap = { to: string; from: string; k: string }

export const newKey = () => crypto.randomBytes(32)

/** Ourselves as a peer, so a wrap for our own other machines and our future self works the same way. */
export const selfPeer = (id: Identity): Peer => ({
  label: id.label,
  edPub: id.ed.pub,
  xPub: id.x.pub,
  fingerprint: fingerprint(id.ed.pub),
  joinedAt: 0,
})

/**
 * What a wrap binds the key to: the thread (or rules document) it is for and
 * the key's epoch (rekey.ts). Both are sealed inside the wrap with the key, so
 * a file's unauthenticated frontmatter cannot claim an old key is a new one,
 * and a wrap cut from one thread's file does not open as another's.
 */
export type Bind = { thread: string; epoch: number }

/** Wrap the key for each recipient we can reach, always including ourselves. */
export function wrapKey(id: Identity, key: Buffer, recipients: Peer[], bind?: Bind): Wrap[] {
  const me = selfPeer(id)
  const out = new Map<string, Wrap>()
  const payload = bind ? JSON.stringify({ t: bind.thread, e: bind.epoch, k: key.toString("base64") }) : key.toString("base64")
  for (const p of [me, ...recipients]) {
    if (out.has(p.fingerprint)) continue
    out.set(p.fingerprint, { to: p.fingerprint, from: me.fingerprint, k: seal(channelKey(id, p), payload) })
  }
  return [...out.values()].sort((a, b) => (a.to < b.to ? -1 : 1))
}

export type Unwrapped = { key: Buffer; epoch: number; thread?: string; from: string }

/**
 * Every wrap for us, opened. A bound wrap says which thread and epoch it is
 * for; one from before binding (a bare key) reads as epoch 0 with no thread.
 * `from` limits it to wraps written by these fingerprints.
 */
export function unwrapAll(id: Identity, wraps: Wrap[], peers: Peer[], from?: Set<string>): Unwrapped[] {
  const me = selfPeer(id)
  const byFp = new Map(peers.map((p) => [p.fingerprint, p]))
  byFp.set(me.fingerprint, me)
  const out: Unwrapped[] = []
  for (const w of wraps) {
    if (w.to !== me.fingerprint) continue
    if (from && !from.has(w.from)) continue
    const sender = byFp.get(w.from)
    if (!sender) continue
    try {
      const raw = open(channelKey(id, sender), w.k)
      if (raw.startsWith("{")) {
        const o = JSON.parse(raw)
        const k = Buffer.from(String(o?.k ?? ""), "base64")
        if (k.length === 32 && typeof o.t === "string" && Number.isSafeInteger(o.e) && o.e >= 0) out.push({ key: k, epoch: o.e, thread: o.t, from: w.from })
        continue
      }
      const k = Buffer.from(raw, "base64")
      if (k.length === 32) out.push({ key: k, epoch: 0, from: w.from })
    } catch {}
  }
  return out
}

/** The content key, if one of the wraps is for us from someone we share a channel with. */
export function unwrapKey(id: Identity, wraps: Wrap[], peers: Peer[]): Buffer | null {
  return unwrapAll(id, wraps, peers)[0]?.key ?? null
}

/**
 * The key for this thread from a file's wraps, with the epoch the wrap itself
 * names (never the frontmatter's). A wrap bound to another thread is not it.
 */
export function unwrapFor(id: Identity, wraps: Wrap[], peers: Peer[], thread: string, from?: Set<string>): Unwrapped | null {
  const all = unwrapAll(id, wraps, peers, from).filter((u) => u.thread === undefined || u.thread === thread)
  return all.sort((a, b) => b.epoch - a.epoch)[0] ?? null
}

/** One section, sealed with its name inside, so a blob moved to another section does not open as it. */
export const sealSection = (key: Buffer, thread: string, name: string, value: unknown) =>
  seal(key, JSON.stringify({ t: thread, s: name, v: value }))

export function openSection(key: Buffer, thread: string, name: string, blob: string): unknown {
  const o = JSON.parse(open(key, blob))
  if (o?.t !== thread || o?.s !== name) throw new Error(`section ${name} does not belong here`)
  return o.v
}
