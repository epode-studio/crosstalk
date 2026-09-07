// Paths, identity, peers and policy. Everything crosstalk persists lives in
// ~/.claude/crosstalk/ and is owned by the user, mode 0600.

import fs from "node:fs"
import os from "node:os"
import path from "node:path"

// CROSSTALK_HOME relocates crosstalk own state only. The Claude Code session
// registry is always read from the real home directory, so a second identity
// can be run on one machine for testing without faking sessions.
export const ROOT =
  process.env.CROSSTALK_HOME ?? path.join(os.homedir(), ".claude", "crosstalk")
export const P = {
  root: ROOT,
  identity: path.join(ROOT, "identity.json"),
  peers: path.join(ROOT, "peers.json"),
  policy: path.join(ROOT, "policy.json"),
  relay: path.join(ROOT, "relay.json"),
  queue: path.join(ROOT, "queue.json"),
  parked: path.join(ROOT, "parked.json"),
  usage: path.join(ROOT, "usage.json"),
  daemonSock: path.join(ROOT, "daemon.sock"),
  daemonLock: path.join(ROOT, "daemon.lock"),
  log: path.join(ROOT, "daemon.log"),
}

export type Identity = {
  label: string
  ed: { pub: string; priv: string }
  x: { pub: string; priv: string }
  createdAt: number
}

export type Peer = {
  label: string
  edPub: string
  xPub: string
  fingerprint: string
  pairedAt: number
}

export type Delivery = "notify" | "deliver" | "quiet"

export type PeerPolicy = {
  delivery: Delivery
  mutedUntil?: number
  /** Allow this peer's Claude to use crosstalk_ask against our sessions. */
  allowAsk: boolean
}

export type Policy = {
  default: PeerPolicy
  peers: Record<string, PeerPolicy>
}

export const DEFAULT_POLICY: Policy = {
  // notify is the safe default: a new peer's text never lands in the session
  // under the harness's "teammate" framing until you opt them into deliver.
  default: { delivery: "notify", allowAsk: false },
  peers: {},
}

function ensureRoot() {
  fs.mkdirSync(ROOT, { recursive: true, mode: 0o700 })
}

function readJson<T>(file: string, fallback: T): T {
  try {
    return JSON.parse(fs.readFileSync(file, "utf8")) as T
  } catch {
    return fallback
  }
}

function writeJson(file: string, value: unknown) {
  ensureRoot()
  const tmp = `${file}.tmp`
  fs.writeFileSync(tmp, JSON.stringify(value, null, 2), { mode: 0o600 })
  fs.renameSync(tmp, file)
}

export const loadIdentity = (): Identity | null => readJson<Identity | null>(P.identity, null)
export const saveIdentity = (id: Identity) => writeJson(P.identity, id)

export const loadPeers = (): Record<string, Peer> => readJson(P.peers, {})
export const savePeers = (peers: Record<string, Peer>) => writeJson(P.peers, peers)

export const loadPolicy = (): Policy => {
  const p = readJson(P.policy, DEFAULT_POLICY)
  return { default: { ...DEFAULT_POLICY.default, ...p.default }, peers: p.peers ?? {} }
}
export const savePolicy = (p: Policy) => writeJson(P.policy, p)

export function policyFor(label: string, policy = loadPolicy()): PeerPolicy {
  return { ...policy.default, ...(policy.peers[label] ?? {}) }
}

export const loadRelay = (): { url: string } =>
  readJson(P.relay, { url: process.env.CROSSTALK_RELAY ?? "ws://127.0.0.1:8787" })
export const saveRelay = (url: string) => writeJson(P.relay, { url })

/** Messages held for a session that has not read them yet. */
export type Held = {
  id: string
  from: string
  fromSession: string
  intent: string
  kind: string
  text: string
  slices: { kind: string; label: string; bytes: number }[]
  thread?: string
  replyTo?: string
  /** Set on kind "ask": pass it back to crosstalk_answer. */
  correlation?: string
  /** A notice for this message has been shown. Unset means still silent. */
  surfaced?: boolean
  ts: number
  readAt?: number
}

export const loadQueue = (): Record<string, Held[]> => readJson(P.queue, {})
export const saveQueue = (q: Record<string, Held[]>) => writeJson(P.queue, q)

/**
 * Envelopes that arrived before any local session had registered. They are kept
 * on disk, not in memory: the relay drains its offline buffer the moment the
 * daemon authenticates, which is before the SessionStart hook has run, and a
 * crash in that window used to lose them.
 */
export const loadParked = (): { label: string; env: unknown }[] => readJson(P.parked, [])
export const saveParked = (p: { label: string; env: unknown }[]) => writeJson(P.parked, p)
