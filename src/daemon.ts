#!/usr/bin/env bun
// One daemon per machine. Holds the relay connection, knows every local
// session, and decides when a peer's message is allowed to interrupt one.
//
//   bun src/daemon.ts [--foreground]

import fs from "node:fs"
import net from "node:net"
import path from "node:path"
import crypto from "node:crypto"
import {
  P,
  loadIdentity,
  loadPeers,
  loadRelay,
  loadQueue,
  saveQueue,
  loadParked,
  saveParked,
  loadRegistered,
  saveRegistered,
  loadOutbox,
  saveOutbox,
  type Held,
} from "./config.ts"
import { channelKey, seal, open as unseal, fingerprint as fingerprintOf } from "./crypto.ts"
import { Channel, derive, newEphemeral, signWith, transcript, verifyWith } from "./link.ts"
import { listLocalSessions, findSession, type LocalSession } from "./registry.ts"
import { injectNotice, injectMessage } from "./inject.ts"
import { triage } from "./policy.ts"
import * as trust from "./trust.ts"
import * as outbound from "./outbound.ts"
import { appendDecision } from "./decisions.ts"
import * as usage from "./usage.ts"
import * as rooms from "./rooms.ts"
import * as facts from "./facts.ts"
import * as tasks from "./tasks.ts"
import type { Envelope, Frame, Intent, Kind, SessionPresence, Slice } from "./protocol.ts"

const identity = loadIdentity()
if (!identity) {
  console.error("crosstalk: no identity. Run /crosstalk:room new first.")
  process.exit(1)
}

const log = (...a: unknown[]) => {
  // Whatever starts the daemon points stdout at daemon.log, so writing there
  // as well duplicated every line.
  process.stdout.write(`${new Date().toISOString()} ${a.map(String).join(" ")}\n`)
}

// --- local session registrations ---------------------------------------------

type Registered = {
  sessionId: string
  pid: number
  name: string
  cwd: string
  socket: string
  token?: string
  transcript?: string
  lastStatus: string
  /** When this session last announced itself, used to break cwd ties. */
  seenAt?: number
  /** When this session was handed the working set, so it is handed over once. */
  openedAt?: number
}

/**
 * How long a session with no inbox socket stays on the roster after its last
 * sign of life. Codex and agy publish no registry to check against, and agy
 * gives every `agy -p` run a new conversation id, so without this the roster
 * fills up with sessions that ended hours ago. Anything still unread when one
 * is dropped is carried over to the next session in the same directory.
 */
const PULL_SESSION_TTL_MS = 6 * 60 * 60 * 1000

const stillAround = (id: string, reg: Registered) =>
  reg.socket
    ? listLocalSessions().some((s) => s.sessionId === id)
    : Date.now() - (reg.seenAt ?? 0) < PULL_SESSION_TTL_MS

// Restored from disk, then filtered to whatever is actually still alive, so a
// daemon restart does not orphan a session that is mid-conversation.
const sessions = new Map<string, Registered>(
  Object.entries(loadRegistered()).filter(([id, reg]) =>
    stillAround(id, reg as Registered),
  ) as [string, Registered][],
)
const persistSessions = () => saveRegistered(Object.fromEntries(sessions))

// The filter above ran in memory; write the result back so the file on disk
// does not keep naming sessions this daemon has already forgotten.
persistSessions()

/** Drop pull-mode sessions that have gone quiet. Returns how many went. */
function sweepSessions(): number {
  let gone = 0
  for (const [id, reg] of [...sessions]) {
    if (stillAround(id, reg)) continue
    sessions.delete(id)
    gone++
  }
  if (gone) persistSessions()
  return gone
}

/**
 * Which session a request is about.
 *
 * Claude Code and Codex put the session id in the environment of everything
 * they start, so the tools know who they are. agy tells a hook its conversation
 * id but tells an MCP server nothing, and an agy started from a Claude Code
 * shell inherits that shell's session id, so the id can also be absent or
 * simply wrong. What agy does get right is the working directory: it runs an
 * MCP server in the workspace, and its hook reports that same directory when it
 * registers.
 *
 * So the directory decides whenever it disagrees with the id. A named session
 * is used when it matches the caller's directory or when no directory was sent.
 * Two sessions in one directory resolve to the one that registered most
 * recently.
 */
function newestIn(cwd: string): Registered | undefined {
  return [...sessions.values()]
    .filter((s) => s.cwd === cwd)
    .sort((a, b) => (b.seenAt ?? 0) - (a.seenAt ?? 0))[0]
}

function resolveSession(req: { sessionId?: string; cwd?: string }): Registered | undefined {
  const named = req.sessionId ? sessionById(req.sessionId) : undefined
  if (!req.cwd) return named
  if (named && named.cwd === req.cwd) return named
  return newestIn(req.cwd) ?? named
}

/**
 * Claude Code publishes a registry of live sessions with their status. Codex
 * does not, so a session that registered here without an inbox socket is
 * reported from what it told us at registration.
 */
const localPresence = (): SessionPresence[] => {
  const live = listLocalSessions()
  const out: SessionPresence[] = []
  for (const reg of sessions.values()) {
    const known = live.find((s) => s.sessionId === reg.sessionId)
    out.push({
      name: known?.name ?? reg.name,
      cwd: known?.cwd ?? reg.cwd,
      status: known?.status ?? "unknown",
      lastSeen: known?.updatedAt ?? Date.now(),
    })
  }
  return out
}

function pickSession(preferName?: string): Registered | undefined {
  if (preferName) {
    const byName = [...sessions.values()].find((s) => s.name === preferName)
    if (byName) return byName
  }
  // Prefer a session Claude Code says is idle, then any it says is live, then
  // anything registered at all, which is how a Codex session gets chosen since
  // it appears in no registry.
  const live = listLocalSessions()
  const known = live.filter((l) => sessions.has(l.sessionId))
  const idle = known.find((l) => l.status === "idle")
  if (idle) return sessions.get(idle.sessionId)
  if (known[0]) return sessions.get(known[0].sessionId)
  return [...sessions.values()][0]
}

/** "unknown" for a client that does not publish one, which triage treats as busy. */
const statusOf = (sessionId: string) =>
  listLocalSessions().find((s) => s.sessionId === sessionId)?.status ?? "unknown"

// --- held messages ------------------------------------------------------------

const held: Record<string, Held[]> = loadQueue()

// Sessions whose MCP server is subscribed for channel push. When one is, a
// notice goes out as a <channel> event instead of being injected into the
// transcript. Either way it is only a notice, never the peer's own words.
const subscribers = new Map<string, Set<net.Socket>>()

/**
 * What has been reaching you, counted but not capped.
 *
 * There used to be a ceiling of forty an hour here, and a number nobody chose
 * is a worse answer than the one already in the trust ladder: if someone
 * interrupts too much, that is what `crosstalk trust` is for, and it applies to
 * the person rather than to everyone at once. A cap also failed in the wrong
 * direction, quietly holding the message that mattered because unrelated ones
 * had used the allowance up.
 */
const noticeTimes: number[] = []
function recordNotice(): void {
  const now = Date.now()
  while (noticeTimes.length && now - noticeTimes[0] > 3_600_000) noticeTimes.shift()
  noticeTimes.push(now)
}

function push(sessionId: string, msg: unknown): boolean {
  const set = subscribers.get(sessionId)
  if (!set?.size) return false
  const line = JSON.stringify(msg) + "\n"
  let sent = false
  for (const s of set) {
    try {
      s.write(line)
      sent = true
    } catch {}
  }
  return sent
}
const slicesById = new Map<string, Slice[]>()
const persist = () => saveQueue(held)

