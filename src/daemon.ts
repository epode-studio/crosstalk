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
  loadPolicy,
  savePolicy,
  policyFor,
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
import { pairKey, seal, open as unseal, fingerprint as fingerprintOf } from "./crypto.ts"
import { Channel, derive, newEphemeral, signWith, transcript, verifyWith } from "./link.ts"
import { listLocalSessions, findSession, type LocalSession } from "./registry.ts"
import { injectNotice, injectMessage } from "./inject.ts"
import { triage } from "./policy.ts"
import { appendDecision } from "./decisions.ts"
import * as usage from "./usage.ts"
import * as rooms from "./rooms.ts"
import type { Envelope, Frame, Intent, Kind, SessionPresence, Slice } from "./protocol.ts"

const identity = loadIdentity()
if (!identity) {
  console.error("crosstalk: no identity. Run /crosstalk:pair first.")
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
}

// Restored from disk, then filtered to whatever is actually still alive, so a
// daemon restart does not orphan a session that is mid-conversation.
const sessions = new Map<string, Registered>(
  Object.entries(loadRegistered()).filter(([id]) =>
    listLocalSessions().some((s) => s.sessionId === id),
  ) as [string, Registered][],
)
const persistSessions = () => saveRegistered(Object.fromEntries(sessions))

const localPresence = (): SessionPresence[] =>
  listLocalSessions()
    .filter((s) => sessions.has(s.sessionId))
    .map((s) => ({ name: s.name, cwd: s.cwd, status: s.status, lastSeen: s.updatedAt }))

function pickSession(preferName?: string): Registered | undefined {
  if (preferName) {
    const byName = [...sessions.values()].find((s) => s.name === preferName)
    if (byName) return byName
  }
  const live = listLocalSessions()
  const known = live.filter((l) => sessions.has(l.sessionId))
  const idle = known.find((l) => l.status === "idle")
  const chosen = idle ?? known[0]
  return chosen ? sessions.get(chosen.sessionId) : undefined
}

const statusOf = (sessionId: string) =>
  listLocalSessions().find((s) => s.sessionId === sessionId)?.status ?? "unknown"

// --- held messages ------------------------------------------------------------

const held: Record<string, Held[]> = loadQueue()

// Sessions whose MCP server is subscribed for channel push. When one is, a
// notice goes out as a <channel> event instead of being injected into the
// transcript. Either way it is only a notice, never the peer's own words.
const subscribers = new Map<string, Set<net.Socket>>()

// Per-sender limits do not bound the total. With several peers, each polite on
// its own, a session can still be interrupted constantly.
const noticeTimes: number[] = []
const NOTICE_BUDGET_PER_HOUR = 40
function withinNoticeBudget(): boolean {
  const now = Date.now()
  while (noticeTimes.length && now - noticeTimes[0] > 3_600_000) noticeTimes.shift()
  if (noticeTimes.length >= NOTICE_BUDGET_PER_HOUR) return false
  noticeTimes.push(now)
  return true
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
let backoff = 1000
const pendingAsks = new Map<string, { peer: string; resolve: (answer: Envelope) => void }>()

function connect() {
  const { url } = loadRelay()
  const target = url.endsWith("/ws") ? url : url.replace(/\/$/, "") + "/ws"
  log(`relay connecting ${target}`)
  const sock = new WebSocket(target)
  ws = sock

  let eph: ReturnType<typeof newEphemeral> | null = null
  let pendingTranscript: Buffer | null = null

  sock.onmessage = (ev) => {
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
        // sealed pairing offer instead.
        log("no pinned relay identity; continuing unpinned")
      }
      backoff = 1000
      lastHeard = Date.now()
      log(`relay ready as ${f.fingerprint}`)
      flushOutbox()
      publishPresence()
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
        const env: Envelope = JSON.parse(unseal(pairKey(identity!, peer), f.body))
        onEnvelope(peer.label, env)
      } catch (e) {
        log(`failed to open body from ${peer.label}: ${(e as Error).message}`)
      }
    }
    if (f.t === "room") return onRoster((f as any).room)
    if (f.t === "rooms") return (f as any).rooms.forEach(onRoster)
    if (f.t === "room_gone") {
      const st = rooms.load()
      delete st[(f as any).roomId]
      rooms.save(st)
      return
    }
    if (f.t === "room_deliver") return onRoomBody(f as any)
    if (f.t === "error") log(`relay error: ${f.message}`)
  }

  sock.onclose = () => {
    ws = null
    channel = null
    backoff = Math.min(backoff * 2, 30_000)
    setTimeout(connect, backoff)
  }
  sock.onerror = () => {}
}

