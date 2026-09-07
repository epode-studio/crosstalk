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
  type Held,
} from "./config.ts"
import { pairKey, seal, open as unseal, sign } from "./crypto.ts"
import { listLocalSessions, findSession, type LocalSession } from "./registry.ts"
import { injectNotice, injectMessage } from "./inject.ts"
import { triage } from "./policy.ts"
import { appendDecision } from "./decisions.ts"
import * as usage from "./usage.ts"
import type { Envelope, Frame, Intent, Kind, SessionPresence, Slice } from "./protocol.ts"

const identity = loadIdentity()
if (!identity) {
  console.error("crosstalk: no identity. Run /crosstalk:pair first.")
  process.exit(1)
}

const log = (...a: unknown[]) => {
  const line = `${new Date().toISOString()} ${a.map(String).join(" ")}\n`
  process.stdout.write(line)
  try {
    fs.appendFileSync(P.log, line)
  } catch {}
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

const sessions = new Map<string, Registered>()

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
const orphaned: { label: string; env: Envelope }[] = loadParked() as {
  label: string
  env: Envelope
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
let backoff = 1000
const pendingAsks = new Map<string, (answer: Envelope) => void>()

function connect() {
  const { url } = loadRelay()
  const target = url.endsWith("/ws") ? url : url.replace(/\/$/, "") + "/ws"
  log(`relay connecting ${target}`)
  const sock = new WebSocket(target)
  ws = sock

  sock.onmessage = (ev) => {
    let f: Frame
    try {
      f = JSON.parse(String(ev.data))
    } catch {
      return
    }
    if (f.t === "challenge") {
      sock.send(
        JSON.stringify({
          t: "auth",
          pub: identity!.ed.pub,
          sig: sign(identity!, f.nonce),
          label: identity!.label,
        }),
      )
      return
    }
    if (f.t === "ready") {
      backoff = 1000
      log(`relay ready as ${f.fingerprint}`)
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
    if (f.t === "error") log(`relay error: ${f.message}`)
  }

  sock.onclose = () => {
    ws = null
    backoff = Math.min(backoff * 2, 30_000)
    setTimeout(connect, backoff)
  }
  sock.onerror = () => {}
}

function sendEnvelope(peerLabel: string, env: Envelope): { ok: boolean; error?: string } {
  const peer = loadPeers()[peerLabel]
  if (!peer) return { ok: false, error: `not paired with "${peerLabel}"` }
  if (!ws || ws.readyState !== 1) return { ok: false, error: "relay not connected" }
  ws.send(
    JSON.stringify({
      t: "send",
      to: peer.fingerprint,
      id: env.id,
      body: seal(pairKey(identity!, peer), JSON.stringify(env)),
    }),
  )
  return { ok: true }
}

// --- inbound ------------------------------------------------------------------

function onEnvelope(peerLabel: string, env: Envelope) {
  if (env.kind === "presence") {
    peerPresence.set(peerLabel, { sessions: env.presence ?? [], at: Date.now() })
    return
  }

  if (env.kind === "answer" && env.correlation) {
    const waiter = pendingAsks.get(env.correlation)
    if (waiter) {
      pendingAsks.delete(env.correlation)
      waiter(env)
      return
    }
  }

  const pol = policyFor(peerLabel)
  if (env.kind === "ask" && !pol.allowAsk) {
    log(`refused ask from ${peerLabel}: allowAsk is off`)
    return
  }

  const target = pickSession(env.toSession)
  if (!target) {
    orphaned.push({ label: peerLabel, env })
    persistParked()
    return log(`no local session registered yet; parked message from ${peerLabel}`)
  }

  const decision = triage(pol, env.intent, env.kind, statusOf(target.sessionId))
  const h: Held = {
    id: env.id,
    from: peerLabel,
    fromSession: env.fromSession,
    intent: env.intent,
    kind: env.kind,
    text: env.text,
    slices: (env.slices ?? []).map((s) => ({ kind: s.kind, label: s.label, bytes: s.bytes })),
    thread: env.thread,
    replyTo: env.replyTo,
    correlation: env.correlation,
    ts: env.ts,
  }
  hold(target.sessionId, h, env.slices)
  log(`inbound ${env.kind}/${env.intent} from ${peerLabel} → ${target.name}: ${decision.action} (${decision.why})`)

  const opts = {
    socket: target.socket,
    replyTo: target.socket,
    fromName: `crosstalk:${peerLabel}/${env.fromSession}`,
    token: target.token,
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
      { socket: s.socket, replyTo: s.socket, fromName: `crosstalk:${newest.from}`, token: reg.token },
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
setInterval(() => ws?.readyState === 1 && ws.send(JSON.stringify({ t: "ping" })), 25_000)

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
      log(`registered session ${req.name} (${req.cwd})`)
      publishPresence()
      if (orphaned.length) {
        const replay = orphaned.splice(0)
        persistParked()
        log(`replaying ${replay.length} parked message(s)`)
        for (const o of replay) onEnvelope(o.label, o.env)
      }
      return { ok: true, label: identity!.label }
    }

    case "send":
    case "handoff":
    case "ask": {
      const [label, session] = String(req.to).split("/")
      const env: Envelope = {
        v: 1,
        id: crypto.randomUUID(),
        ts: Date.now(),
        from: identity!.label,
        fromSession: sessions.get(req.sessionId)?.name ?? "-",
        to: label,
        toSession: session,
        kind: req.op === "send" ? ((req.kind as Kind) ?? "message") : (req.op as Kind),
        intent: (req.intent as Intent) ?? (req.op === "ask" ? "question" : "fyi"),
        text: String(req.text ?? ""),
        slices: req.slices,
        thread: req.thread,
        replyTo: req.replyTo,
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
        pendingAsks.set(env.correlation!, (a) => {
          clearTimeout(t)
          resolve(a)
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