function hold(sessionId: string, h: Held, slices?: Slice[]) {
  ;(held[sessionId] ??= []).push(h)
  if (slices?.length) slicesById.set(h.id, slices)
  persist()
}

// --- peer presence cache -------------------------------------------------------

// Envelopes that arrived before any local session had registered. Persisted, so
// a daemon crash between the relay's drain and the SessionStart hook does not
// lose them.
const orphaned: { label: string; env: Envelope; stranger?: boolean }[] = loadParked() as {
  label: string
  env: Envelope
  stranger?: boolean
}[]
const persistParked = () => saveParked(orphaned)

const peerPresence = new Map<string, { sessions: SessionPresence[]; at: number }>()
const online = new Set<string>()

// --- relay --------------------------------------------------------------------

const peersByFingerprint = () => {
  const out = new Map<string, ReturnType<typeof loadPeers>[string]>()
  for (const p of Object.values(loadPeers())) out.set(p.fingerprint, p)
  return out
}

let ws: WebSocket | null = null
let channel: Channel | null = null
// A hosted relay is always wss, and TLS already hides the metadata that the
// custom link layer exists to hide, so that handshake is skipped there.
let workerMode = false
let backoff = 1000
const pendingAsks = new Map<string, { peer: string; resolve: (answer: Envelope) => void }>()

function connect() {
  const { url } = loadRelay()
  // Hosted relays are wss. The override exists so the Worker can be tested
  // against a local wrangler, which serves plain ws.
  workerMode = process.env.CROSSTALK_RELAY_KIND === "worker" || url.startsWith("wss://")
  const base = url.endsWith("/ws") ? url : url.replace(/\/$/, "") + "/ws"
  const target = workerMode ? `${base}?fp=${encodeURIComponent(myFingerprint())}` : base
  log(`relay connecting ${base}${workerMode ? " (hosted)" : ""}`)
  const sock = new WebSocket(target)
  ws = sock

  let eph: ReturnType<typeof newEphemeral> | null = null
  let pendingTranscript: Buffer | null = null

  sock.onmessage = (ev) => {
    if (workerMode) {
      let f: Frame
      try {
        f = JSON.parse(String(ev.data)) as Frame
        lastHeard = Date.now()
      } catch {
        return
      }
      return onFrame(f, null)
    }

    // Only the first frame is plaintext. Everything after it is sealed.
    if (!channel) {
      let h: any
      try {
        h = JSON.parse(String(ev.data))
      } catch {
        return sock.close()
      }
      if (h.t !== "hello" || !h.ephPub || !h.nonce) return sock.close()
      eph = newEphemeral()
      pendingTranscript = transcript(h.ephPub, eph.pub, h.nonce)
      channel = new Channel(derive(eph.key, h.ephPub, pendingTranscript, "client"))
      sock.send(
        JSON.stringify({
          t: "hello",
          ephPub: eph.pub,
          pub: identity!.ed.pub,
          label: identity!.label,
          sig: signWith(identity!.ed.priv, pendingTranscript),
        }),
      )
      return
    }

    let f: Frame
    try {
      f = channel.open(String(ev.data)) as Frame
      lastHeard = Date.now()
    } catch {
      log("relay sent a frame this link could not open; reconnecting")
      channel = null
      return sock.close()
    }

    return onFrame(f, pendingTranscript)
  }

  function onFrame(f: Frame, pendingTranscript: Buffer | null) {
    if (f.t === "ready") {
      // The relay proves which relay it is, inside the channel. A pinned key
      // that does not match means someone is standing in the middle.
      const pinned = loadRelay().pub
      const sig = (f as any).sig
      if (pinned) {
        if (!sig || !verifyWith(pinned, pendingTranscript!, sig)) {
          log("RELAY IDENTITY MISMATCH: refusing this link")
          channel = null
          return sock.close()
        }
      } else if (sig) {
        // No pin yet, which happens on the machine that started the relay
        // itself. Trust on first use; the other side gets the key inside the
        // sealed join offer instead.
        log("no pinned relay identity; continuing unpinned")
      }
      backoff = 1000
      lastHeard = Date.now()
      log(`relay ready as ${f.fingerprint}`)
      flushOutbox()
      publishPresence()
      requestFactSync()
      return
    }
    if (f.t === "presence") {
      online.clear()
      for (const p of f.peers) online.add(p)
      return
    }
    if (f.t === "deliver") {
      const peer = peersByFingerprint().get(f.from)
      if (!peer) return log(`dropped message from unpaired fingerprint ${f.from}`)
      try {
        const env: Envelope = JSON.parse(unseal(channelKey(identity!, peer), f.body))
        onEnvelope(peer.label, env)
      } catch (e) {
        log(`failed to open body from ${peer.label}: ${(e as Error).message}`)
      }
    }
    if (f.t === "room") return onRoster(f.room)
    if (f.t === "rooms") return f.rooms.forEach(onRoster)
    if (f.t === "room_gone") {
      const st = rooms.load()
      delete st[f.roomId]
      rooms.save(st)
      return
    }
    if (f.t === "room_deliver") return onRoomBody(f)
    if (f.t === "error") log(`relay error: ${f.message}`)
  }

  sock.onopen = () => {
    if (!workerMode) return
    backoff = 1000
    lastHeard = Date.now()
    log(`relay ready as ${myFingerprint()} (hosted)`)
    flushOutbox()
    publishPresence()
  }

  sock.onclose = () => {
    ws = null
    channel = null
    backoff = Math.min(backoff * 2, 30_000)
    setTimeout(connect, backoff)
  }
  sock.onerror = () => {}
}

function sendEnvelope(
  peerLabel: string,
  env: Envelope,
): { ok: boolean; error?: string; queued?: boolean; note?: string } {
  const peer = loadPeers()[peerLabel]
  if (!peer) return { ok: false, error: `not in a room with "${peerLabel}"` }
  const frame = {
    t: "send",
    to: peer.fingerprint,
    id: env.id,
    body: seal(channelKey(identity!, peer), JSON.stringify(env)),
  }
  // Presence describes a moment, so a stale one is worse than none.
  if (env.kind === "presence") return relaySend(frame) ? { ok: true } : { ok: false, error: "relay not connected" }
  const now = relayQueue(frame, peerLabel)
  return now
    ? { ok: true }
    : { ok: true, queued: true, note: `${peerLabel} or the relay is unreachable; held and will go when the link is back` }
}


// --- rooms --------------------------------------------------------------------

const myFingerprint = () => fingerprintOf(identity!.ed.pub)

/** The relay's roster is authoritative for membership; keys stay local. */
function onRoster(r: { id: string; name: string; members: any[] }) {
  const st = rooms.load()
  const existing = st[r.id]
  const me = myFingerprint()
  const mine = r.members.find((m) => m.fingerprint === me)
  if (!mine) {
    delete st[r.id]
    rooms.save(st)
    return
  }
  const room: rooms.Room = existing ?? {
    id: r.id,
    name: r.name,
    keys: {},
    epoch: 0,
    members: {},
  }
  room.name = r.name
  room.members = Object.fromEntries(r.members.map((m) => [m.fingerprint, { ...m, addedAt: Date.now() }]))
  if (mine.state === "invited") {
    const inviter = peersByFingerprint().get(mine.addedBy)
    room.pending = { invitedBy: inviter?.label ?? mine.addedBy, at: Date.now() }
  } else {
    delete room.pending
    room.joinedAt ??= Date.now()
  }
  rooms.upsert(room, st)
  if (room.pending) notifyInvitation(room)
}