function sendEnvelope(peerLabel: string, env: Envelope): { ok: boolean; error?: string } {
  const peer = loadPeers()[peerLabel]
  if (!peer) return { ok: false, error: `not paired with "${peerLabel}"` }
  const frame = {
    t: "send",
    to: peer.fingerprint,
    id: env.id,
    body: seal(pairKey(identity!, peer), JSON.stringify(env)),
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
    { socket: target.socket, replyTo: target.socket, fromName: `crosstalk:invite` },
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
  const paired = peersByFingerprint().get(f.from)
  onEnvelope(paired?.label ?? sender?.label ?? "someone", env, {
    room,
    strangerInRoom: !paired,
  })
}

// --- inbound ------------------------------------------------------------------

// Replay defence. The pair key authenticates who wrote an envelope but says
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

  let pol = policyFor(peerLabel)
  if (ctx?.strangerInRoom) {
    // Someone in the room this machine has never paired with. They can put a
    // notice on the screen and nothing else.
    pol = { ...pol, delivery: pol.delivery === "quiet" ? "quiet" : "notify", allowAsk: false }
  }
  if (env.kind === "ask" && !pol.allowAsk) {
    log(`refused ask from ${peerLabel}: allowAsk is off`)
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
          ? "Refused: we share a room but have never paired, and questions from someone unpaired are not accepted. Send a message instead."
          : "Refused: questions are switched off for you here. An inbound question starts a turn and spends tokens on this machine, so it stays off until they run /crosstalk:policy <name> --allow-ask. Send a message instead.",
      })
    return
  }

  const target = pickSession(env.toSession)
  if (!target) {
    orphaned.push({ label: peerLabel, env, stranger: !!ctx?.strangerInRoom })
    persistParked()
    return log(`no local session registered yet; parked message from ${peerLabel}`)
  }

  const decision = { ...triage(pol, env.intent, env.kind, statusOf(target.sessionId)) }
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

  const opts = {
    socket: target.socket,
    replyTo: target.socket,
    fromName: `crosstalk:${peerLabel}/${env.fromSession}`,
    // Deliberately no token. Presenting the session's own messaging token would
    // make this a verified own-child message, which skips the approval hold
    // Claude Code applies to unverified peers. A different person's text must
    // stay subject to that hold.
  }

  // Over budget, everything degrades to quiet and waits for an idle moment.
  if (decision.action !== "quiet" && !withinNoticeBudget()) {
    log(`notice budget spent (${NOTICE_BUDGET_PER_HOUR}/h); holding ${env.id} until idle`)
    decision.action = "quiet"
  }
  if (decision.action !== "quiet") h.surfaced = true
  persist()
  usage.record(peerLabel, "recv", env.text.length, decision.action !== "quiet")

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

  // Whoever rekeys can only hand the key to people they are paired with, so
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
  if (!ws || ws.readyState !== 1 || !channel) return false
  try {
    ws.send(channel.seal(o))
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
      { socket: s.socket, replyTo: s.socket, fromName: `crosstalk:${newest.from}` },
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

type Req = Record<string, any> & { op: string }

async function handle(req: Req, sock?: net.Socket): Promise<unknown> {
  switch (req.op) {
    case "subscribe": {
      if (!sock || !req.sessionId) return { ok: false, error: "subscribe needs a sessionId" }
      if (!subscribers.has(req.sessionId)) subscribers.set(req.sessionId, new Set())
      subscribers.get(req.sessionId)!.add(sock)
      sock.on("close", () => subscribers.get(req.sessionId)?.delete(sock))
      log(`channel subscriber for ${req.sessionId}`)
      return undefined // held open for pushes; no reply line
    }

    case "register": {
      sessions.set(req.sessionId, {
        sessionId: req.sessionId,
        pid: req.pid,
        name: req.name,
        cwd: req.cwd,
        socket: req.socket,
        token: req.token,
        transcript: req.transcript,
        lastStatus: "idle",
      })
      // Held messages are filed under the session id that was live when they
      // arrived, and a new session gets a new id. Without this, anything unread
      // when you quit is stranded in queue.json forever.
      const liveIds = new Set(listLocalSessions().map((s) => s.sessionId))
      let adopted = 0
      for (const [sid, msgs] of Object.entries(held)) {
        if (sid === req.sessionId || liveIds.has(sid)) continue
        const unread = msgs.filter((m) => !m.readAt)
        if (!unread.length) {
          delete held[sid]
          continue
        }
        ;(held[req.sessionId] ??= []).push(...unread.map((m) => ({ ...m, surfaced: false })))
        adopted += unread.length
        delete held[sid]
      }
      if (adopted) {
        persist()
        log(`carried ${adopted} unread message(s) over from an ended session`)
      }
      persistSessions()
      log(`registered session ${req.name} (${req.cwd})`)
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

    case "rooms": {
      const st = rooms.load()
      const me = myFingerprint()
      // Every person you paired with is a room of two, derived on the spot.
      const direct = Object.values(loadPeers()).map((p) => ({
        id: rooms.oneToOneId(me, p.fingerprint),
        name: p.label,
        kind: "direct" as const,
        pending: null,
        members: [
          { label: identity!.label, state: "joined" as const, paired: true, you: true },
          { label: p.label, state: "joined" as const, paired: true, you: false },
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
            paired: !!peersByFingerprint().get(m.fingerprint),
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
      if (!relaySend({ t: "room_create", id, name: room.name })) return { ok: false, error: "relay not connected" }
      return { ok: true, room: room.name, id }
    }

    case "room_invite": {
      const room = rooms.byName(req.room)
      if (!room) return { ok: false, error: `no room called "#${req.room}" here` }
      const peer = loadPeers()[req.peer]
      if (!peer)
        return {
          ok: false,
          error: `you are not paired with "${req.peer}". A room only grows along pairings that already exist, so pair with them first.`,
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
      // this machine paired with directly, so nothing here widens who can
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
          fromSession: sessions.get(req.sessionId)?.name ?? "-",
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
        fromSession: sessions.get(req.sessionId)?.name ?? "-",
        fromAgent: req.fromAgent,
        to: label,
        toSession: session,
        kind: req.op === "send" ? ((req.kind as Kind) ?? "message") : (req.op as Kind),
        intent: (req.intent as Intent) ?? (req.op === "ask" ? "question" : "fyi"),
        text: String(req.text ?? ""),
        slices: req.slices,
        thread: req.thread,
        replyTo: req.replyTo,
        room: req.room,
        correlation: req.op === "ask" ? crypto.randomUUID() : undefined,
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
        fromSession: sessions.get(req.sessionId)?.name ?? "-",
        to: label,
        kind: "answer",
        intent: "question",
        text: String(req.text ?? ""),
        correlation: req.correlation,
        replyTo: req.replyTo,
      }
      return sendEnvelope(label, env)
    }

    case "read": {
      const q = held[req.sessionId] ?? []
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
      const policy = loadPolicy()
      return {
        ok: true,
        me: { label: identity!.label, sessions: localPresence() },
        relay: ws?.readyState === 1 ? "connected" : "disconnected",
        rooms: rooms.load(),
        peers: Object.values(peers).map((p) => ({
          label: p.label,
          fingerprint: p.fingerprint,
          online: online.has(p.fingerprint),
          policy: policyFor(p.label, policy),
          sessions: peerPresence.get(p.label)?.sessions ?? [],
          presenceAt: peerPresence.get(p.label)?.at ?? 0,
          unread: Object.values(held)
            .flat()
            .filter((m) => m.from === p.label && !m.readAt).length,
        })),
      }
    }

    case "policy": {

      const policy = loadPolicy()
      if (req.peer) {
        policy.peers[req.peer] = { ...policyFor(req.peer, policy), ...(req.set ?? {}) }
      } else if (req.set) {
        policy.default = { ...policy.default, ...req.set }
      }
      if (req.peer || req.set) savePolicy(policy)
      return { ok: true, policy }
    }

    case "mute": {
      const policy = loadPolicy()
      const minutes = Number(req.minutes ?? 60)
      const until = minutes <= 0 ? undefined : Date.now() + minutes * 60_000
      if (req.peer) policy.peers[req.peer] = { ...policyFor(req.peer, policy), mutedUntil: until }
      else policy.default = { ...policy.default, mutedUntil: until }
      savePolicy(policy)
      return { ok: true, mutedUntil: until }
    }

    case "decide": {
      const cwd = req.repo ?? sessions.get(req.sessionId)?.cwd ?? process.cwd()
      const file = appendDecision(cwd, {
        text: String(req.text),
        by: identity!.label,
        session: sessions.get(req.sessionId)?.name,
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
          fromSession: sessions.get(req.sessionId)?.name ?? "-",
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

try {
  fs.unlinkSync(P.daemonSock)
} catch {}
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

// Stand down if one is already up and answering, rather than double-delivering.
try {
  const running = Number(fs.readFileSync(P.daemonLock, "utf8"))
  if (running && running !== process.pid && fs.existsSync(P.daemonSock)) {
    process.kill(running, 0)
    console.error(`crosstalk: a daemon is already running as pid ${running}`)
    process.exit(0)
  }
} catch {}

control.listen(P.daemonSock, () => {
  fs.chmodSync(P.daemonSock, 0o600)
  fs.writeFileSync(P.daemonLock, String(process.pid), { mode: 0o600 })
  log(`daemon up as "${identity!.label}" on ${P.daemonSock}`)
  connect()
})

const bye = () => {
  try {
    fs.unlinkSync(P.daemonSock)
  } catch {}
  try {
    fs.unlinkSync(P.daemonLock)
  } catch {}
  process.exit(0)
}
for (const s of ["SIGINT", "SIGTERM", "SIGHUP"] as const) process.on(s, bye)