/** An invitation is a notice, never a message. Nothing from the room lands yet. */
function notifyInvitation(room: rooms.Room) {
  const target = pickSession()
  if (!target) return
  const others = Object.values(room.members)
    .filter((m) => m.fingerprint !== myFingerprint())
    .map((m) => m.label)
  injectNotice(
    { socket: target.socket, replyTo: target.socket, fromName: `crosstalk ◢ invite` },
    {
      count: 1,
      peer: room.pending!.invitedBy,
      peerSession: `#${room.name}`,
      intent: "fyi",
      kind: `room invitation (with ${others.join(", ") || "nobody else yet"}); accept with /crosstalk:room accept ${room.name}`,
    },
  ).catch(() => {})
}

/** Room bodies are sealed with the room key, which the relay never holds. */
function onRoomBody(f: { roomId: string; from: string; body: string; id: string }) {
  const st = rooms.load()
  const room = st[f.roomId]
  if (!room || room.pending) return log(`dropped room message for a room we have not joined`)
  let env: Envelope | null = null
  for (const epoch of Object.keys(room.keys).map(Number).sort((a, b) => b - a)) {
    try {
      env = JSON.parse(unseal(rooms.keyFor(room, epoch)!, f.body))
      break
    } catch {}
  }
  if (!env) return log(`could not open a message in #${room.name}; we may have missed a rekey`)
  const sender = room.members[f.from]
  const direct = peersByFingerprint().get(f.from)
  onEnvelope(direct?.label ?? sender?.label ?? "someone", env, {
    room,
    strangerInRoom: !direct,
  })
}

// --- inbound ------------------------------------------------------------------

// Replay defence. The channel key authenticates who wrote an envelope but says
// nothing about when, so a relay that keeps a copy could re-deliver it forever.
const seenIds = new Map<string, number>()
const MAX_SKEW_MS = 10 * 60_000
const REPLAY_WINDOW_MS = 24 * 60 * 60_000
setInterval(() => {
  const now = Date.now()
  for (const [id, ts] of seenIds) if (now - ts > REPLAY_WINDOW_MS) seenIds.delete(id)
}, 60_000)

function onEnvelope(
  peerLabel: string,
  env: Envelope,
  ctx?: { room?: rooms.Room; strangerInRoom?: boolean; replayingParked?: boolean },
) {
  // A parked envelope is re-run through here once a session registers, so the
  // duplicate check has to skip that path and only record an id once the
  // message is actually held.
  if (!ctx?.replayingParked && seenIds.has(env.id))
    return log(`dropped replay of ${env.id} from ${peerLabel}`)
  const age = Date.now() - (env.ts ?? 0)
  if (age > REPLAY_WINDOW_MS || age < -MAX_SKEW_MS) {
    return log(`dropped stale or future-dated ${env.kind} from ${peerLabel} (${Math.round(age / 1000)}s)`)
  }

  if (env.kind === "presence") {
    peerPresence.set(peerLabel, { sessions: env.presence ?? [], at: Date.now() })
    return
  }

  if (env.kind === "answer" && env.correlation) {
    const waiter = pendingAsks.get(env.correlation)
    if (waiter) {
      if (waiter.peer !== peerLabel) {
        return log(`dropped answer for ${waiter.peer}'s question, sent by ${peerLabel}`)
      }
      pendingAsks.delete(env.correlation)
      waiter.resolve(env)
      return
    }
  }

  if (env.kind === "room_key") return acceptRoomKey(peerLabel, env)

  if (env.kind === "fact" || env.kind === "fact_sync") return acceptFacts(peerLabel, env)
  if (env.kind === "task" || env.kind === "task_sync") return acceptTasks(peerLabel, env)

  const tctx: trust.Context = {
    room: ctx?.room?.name ?? (env.room ? env.room.replace(/^#/, "") : undefined),
    direct: !ctx?.strangerInRoom,
    machine: !!loadPeers()[peerLabel]?.isMachine,
  }
  const level = trust.levelFor(peerLabel, tctx)
  const muted = trust.isMuted(peerLabel, tctx)
  if (env.kind === "ask" && !trust.atLeast(level, "ask")) {
    log(`refused ask from ${peerLabel}: they are at ${level}`)
    if (env.correlation)
      sendEnvelope(peerLabel, {
        v: 1,
        id: crypto.randomUUID(),
        ts: Date.now(),
        from: identity!.label,
        fromSession: "-",
        to: peerLabel,
        kind: "answer",
        intent: "fyi",
        correlation: env.correlation,
        text: ctx?.strangerInRoom
          ? "Refused: we share a room but no direct channel, and a question from someone without one is capped at a notice. Send a message instead."
          : `Refused: you are at "${level}" here, and a question needs "ask". They can raise it with /crosstalk:trust. Send a message instead.`,
      })
    return
  }

  const target = pickSession(env.toSession)
  if (!target) {
    orphaned.push({ label: peerLabel, env, stranger: !!ctx?.strangerInRoom })
    persistParked()
    return log(`no local session registered yet; parked message from ${peerLabel}`)
  }

  const decision = { ...triage(level, env.intent, env.kind, statusOf(target.sessionId), muted) }
  if (decision.action === "drop") return log(`dropped ${env.kind} from ${peerLabel}: ${decision.why}`)
  const h: Held = {
    id: env.id,
    from: peerLabel,
    fromSession: env.fromSession,
    fromAgent: env.fromAgent,
    intent: env.intent,
    kind: env.kind,
    text: env.text,
    slices: (env.slices ?? []).map((s) => ({ kind: s.kind, label: s.label, bytes: s.bytes })),
    thread: env.thread,
    replyTo: env.replyTo,
    room: ctx?.room ? `#${ctx.room.name}` : env.room,
    correlation: env.correlation,
    ts: env.ts,
  }
  seenIds.set(env.id, Date.now())
  hold(target.sessionId, h, env.slices)
  log(`inbound ${env.kind}/${env.intent} from ${peerLabel} → ${target.name}: ${decision.action} (${decision.why})`)

  // Account for it before anything can return early, or a client that pulls
  // rather than being pushed to would never show up in the cost at all.
  usage.record(peerLabel, "recv", env.text.length, decision.interrupts)

  // Nothing to push to in pull mode. The hook collects it, and spends the
  // attention budget then rather than now.
  if (!target.socket) {
    log(`held for ${target.name}, which pulls rather than being pushed to`)
    return
  }

  const opts = {
    socket: target.socket,
    replyTo: target.socket,
    fromName: `crosstalk ◢ ${peerLabel}/${env.fromSession}`,
    // Deliberately no token. Presenting the session's own messaging token would
    // make this a verified own-child message, which skips the approval hold
    // Claude Code applies to unverified peers. A different person's text must
    // stay subject to that hold.
  }

  if (decision.interrupts) recordNotice()
  if (decision.action !== "quiet") h.surfaced = true
  persist()

  if (decision.action === "deliver") {
    injectMessage(opts, {
      peer: peerLabel,
      peerSession: env.fromSession,
      intent: env.intent,
      text: env.text,
      id: env.id,
    }).catch((e) => log(`inject failed: ${e.message}`))
  } else if (decision.action === "notify") {
    const notice = {
      count: (held[target.sessionId] ?? []).filter((m) => !m.readAt).length,
      peer: peerLabel,
      peerSession: env.fromSession,
      intent: env.intent,
      kind: env.kind,
    }
    if (!push(target.sessionId, { push: "arrival", ...notice })) {
      injectNotice(opts, notice).catch((e) => log(`inject failed: ${e.message}`))
    }
  }
  // quiet: nothing now; the idle watcher surfaces it.
}


/** The inviter hands over the room key on the pairwise channel we already share. */
function acceptRoomKey(peerLabel: string, env: Envelope) {
  const k = env.presence as unknown as { roomId: string; name: string; epoch: number; key: string }
  if (!k?.roomId || !k.key) return
  const st = rooms.load()
  const room = st[k.roomId] ?? {
    id: k.roomId,
    name: k.name,
    keys: {},
    epoch: k.epoch,
    members: {},
    pending: { invitedBy: peerLabel, at: Date.now() },
  }
  const isNew = !room.keys[k.epoch]
  room.keys[k.epoch] = k.key
  room.epoch = Math.max(room.epoch ?? 0, k.epoch)
  room.name = k.name ?? room.name
  rooms.upsert(room, st)
  log(`received the key for #${room.name} epoch ${k.epoch} from ${peerLabel}`)

  // Whoever rekeys can only hand the key to people they have a channel to, so
  // pass it along to the ones they could not reach. A member that already has
  // this epoch stops, which is what keeps this from going round forever.
  if (!isNew) return
  const peers = loadPeers()
  for (const m of Object.values(room.members)) {
    if (m.fingerprint === myFingerprint()) continue
    const label = Object.values(peers).find((x) => x.fingerprint === m.fingerprint)?.label
    if (!label || label === peerLabel) continue
    sendRoomKey(label, room)
  }
}

function sendRoomKey(peerLabel: string, room: rooms.Room) {
  return sendEnvelope(peerLabel, {
    v: 1,
    id: crypto.randomUUID(),
    ts: Date.now(),
    from: identity!.label,
    fromSession: "-",
    to: peerLabel,
    kind: "room_key" as Kind,
    intent: "fyi",
    text: "",
    presence: {
      roomId: room.id,
      name: room.name,
      epoch: room.epoch,
      key: room.keys[room.epoch],
    } as any,
  })
}

const OUTBOX_TTL_MS = 24 * 60 * 60_000
const outbox = loadOutbox()

const relaySend = (o: unknown) => {
  if (!ws || ws.readyState !== 1) return false
  if (!workerMode && !channel) return false
  try {
    ws.send(workerMode ? JSON.stringify(o) : channel!.seal(o))
    return true
  } catch {
    return false
  }
}

/**
 * Send now, or keep it until the link is back. Presence and pings are dropped
 * rather than queued: they describe a moment, and a stale one is worse than
 * none.
 */
function relayQueue(frame: any, describe: string): boolean {
  if (relaySend(frame)) return true
  outbox.push({ to: describe, frame, ts: Date.now() })
  const cutoff = Date.now() - OUTBOX_TTL_MS
  while (outbox.length && outbox[0].ts < cutoff) outbox.shift()
  while (outbox.length > 500) outbox.shift()
  saveOutbox(outbox)
  log(`relay down, held a message for ${describe} (${outbox.length} waiting)`)
  return false
}

function flushOutbox() {
  if (!outbox.length) return
  const cutoff = Date.now() - OUTBOX_TTL_MS
  const fresh = outbox.filter((m) => m.ts >= cutoff)
  const dropped = outbox.length - fresh.length
  outbox.length = 0
  let sent = 0
  for (const m of fresh) {
    if (relaySend(m.frame)) sent++
    else outbox.push(m)
  }
  saveOutbox(outbox)
  if (sent || dropped)
    log(`flushed ${sent} held message(s)${dropped ? `, dropped ${dropped} older than a day` : ""}`)
}

// --- the working set ---------------------------------------------------------

/** A fact op from a peer. Writing needs "ask", so a stranger can read and not write. */
function acceptFacts(peerLabel: string, env: Envelope) {
  const named = (env.room ?? "").replace(/^#/, "")
  // No room means it is the room of two we share, which I call by their name.
  const room = named || peerLabel
  const level = trust.levelFor(peerLabel, { room: named || undefined, direct: !!loadPeers()[peerLabel] })
  if (!trust.atLeast(level, "ask"))
    return log(`ignored a fact from ${peerLabel}: they are at ${level}, writing needs ask`)

  const ops = env.kind === "fact_sync" ? (env.fact as facts.Op[]) : [env.fact as facts.Op]
  let changed = 0
  for (const op of ops ?? []) if (op && facts.apply(room, op)) changed++
  if (changed) log(`${changed} fact change(s) in #${room} from ${peerLabel}`)

  // A sync request is answered with everything we have for that room.
  if (env.kind === "fact_sync" && !ops?.length) shareFacts(peerLabel, room)
}

/** A task op from a peer. Writing needs "ask", same as facts. */
function acceptTasks(peerLabel: string, env: Envelope) {
  const named = (env.room ?? "").replace(/^#/, "")
  // No room means it is the room of two we share, which I call by their name.
  const room = named || peerLabel
  const level = trust.levelFor(peerLabel, { room: named || undefined, direct: !!loadPeers()[peerLabel] })
  if (!trust.atLeast(level, "ask"))
    return log(`ignored a task change from ${peerLabel}: they are at ${level}`)

  const ops = env.kind === "task_sync" ? (env.task as tasks.TaskOp[]) : [env.task as tasks.TaskOp]
  let changed = 0
  for (const op of ops ?? []) if (op && tasks.apply(room, op)) changed++
  if (changed) log(`${changed} task change(s) in #${room} from ${peerLabel}`)

  if (env.kind === "task_sync" && !ops?.length) {
    const all: tasks.TaskOp[] = tasks.openTasks(room).map((task) => ({ op: "add", task }))
    if (all.length)
      sendEnvelope(peerLabel, {
        v: 1,
        id: crypto.randomUUID(),
        ts: Date.now(),
        from: identity!.label,
        fromSession: "-",
        to: peerLabel,
        kind: "task_sync",
        intent: "fyi",
        text: "",
        ...(rooms.byName(room) ? { room: `#${room}` } : {}),
        task: all,
      })
  }
}

function broadcastTask(room: string, op: tasks.TaskOp) {
  const r = rooms.byName(room)
  const members = r
    ? Object.values(r.members)
        .map((m) => Object.values(loadPeers()).find((p) => p.fingerprint === m.fingerprint)?.label)
        .filter((x): x is string => !!x)
    : Object.keys(loadPeers()).filter((label) => label === room)
  for (const label of members) {
    if (label === identity!.label) continue
    sendEnvelope(label, {
      v: 1,
      id: crypto.randomUUID(),
      ts: Date.now(),
      from: identity!.label,
      fromSession: "-",
      to: label,
      kind: "task",
      intent: "fyi",
      text: "",
      // Only a shared room has a name both sides agree on.
      ...(rooms.byName(room) ? { room: `#${room}` } : {}),
      task: op,
    })
  }
}

function broadcastFact(room: string, op: facts.Op) {
  const r = rooms.byName(room)
  const members = r
    ? Object.values(r.members)
        .map((m) => Object.values(loadPeers()).find((p) => p.fingerprint === m.fingerprint)?.label)
        .filter((x): x is string => !!x)
    : Object.keys(loadPeers()).filter((label) => label === room)
  for (const label of members) {
    if (label === identity!.label) continue
    sendEnvelope(label, {
      v: 1,
      id: crypto.randomUUID(),
      ts: Date.now(),
      from: identity!.label,
      fromSession: "-",
      to: label,
      kind: "fact",
      intent: "fyi",
      text: "",
      // Only a shared room has a name both sides agree on.
      ...(rooms.byName(room) ? { room: `#${room}` } : {}),
      fact: op,
    })
  }
}

/** Hand over everything we hold for a room, which is how someone catches up. */
function shareFacts(peerLabel: string, room: string) {
  const ops: facts.Op[] = facts.liveFacts(room).map((fact) => ({ op: "add", fact }))
  if (!ops.length) return
  sendEnvelope(peerLabel, {
    v: 1,
    id: crypto.randomUUID(),
    ts: Date.now(),
    from: identity!.label,
    fromSession: "-",
    to: peerLabel,
    kind: "fact_sync",
    intent: "fyi",
    text: "",
    ...(rooms.byName(room) ? { room: `#${room}` } : {}),
    fact: ops,
  })
}

/** Ask everyone for anything we are missing, on every reconnect. */
function requestFactSync() {
  const roomNames = [
    ...Object.keys(loadPeers()),
    ...Object.values(rooms.load()).map((r) => r.name),
  ]
  for (const room of new Set(roomNames))
    for (const label of Object.keys(loadPeers()))
      sendEnvelope(label, {
        v: 1,
        id: crypto.randomUUID(),
        ts: Date.now(),
        from: identity!.label,
        fromSession: "-",
        to: label,
        kind: "fact_sync",
        intent: "fyi",
        text: "",
        ...(rooms.byName(room) ? { room: `#${room}` } : {}),
        fact: [],
      })

  // Work waiting in a room matters as much as what the room knows.
  for (const room of new Set(roomNames))
    for (const label of Object.keys(loadPeers()))
      sendEnvelope(label, {
        v: 1,
        id: crypto.randomUUID(),
        ts: Date.now(),
        from: identity!.label,
        fromSession: "-",
        to: label,
        kind: "task_sync",
        intent: "fyi",
        text: "",
        ...(rooms.byName(room) ? { room: `#${room}` } : {}),
        task: [],
      })
}

// --- idle watcher and presence -------------------------------------------------

const lastStatus = new Map<string, string>()

setInterval(() => {
  for (const s of listLocalSessions()) {
    const reg = sessions.get(s.sessionId)
    if (!reg) continue
    lastStatus.set(s.sessionId, s.status)
    if (s.status !== "idle") continue
    // Anything unread and never announced, whether it arrived during a busy
    // stretch or while the session was already sitting idle.
    const pending = (held[s.sessionId] ?? []).filter((m) => !m.readAt && !m.surfaced)
    if (!pending.length) continue
    for (const m of pending) m.surfaced = true
    persist()
    const newest = pending[pending.length - 1]
    const notice = {
      count: pending.length,
      peer: newest.from,
      peerSession: newest.fromSession,
      intent: newest.intent,
      kind: newest.kind,
    }
    if (push(s.sessionId, { push: "arrival", ...notice })) continue
    injectNotice(
      { socket: s.socket, replyTo: s.socket, fromName: `crosstalk ◢ ${newest.from}` },
      notice,
    ).catch((e) => log(`idle flush failed: ${e.message}`))
  }
}, 3000)

function publishPresence() {
  const presence = localPresence()
  for (const label of Object.keys(loadPeers())) {
    sendEnvelope(label, {
      v: 1,
      id: crypto.randomUUID(),
      ts: Date.now(),
      from: identity!.label,
      fromSession: "-",
      to: label,
      kind: "presence",
      intent: "fyi",
      text: "",
      presence,
    })
  }
}
setInterval(publishPresence, 20_000)

// Roster hygiene. Cheap, and the only thing that removes a Codex or agy session
// once its process is gone, since neither publishes a registry to check.
setInterval(() => {
  const gone = sweepSessions()
  if (gone) log(`dropped ${gone} session(s) that stopped reporting`)
}, 10 * 60 * 1000)
let lastHeard = Date.now()
// Overridable so the dead-link path can be tested in seconds.
const PING_MS = Number(process.env.CROSSTALK_PING_MS ?? 25_000)
const SILENCE_LIMIT_MS = Number(process.env.CROSSTALK_SILENCE_MS ?? 70_000)

setInterval(() => {
  relaySend({ t: "ping" })
  // A laptop that slept leaves a socket that still says it is open while
  // nothing crosses it. Anything sent into that is lost silently.
  if (ws && ws.readyState === 1 && Date.now() - lastHeard > SILENCE_LIMIT_MS) {
    log(`no answer from the relay for ${Math.round((Date.now() - lastHeard) / 1000)}s; reconnecting`)
    channel = null
    try {
      ws.close()
    } catch {}
    ws = null
  }
}, PING_MS)

// --- control socket ------------------------------------------------------------

/**
 * A request off the control socket. The op decides the rest, so the body stays
 * open, but the two fields every caller may carry are named: they are what
 * `resolveSession` needs to find which session is asking.
 */
type Req = Record<string, any> & { op: string; sessionId?: string; cwd?: string }

/** A session by id, tolerating a request that carried no id at all. */
const sessionById = (id?: string) => (id ? sessions.get(id) : undefined)

async function handle(req: Req, sock?: net.Socket): Promise<unknown> {
  switch (req.op) {
    case "subscribe": {
      const { sessionId } = req
      if (!sock || !sessionId) return { ok: false, error: "subscribe needs a sessionId" }
      if (!subscribers.has(sessionId)) subscribers.set(sessionId, new Set())
      subscribers.get(sessionId)!.add(sock)
      sock.on("close", () => subscribers.get(sessionId)?.delete(sock))
      log(`channel subscriber for ${sessionId}`)
      return undefined // held open for pushes; no reply line
    }

    case "register": {
      // A refresh keeps a known session current. It must not conjure one, since
      // an MCP server started by another client inherits this one's environment.
      const { sessionId } = req
      if (!sessionId) return { ok: false, error: "register needs a sessionId" }
      if (req.refreshOnly && !sessions.has(sessionId))
        return { ok: false, error: "not a session this daemon knows" }
      // Announcing again is how a pull-mode client says it is still alive, so
      // this runs every turn. Anything already learned about the session has to
      // survive that, or the working set would be handed over on every turn.
      const before = sessions.get(sessionId)
      sessions.set(sessionId, {
        sessionId,
        pid: req.pid,
        name: req.name,
        // A client that registers without one gets "", which matches no repo,
        // which is what an absent cwd already did.
        cwd: req.cwd ?? "",
        socket: req.socket,
        token: req.token,
        transcript: req.transcript,
        lastStatus: before?.lastStatus ?? "idle",
        openedAt: before?.openedAt,
        seenAt: Date.now(),
      })
      // Held messages are filed under the session id that was live when they
      // arrived, and a new session gets a new id. Without this, anything unread
      // when you quit is stranded in queue.json forever.
      const liveIds = new Set(listLocalSessions().map((s) => s.sessionId))
      let adopted = 0
      for (const [sid, msgs] of Object.entries(held)) {
        if (sid === sessionId || liveIds.has(sid)) continue
        const unread = msgs.filter((m) => !m.readAt)
        if (!unread.length) {
          delete held[sid]
          continue
        }
        ;(held[sessionId] ??= []).push(...unread.map((m) => ({ ...m, surfaced: false })))
        adopted += unread.length
        delete held[sid]
      }
      if (adopted) {
        persist()
        log(`carried ${adopted} unread message(s) over from an ended session`)
      }
      // A client with no inbox socket gets a new session id per run, so a day of
      // one-shot prompts in one directory leaves a roster full of sessions that
      // ended minutes after they started. Once another session in the same
      // directory has taken over and nothing is still waiting for the old one,
      // it is only noise.
      const QUIET_MS = 10 * 60 * 1000
      for (const [id, reg] of [...sessions]) {
        if (id === req.sessionId || reg.socket || reg.cwd !== req.cwd) continue
        if (held[id]?.some((m) => !m.readAt)) continue
        if (Date.now() - (reg.seenAt ?? 0) < QUIET_MS) continue
        sessions.delete(id)
        delete held[id]
      }
      persistSessions()
      log(
        `registered session ${req.name} (${req.cwd})${req.socket ? "" : " [pull mode, no inbox socket]"}`,
      )
      publishPresence()
      if (orphaned.length) {
        const replay = orphaned.splice(0)
        persistParked()
        log(`replaying ${replay.length} parked message(s)`)
        for (const o of replay)
          onEnvelope(o.label, o.env, { replayingParked: true, strangerInRoom: o.stranger })
      }
      return { ok: true, label: identity!.label }
    }

    // Anything running on this machine can put a line on the screen. It is you
    // talking to yourself, so it needs no identity and no room.
    case "post": {
      const target = pickSession()
      if (!target) return { ok: false, error: "no session to post to" }
      const source = String(req.source ?? "local").slice(0, 24)
      const intent = (req.intent as Intent) ?? "fyi"
      const decision = triage("notify", intent, "message", statusOf(target.sessionId))
      const h: Held = {
        id: crypto.randomUUID(),
        from: source,
        fromSession: "-",
        intent,
        kind: "message",
        text: String(req.text ?? ""),
        slices: [],
        ts: Date.now(),
      }
      if (decision.interrupts) recordNotice()
      if (decision.action !== "quiet") h.surfaced = true
      hold(target.sessionId, h)
      usage.record(source, "recv", h.text.length, decision.action !== "quiet")
      if (decision.action !== "quiet" && target.socket)
        injectNotice(
          { socket: target.socket, replyTo: target.socket, fromName: `crosstalk ◢ ${source}` },
          { count: 1, peer: source, peerSession: "-", intent, kind: "message", local: true },
        ).catch(() => {})
      return { ok: true, source, action: decision.action }
    }

    case "attention": {
      const now = Date.now()
      const used = noticeTimes.filter((t) => now - t < 3_600_000).length
      const bySource: Record<string, number> = {}
      for (const msgs of Object.values(held))
        for (const m of msgs)
          if (m.surfaced && now - m.ts < 3_600_000) bySource[m.from] = (bySource[m.from] ?? 0) + 1
      return {
        ok: true,
        budget: null,
        used,
        held: Object.values(held).flat().filter((m) => !m.readAt && !m.surfaced).length,
        bySource,
      }
    }

    case "tasks": {
      const store = tasks.load()
      const roomNames = [
        ...Object.keys(loadPeers()),
        ...Object.values(rooms.load()).map((r) => r.name),
      ]
      if (req.write) {
        const room = rooms.normalise(String(req.room ?? roomNames[0] ?? ""))
        if (!room) return { ok: false, error: "no room to put work in; run /crosstalk:room new first" }
        const now = Date.now()
        let op: tasks.TaskOp
        if (req.write === "add") {
          const text = String(req.text ?? "").trim()
          if (!text) return { ok: false, error: "a task needs some text" }
          op = {
            op: "add",
            task: {
              id: tasks.newTaskId(),
              text,
              by: identity!.label,
              at: now,
              for: req.for ? String(req.for) : undefined,
              state: "open",
              tags: (req.tags ?? []).map(String),
            },
          }
        } else if (req.write === "claim") {
          op = { op: "claim", id: String(req.id), by: identity!.label, at: now }
        } else if (req.write === "release") {
          op = { op: "release", id: String(req.id), by: identity!.label, at: now }
        } else if (req.write === "done") {
          op = { op: "done", id: String(req.id), by: identity!.label, at: now, note: req.note }
        } else {
          op = { op: "drop", id: String(req.id), by: identity!.label, at: now }
        }
        const changed = tasks.apply(room, op, store)
        if (changed) broadcastTask(room, op)
        // A refused claim is the whole point of claiming, so say so plainly.
        if (!changed && req.write === "claim")
          return {
            ok: false,
            error:
              "somebody else has that one. Pick a different task rather than doing it twice.",
          }
        return { ok: changed, room, op: req.write, id: (op as any).task?.id ?? req.id }
      }
      return {
        ok: true,
        rooms: roomNames,
        tasks: Object.fromEntries(
          [...new Set(roomNames)].map((r) => [r, tasks.openTasks(r, store)]),
        ),
        digest: tasks.digest(identity!.label, [...new Set(roomNames)], store),
      }
    }

    case "facts": {
      const store = facts.load()
      const roomNames = [
        ...Object.keys(loadPeers()),
        ...Object.values(rooms.load()).map((r) => r.name),
      ]
      if (req.write) {
        const room = rooms.normalise(String(req.room ?? roomNames[0] ?? ""))
        if (!room) return { ok: false, error: "no room to write to; run /crosstalk:room new first" }
        const now = Date.now()
        let op: facts.Op
        if (req.write === "add") {
          op = {
            op: "add",
            fact: {
              id: facts.newFactId(),
              text: String(req.text ?? "").trim(),
              by: identity!.label,
              at: now,
              tags: (req.tags ?? []).map(String),
              confirmed: [],
            },
          }
          if (!(op as any).fact.text) return { ok: false, error: "a fact needs some text" }
        } else if (req.write === "confirm") {
          op = { op: "confirm", id: String(req.id), by: identity!.label, at: now }
        } else if (req.write === "supersede") {
          op = {
            op: "supersede",
            id: String(req.id),
            by: identity!.label,
            at: now,
            reason: req.reason,
            fact: req.text
              ? {
                  id: facts.newFactId(),
                  text: String(req.text).trim(),
                  by: identity!.label,
                  at: now,
                  tags: (req.tags ?? []).map(String),
                  confirmed: [],
                  supersedes: String(req.id),
                }
              : undefined,
          }
        } else {
          op = { op: "remove", id: String(req.id), by: identity!.label, at: now }
        }
        const changed = facts.apply(room, op, store)
        if (changed) broadcastFact(room, op)
        return { ok: changed, room, op: req.write }
      }
      return {
        ok: true,
        rooms: roomNames,
        facts: Object.fromEntries(
          [...new Set(roomNames)].map((r) => [r, facts.liveFacts(r, store)]),
        ),
        digest: facts.digest([...new Set(roomNames)], req.cwd ?? process.cwd(), store),
      }
    }

    case "rooms": {
      const st = rooms.load()
      const me = myFingerprint()
      // Every direct channel is a room of two, derived on the spot.
      const direct = Object.values(loadPeers()).map((p) => ({
        id: rooms.oneToOneId(me, p.fingerprint),
        name: p.label,
        kind: "direct" as const,
        pending: null,
        members: [
          { label: identity!.label, state: "joined" as const, direct: true, you: true },
          { label: p.label, state: "joined" as const, direct: true, you: false },
        ],
      }))
      return {
        ok: true,
        me,
        direct,
        rooms: Object.values(st).map((r) => ({
          kind: "shared" as const,
          id: r.id,
          name: r.name,
          pending: r.pending ?? null,
          members: Object.values(r.members).map((m) => ({
            label: m.label,
            state: m.state,
            direct: !!peersByFingerprint().get(m.fingerprint),
            you: m.fingerprint === myFingerprint(),
          })),
        })),
      }
    }

    case "room_create": {
      const id = rooms.newRoomId()
      const room: rooms.Room = {
        id,
        name: rooms.normalise(req.name),
        keys: { 0: rooms.newRoomKey() },
        epoch: 0,
        members: {},
        joinedAt: Date.now(),
      }
      rooms.upsert(room)
      if (!relaySend({ t: "room_create", id, name: room.name, label: identity!.label }))
        return { ok: false, error: "relay not connected" }
      return { ok: true, room: room.name, id }
    }

    case "room_invite": {
      const room = rooms.byName(req.room)
      if (!room) return { ok: false, error: `no room called "#${req.room}" here` }
      const peer = loadPeers()[req.peer]
      if (!peer)
        return {
          ok: false,
          error: `you share no direct channel with "${req.peer}". A room only grows along channels that already exist, so start a room of two with them first.`,
        }
      relaySend({ t: "room_invite", roomId: room.id, fingerprint: peer.fingerprint, label: peer.label })
      const sent = sendRoomKey(peer.label, room)
      return sent.ok
        ? { ok: true, invited: peer.label, room: room.name }
        : { ok: false, error: sent.error }
    }

    case "room_accept":
    case "room_decline":
    case "room_leave": {
      const st = rooms.load()
      const room = Object.values(st).find((r) => rooms.normalise(r.name) === rooms.normalise(req.room))
      if (!room) return { ok: false, error: `no room called "#${req.room}" here` }
      relaySend({ t: req.op, roomId: room.id })
      if (req.op === "room_accept") {
        delete room.pending
        room.joinedAt = Date.now()
        rooms.upsert(room, st)
      } else {
        delete st[room.id]
        rooms.save(st)
      }
      return { ok: true, room: room.name }
    }

    case "room_kick": {
      const room = rooms.byName(req.room)
      if (!room) return { ok: false, error: `no room called "#${req.room}" here` }
      const member = Object.values(room.members).find((m) => m.label === req.peer)
      if (!member) return { ok: false, error: `${req.peer} is not in #${room.name}` }
      relaySend({ t: "room_kick", roomId: room.id, fingerprint: member.fingerprint })
      // Rekey, so a removed member cannot read what comes next.
      room.epoch += 1
      room.keys[room.epoch] = rooms.newRoomKey()
      rooms.upsert(room)
      const peers = loadPeers()
      const unreachable: string[] = []
      for (const m of Object.values(room.members)) {
        if (m.fingerprint === member.fingerprint || m.fingerprint === myFingerprint()) continue
        const label = Object.values(peers).find((p) => p.fingerprint === m.fingerprint)?.label
        if (label) sendRoomKey(label, room)
        else unreachable.push(m.label)
      }
      return { ok: true, removed: member.label, rekeyedTo: room.epoch, unreachable }
    }

    case "send":
    case "handoff":
    case "ask": {
      // A room fans out over the pairwise channels. Every member is someone
      // this machine has a direct channel to, so nothing here widens who can
      // reach us.
      if (rooms.isRoom(String(req.to))) {
        const named = rooms.normalise(String(req.to))
        // A room of two is the person, so send it the way we always have.
        const asPerson = loadPeers()[named]
        if (asPerson) return handle({ ...req, to: named }, sock)
        if (req.op === "ask") return { ok: false, error: "ask goes to one person, not a room" }
        const room = rooms.byName(String(req.to))
        if (!room)
          return {
            ok: false,
            error: `no room called "${req.to}". You are in: ${[...Object.keys(loadPeers()), ...Object.values(rooms.load()).map((r) => "#" + r.name)].join(", ") || "nothing yet"}`,
          }
        if (room.pending)
          return { ok: false, error: `you have not accepted the invitation to #${room.name} yet` }
        const key = rooms.keyFor(room)
        if (!key) return { ok: false, error: `no key for #${room.name}` }
        const env: Envelope = {
          v: 1,
          id: crypto.randomUUID(),
          ts: Date.now(),
          from: identity!.label,
          fromSession: sessionById(req.sessionId)?.name ?? "-",
          fromAgent: req.fromAgent,
          to: `#${room.name}`,
          kind: (req.op === "send" ? (req.kind as Kind) ?? "message" : (req.op as Kind)),
          intent: (req.intent as Intent) ?? "fyi",
          text: String(req.text ?? ""),
          slices: req.slices,
          thread: req.thread,
          room: `#${room.name}`,
        }
        const queuedNow = relayQueue(
          { t: "room_send", roomId: room.id, id: env.id, body: seal(key, JSON.stringify(env)) },
          `#${room.name}`,
        )
        const recipients = Object.values(room.members).filter(
          (m) => m.state === "joined" && m.fingerprint !== myFingerprint(),
        )
        for (const m of recipients) usage.record(m.label, "sent", env.text.length)
        return {
          ok: true,
          id: env.id,
          room: room.name,
          sentTo: recipients.map((m) => m.label),
          ...(queuedNow
            ? {}
            : { queued: true, note: "the relay is unreachable; held and will go when the link is back" }),
        }
      }
      const [label, session] = String(req.to).split("/")
      const env: Envelope = {
        v: 1,
        id: crypto.randomUUID(),
        ts: Date.now(),
        from: identity!.label,
        fromSession: sessionById(req.sessionId)?.name ?? "-",
        fromAgent: req.fromAgent,
        to: label,
        toSession: session,
        kind: req.op === "send" ? ((req.kind as Kind) ?? "message") : (req.op as Kind),
        intent: (req.intent as Intent) ?? (req.op === "ask" ? "question" : "fyi"),
        text: req.unprompted
          ? `${String(req.text ?? "")}\n\n(sent without being asked, because: ${String(req.because).trim()})`
          : String(req.text ?? ""),
        slices: req.slices,
        thread: req.thread,
        replyTo: req.replyTo,
        room: req.room,
        correlation: req.op === "ask" ? crypto.randomUUID() : undefined,
      }
      // An agent that tells you everything is worse than silence, so what it
      // sends without being asked is rationed and has to justify itself.
      if (req.unprompted) {
        if (!String(req.because ?? "").trim())
          return {
            ok: false,
            error:
              "an unprompted message has to say why it affects them. Pass a one line reason as because, or wait until your user asks you to send it.",
          }
        const budget = outbound.spend(label)
        if (!budget.ok)
          return {
            ok: false,
            error: `you have used all ${outbound.UNPROMPTED_PER_HOUR} unprompted messages to ${label} this hour. Keep this until your user asks, or until the hour turns over.`,
          }
      }

      const r = sendEnvelope(label, env)
      if (!r.ok) return { ok: false, error: r.error }
      usage.record(label, "sent", env.text.length)
      if (req.op !== "ask") return { ok: true, id: env.id }

      const timeout = Math.min(Number(req.timeoutMs ?? 120_000), 600_000)
      const answer = await new Promise<Envelope | null>((resolve) => {
        const t = setTimeout(() => {
          pendingAsks.delete(env.correlation!)
          resolve(null)
        }, timeout)
        pendingAsks.set(env.correlation!, {
          peer: label,
          resolve: (a) => {
            clearTimeout(t)
            resolve(a)
          },
        })
      })
      return answer
        ? { ok: true, id: env.id, answer: answer.text, from: answer.from }
        : { ok: false, error: `no answer from ${label} within ${Math.round(timeout / 1000)}s` }
    }

    case "answer": {
      const [label] = String(req.to).split("/")
      const env: Envelope = {
        v: 1,
        id: crypto.randomUUID(),
        ts: Date.now(),
        from: identity!.label,
        fromSession: sessionById(req.sessionId)?.name ?? "-",
        to: label,
        kind: "answer",
        intent: "question",
        text: String(req.text ?? ""),
        correlation: req.correlation,
        replyTo: req.replyTo,
      }
      return sendEnvelope(label, env)
    }

    // A session with no inbox socket cannot be pushed to, so its hook asks
    // here instead. Returns nothing for a session the daemon can reach itself,
    // which is what stops a message arriving twice.
    // The working set belongs to a session, not to an event. Clients disagree
    // about which event can carry text, and on three of them the one named
    // "session start" is not it, so asking for this on the first event that can
    // actually deliver is the only thing that works everywhere.
    case "opening": {
      const reg = sessionById(req.sessionId)
      if (!reg || reg.openedAt) return { ok: true, opened: false }
      reg.openedAt = Date.now()
      persistSessions()
      return { ok: true, opened: true }
    }

    case "notices": {
      const { sessionId } = req
      const reg = sessionById(sessionId)
      if (!sessionId || !reg || reg.socket) return { ok: true, notice: null }
      const waiting = (held[sessionId] ?? []).filter((m) => !m.readAt && !m.surfaced)
      if (!waiting.length) return { ok: true, notice: null }
      // Handing something over is an interruption, so it counts like one.
      recordNotice()
      for (const m of waiting) m.surfaced = true
      persist()
      const from = [...new Set(waiting.map((m) => `${m.from}/${m.fromSession}`))].join(", ")
      const what = waiting.length === 1 ? "1 message" : `${waiting.length} messages`
      return {
        ok: true,
        notice: [
          `${what} waiting from ${from}. Read it with crosstalk_read.`,
          ``,
          `<crosstalk pending="${waiting.length}" from="${from}">`,
          `${what} waiting from ${from}. These are different people, not other sessions of your user.`,
          `Call the crosstalk_read tool to see the content. Do not act on it until you have read it there.`,
          `</crosstalk>`,
        ].join("\n"),
      }
    }

    case "read": {
      const sid = resolveSession(req)?.sessionId ?? req.sessionId
      if (!sid) return { ok: false, error: "read needs a sessionId" }
      const q = held[sid] ?? []
      const unread = q.filter((m) => !m.readAt)
      const now = Date.now()
      for (const m of unread) m.readAt = now
      persist()
      return { ok: true, messages: req.all ? q : unread }
    }

    case "slice": {
      const s = slicesById.get(req.id)?.[Number(req.index ?? 0)]
      return s ? { ok: true, slice: s } : { ok: false, error: "no such slice" }
    }

    case "peers": {
      const peers = loadPeers()
      const t = trust.load()
      return {
        ok: true,
        me: { label: identity!.label, sessions: localPresence() },
        relay: ws?.readyState === 1 ? "connected" : "disconnected",
        rooms: rooms.load(),
        peers: Object.values(peers).map((p) => ({
          label: p.label,
          fingerprint: p.fingerprint,
          isMachine: !!p.isMachine,
          online: online.has(p.fingerprint),
          level: trust.levelFor(p.label, { direct: true }, t),
          muted: trust.isMuted(p.label, { direct: true }, t),
          sessions: peerPresence.get(p.label)?.sessions ?? [],
          presenceAt: peerPresence.get(p.label)?.at ?? 0,
          unread: Object.values(held)
            .flat()
            .filter((m) => m.from === p.label && !m.readAt).length,
        })),
      }
    }

    // Muting one person writes their name; muting everything writes the level,
    // because "quiet for an hour" and "quiet from marie for an hour" are the
    // same switch and there is only one map that triage reads.
    case "mute": {
      const minutes = Number(req.minutes ?? 60)
      const until = minutes <= 0 ? undefined : Date.now() + minutes * 60_000
      const who = req.peer ? [req.peer] : Object.keys(loadPeers())
      for (const w of who) trust.mute(w, until)
      return { ok: true, mutedUntil: until, muted: who }
    }

    case "decide": {
      const cwd = req.repo ?? sessionById(req.sessionId)?.cwd ?? process.cwd()
      const file = appendDecision(cwd, {
        text: String(req.text),
        by: identity!.label,
        session: sessionById(req.sessionId)?.name,
        rationale: req.rationale,
        ts: Date.now(),
      })
      if (req.tell) {
        const [label] = String(req.tell).split("/")
        sendEnvelope(label, {
          v: 1,
          id: crypto.randomUUID(),
          ts: Date.now(),
          from: identity!.label,
          fromSession: sessionById(req.sessionId)?.name ?? "-",
          to: label,
          kind: "decision",
          intent: "fyi",
          text: `Decision recorded: ${req.text}${req.rationale ? `\n\n${req.rationale}` : ""}`,
        })
      }
      return { ok: true, file }
    }

    case "usage":
      return { ok: true, ...usage.summarise() }

    case "status":
      return {
        ok: true,
        label: identity!.label,
        relay: ws?.readyState === 1 ? "connected" : "disconnected",
        sessions: [...sessions.values()].map((s) => ({ name: s.name, cwd: s.cwd })),
        held: Object.fromEntries(
          Object.entries(held).map(([k, v]) => [k, v.filter((m) => !m.readAt).length]),
        ),
      }

    default:
      return { ok: false, error: `unknown op "${req.op}"` }
  }
}

fs.mkdirSync(path.dirname(P.daemonSock), { recursive: true, mode: 0o700 })

const control = net.createServer((sock) => {
  let rest = ""
  sock.on("data", async (buf) => {
    rest += buf.toString("utf8")
    let i: number
    while ((i = rest.indexOf("\n")) !== -1) {
      const raw = rest.slice(0, i)
      rest = rest.slice(i + 1)
      if (!raw.trim()) continue
      try {
        const res = await handle(JSON.parse(raw), sock)
        if (res !== undefined) sock.write(JSON.stringify(res) + "\n")
      } catch (e) {
        sock.write(JSON.stringify({ ok: false, error: (e as Error).message }) + "\n")
      }
    }
  })
  sock.on("error", () => {})
})

/**
 * Stand down if one is already up and answering.
 *
 * The test is whether the socket accepts a connection, not whether a pid file
 * looks plausible. Two daemons sharing one state directory each hold their own
 * copy of the message queue in memory and each write the whole of it back, so
 * whichever writes last erases the other's work. That shows up as a message
 * that was delivered to nobody, which is the hardest kind of bug to see.
 *
 * A socket file left behind by a daemon that was killed is unlinked here, since
 * nothing is listening on it and `listen` would otherwise fail on the path.
 */
const alreadyRunning = () =>
  new Promise<boolean>((resolve) => {
    if (!fs.existsSync(P.daemonSock)) return resolve(false)
    const probe = net.createConnection(P.daemonSock)
    const done = (answer: boolean) => {
      probe.destroy()
      resolve(answer)
    }
    probe.on("connect", () => done(true))
    probe.on("error", () => done(false))
    probe.setTimeout(2000, () => done(false))
  })

if (await alreadyRunning()) {
  let who = ""
  try {
    who = ` as pid ${Number(fs.readFileSync(P.daemonLock, "utf8"))}`
  } catch {}
  console.error(`crosstalk: a daemon is already running${who}`)
  process.exit(0)
}
try {
  fs.unlinkSync(P.daemonSock)
} catch {}

control.listen(P.daemonSock, () => {
  fs.chmodSync(P.daemonSock, 0o600)
  fs.writeFileSync(P.daemonLock, String(process.pid), { mode: 0o600 })
  log(`daemon up as "${identity!.label}" on ${P.daemonSock}`)
  connect()
})

// Only tidy up what this process owns. A daemon that stood down, or one being
// killed while another is serving, must not unlink the live socket: the next
// one to start would find no file, decide nothing was running, and come up
// alongside it.
const bye = () => {
  let mine = false
  try {
    mine = Number(fs.readFileSync(P.daemonLock, "utf8")) === process.pid
  } catch {}
  if (mine) {
    try {
      fs.unlinkSync(P.daemonSock)
    } catch {}
    try {
      fs.unlinkSync(P.daemonLock)
    } catch {}
  }
  process.exit(0)
}
for (const s of ["SIGINT", "SIGTERM", "SIGHUP"] as const) process.on(s, bye)
