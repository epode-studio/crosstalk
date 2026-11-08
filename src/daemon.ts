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
  loadRoutes,
  saveRoutes,
  loadUnrouted,
  saveUnrouted,
  type Unrouted,
} from "./config.ts"
import { channelKey, seal, open as unseal, fingerprint as fingerprintOf } from "./crypto.ts"
import { Channel, derive, newEphemeral, signWith, transcript, verifyWith } from "./link.ts"
import { listLocalSessions, findSession, type LocalSession } from "./registry.ts"
import { attr, injectNotice, injectMessage, injectRouteQuestion, routeQuestionText, handedMessage } from "./inject.ts"
import * as footprint from "./footprint.ts"
import * as ui from "./uistate.ts"
import { triage } from "./policy.ts"
import * as trust from "./trust.ts"
import * as outbound from "./outbound.ts"
import { appendDecision } from "./decisions.ts"
import * as usage from "./usage.ts"
import * as rooms from "./rooms.ts"
import * as facts from "./facts.ts"
import * as tasks from "./tasks.ts"
import * as notesApi from "./notes.ts"
import * as repotrust from "./repotrust/index.ts"
import { consent as connectConsent } from "./repotrust/firstuse.ts"
import type { Envelope, Frame, Intent, Kind, SessionPresence, Slice } from "./protocol.ts"
import { cleanEnvelope } from "./protocol.ts"
import { ThreadService } from "./threads/service.ts"
import * as threadModel from "./threads/model.ts"
import { createShipping } from "./shipping/daemon.ts"
import { createExtras } from "./extras.ts"
import { rootFrom } from "./paths.ts"
import { pluginVersion } from "./client.ts"
import { Coordinator, RULES_FILE } from "./coordinator.ts"
import { isBot } from "./ui-extra/bots.ts"
import { threadMuted } from "./ui-extra/mute.ts"
import { createAttention } from "./attention/daemon.ts"
import type { AttentionService } from "./attention/service.ts"
import { spawnedAt } from "./spawn.ts"
import { createSessionOps } from "./sessions/daemon.ts"
// Registers crosstalk services with the session manager (setServices), for close here.
import "./services/service.ts"
import * as ciMod from "./urls/ci.ts"
import { createUrls } from "./urls/daemon.ts"
import { createShares } from "./share/daemon.ts"
import { createStreamGate } from "./streamgate.ts"
import { createHealth } from "./urls/health/index.ts"
import { startHistory } from "./urls/history/sync.ts"
import * as tabStatus from "./terminal/status.ts"
import * as boardMod from "./ui-extra/board.ts"

const identity = loadIdentity()
if (!identity) {
  console.error("crosstalk: no identity. Run /crosstalk:join first.")
  process.exit(1)
}

// Waiting on the ui store's lock blocks this event loop, so the daemon waits
// briefly and answers "busy" rather than stall every session (src/uistate.ts).
ui.setLockWait(Number(process.env.CROSSTALK_DAEMON_UI_LOCK_WAIT_MS ?? 250))

const log = (...a: unknown[]) => {
  // Whatever starts the daemon points stdout at daemon.log, so writing there
  // as well duplicated every line.
  process.stdout.write(`${new Date().toISOString()} ${a.map(String).join(" ")}\n`)
}

// The shared ui store fails with StoreBusy rather than writing without its lock
// (src/uistate.ts). Requests turn that into an answer; a timer has nobody to
// answer, so it is logged and skipped here instead of ending the daemon. Every
// other error still ends the process as before.
const busyOnly = (e: unknown) => {
  if (e instanceof ui.StoreBusy) {
    log(`skipped a timed step: ${(e as Error).message}`)
    return
  }
  throw e
}
process.on("uncaughtException", busyOnly)
process.on("unhandledRejection", busyOnly)

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
  /** Repo, branch and files this session is working on, for routing by subject. */
  footprint?: footprint.SessionFootprint
  /** When crosstalk's mod in this session last asked what to show. Not persisted: a new daemon waits to hear again. */
  modSeenAt?: number
  /** The title crosstalk gave the session (`auth · api`), so the registry's copy of it is not taken for its name. */
  title?: string
}

/**
 * How long a session counts as drawing its own UI after the mod last polled.
 * The mod polls every second; while it does, nothing is injected into that
 * session, and the moment it stops, the classic notices take over again.
 */
const MOD_FRESH_MS = Number(process.env.CROSSTALK_MOD_FRESH_MS ?? 15_000)
const modLive = (s: Registered | undefined) => !!s?.modSeenAt && Date.now() - s.modSeenAt < MOD_FRESH_MS

/**
 * How long a session with no inbox socket stays on the roster after its last
 * sign of life. Codex and agy publish no registry to check against, and agy
 * gives every `agy -p` run a new conversation id, so without this the roster
 * fills up with sessions that ended hours ago. Anything still unread when one
 * is dropped is carried over to the next session in the same directory.
 */
const PULL_SESSION_TTL_MS = 6 * 60 * 60 * 1000

/**
 * How long after its last announcement a pull-mode session keeps its unread
 * messages from being carried over to another session that registers. Matches
 * the quiet period after which one is dropped from a directory's roster.
 */
const PULL_LIVE_MS = Number(process.env.CROSSTALK_PULL_LIVE_MS ?? 10 * 60 * 1000)

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

// --- threads ----------------------------------------------------------------------
// Found from each session's footprint, synced to their people over the relay,
// committed to refs/crosstalk/threads on change. All of it in src/threads/.

// The main session, standing rules and agents warning each other
// (src/coordinator.ts), made once everything it calls back into exists.
let coord: Coordinator
// Recaps, disposable sessions, staffing, focus and notifications (src/attention/).
let attention: AttentionService | undefined
/** Rename, move, and your sessions on your other machines (src/sessions/). */
let sessionOps: ReturnType<typeof createSessionOps> | undefined
let shares: ReturnType<typeof createShares> | undefined

const threads = new ThreadService({
  tiebreak: (sid, cands, mode) => attention?.tiebreak(sid, cands, mode),
  extra: { file: RULES_FILE, read: (repo, text) => coord?.readRules(repo, text), render: (repo) => coord?.renderRules(repo) },
  onFlush: (ids) => {
    coord?.onThreadsFlush(ids)
    attention?.onThreadsFlush(ids)
  },
  identity,
  peers: () => loadPeers(),
  send: (label, env) => sendEnvelope(label, env),
  log,
  file: path.join(P.root, "threads.json"),
  settleMs: Number(process.env.CROSSTALK_THREAD_SETTLE_MS ?? 3000),
  network: process.env.CROSSTALK_THREADS_NO_PUSH !== "1",
  fadeDays: Number(process.env.CROSSTALK_THREAD_FADE_DAYS ?? 14),
  // Nothing about a repo's threads leaves this machine before "Connect with
  // your team" got a yes there, or someone else is in one of them.
  connected: (repo) => {
    const slug = repo.startsWith("github.com/") ? repo.slice("github.com/".length) : `local/${path.basename(repo)}`
    return connectConsent(slug) === "yes"
  },
})

// --- shipping ---------------------------------------------------------------------
// Review, evidence, merge, flags and incidents, on the threads' features. All of
// it in src/shipping/. A heads-up for an agent is a held local message, read
// with crosstalk_say action "read" like anything else that arrives.

const shipping = createShipping({
  threads,
  root: rootFrom(import.meta.url),
  log,
  wake: (sid, text) => void Promise.resolve(handle({ op: "post", to: sid, source: "crosstalk ship", intent: "question", text })).catch(() => {}),
  fallbackSession: () => mostRecentSession()?.sessionId,
})

/** Tell the threads where a session is and what it touched. Never lets a thread problem stop a registration. */
function observeThreads(reg: Registered) {
  try {
    // An agent started from a thread is in it from the start (src/spawn.ts):
    // its spawn record names the thread, its worktree is where it runs.
    const sp = reg.cwd ? spawnedAt(reg.cwd) : null
    if (sp?.threadId) threads.expect({ cwd: sp.worktree, thread: sp.threadId, why: sp.byName ? `started from ${sp.byName}` : "started in it" })
  } catch (e) {
    log(`threads: ${(e as Error).message}`)
  }
  try {
    const fp = footprintOf(reg)
    threads.observe({
      sessionId: reg.sessionId,
      name: reg.name,
      cwd: reg.cwd,
      repo: fp.repo,
      branch: fp.branch,
      root: fp.root,
      paths: footprint.summarise(fp)?.paths ?? [],
    })
  } catch (e) {
    log(`threads: ${(e as Error).message}`)
  }
}

/** A thread's name for a card, from the ids a message carried. */
const threadNames = (ids?: string[]) =>
  ids?.length ? [...new Set(ids.map((id) => threads.thread(id)?.meta.value.name).filter((n): n is string => !!n))].join(", ") || undefined : undefined

/** Drop pull-mode sessions that have gone quiet. Returns how many went. */
function sweepSessions(): number {
  let gone = 0
  for (const [id, reg] of [...sessions]) {
    if (stillAround(id, reg)) continue
    sessions.delete(id)
    threads.forget(id)
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
      // The registry shows the title crosstalk gave it; peers know it by its name.
      name: known?.name && known.name !== reg.title ? known.name : reg.name,
      cwd: known?.cwd ?? reg.cwd,
      status: known?.status ?? "unknown",
      lastSeen: known?.updatedAt ?? Date.now(),
      // For a peer's threads to find this session. Sealed pairwise, and only
      // ever sent to people with a direct channel, like the cwd above.
      ...(reg.footprint?.repo ? { footprint: footprint.summarise(reg.footprint) } : {}),
      threads: threads.idsFor(reg.sessionId),
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

// --- routing by subject ---------------------------------------------------------

/** What the user answered when a message matched no session. */
const routes = loadRoutes()
/** edit_shared answers, per session and file: whether another thread shares it. */
const editShared = new Map<string, { shared: boolean; at: number }>()
const EDIT_SHARED_TTL_MS = Number(process.env.CROSSTALK_EDIT_SHARED_TTL_MS ?? 5000)

/** Messages held until the user says which session they belong to. */
const unrouted: Unrouted[] = loadUnrouted()
const persistUnrouted = () => saveUnrouted(unrouted)

/** A session's footprint with repo and branch read fresh enough to trust. */
function footprintOf(reg: Registered): footprint.SessionFootprint {
  const fp = footprint.refreshGit(reg.footprint ?? { paths: {} }, reg.cwd)
  reg.footprint = fp
  return fp
}

/** The session your user touched last, which is where a question is put. */
function mostRecentSession(): Registered | undefined {
  const live = new Map(listLocalSessions().map((s) => [s.sessionId, s.updatedAt]))
  return [...sessions.values()].sort(
    (a, b) => (live.get(b.sessionId) ?? b.seenAt ?? 0) - (live.get(a.sessionId) ?? a.seenAt ?? 0),
  )[0]
}

const byNameOrId = (b: { sessionId: string; name: string }) =>
  sessions.get(b.sessionId) ?? [...sessions.values()].find((s) => s.name === b.name)

type Route =
  | { target: Registered | undefined; how: string }
  | { ask: "none" | "tie"; tied: Registered[]; fp: footprint.Summary }

/**
 * Which local session an inbound message is for.
 *
 * A session the sender named wins. Otherwise the message's footprint is matched
 * against each session's: no shared repo, no match; the branch and shared files
 * add to it. A remembered answer for this sender, repo and branch stands in for
 * matching. When nothing matches or two sessions match equally, the message is
 * held and the user is asked, because a wrong guess is the bug this replaces.
 *
 * A peer that sends no footprint, which is every peer older than this and any
 * session outside a git repo, is routed the old way, and so is a machine where
 * no session is in a repo, since there is nothing to match against.
 */
function routeInbound(peerLabel: string, env: Envelope): Route {
  if (env.toSession) {
    const named = [...sessions.values()].find((s) => s.name === env.toSession)
    if (named) return { target: named, how: "named" }
  }
  const fp = footprint.parseSummary(env.footprint)
  // Talking is per thread: a session in the sender's thread gets it, and among
  // several of them the footprint picks.
  if (Array.isArray(env.threads) && env.threads.length) {
    const inThread = threads
      .sessionsIn(env.threads.filter((t): t is string => typeof t === "string").slice(0, 20))
      .map((id) => sessions.get(id))
      .filter((s): s is Registered => !!s)
    if (inThread.length === 1) return { target: inThread[0], how: "thread" }
    if (inThread.length > 1) {
      const c = fp ? footprint.choose(inThread.map((s) => ({ item: s, fp: footprintOf(s) })), fp) : undefined
      const recent = new Map(listLocalSessions().map((s) => [s.sessionId, s.updatedAt]))
      const newest = [...inThread].sort((a, b) => (recent.get(b.sessionId) ?? b.seenAt ?? 0) - (recent.get(a.sessionId) ?? a.seenAt ?? 0))[0]
      return { target: c?.pick ?? newest, how: "thread" }
    }
  }
  if (!fp || !sessions.size) return { target: pickSession(), how: "no footprint" }
  const bound = routes[footprint.bindingKey(peerLabel, fp)]
  const boundTo = bound && byNameOrId(bound)
  if (boundTo) return { target: boundTo, how: "remembered" }
  const candidates = [...sessions.values()].map((s) => ({ item: s, fp: footprintOf(s) }))
  if (!candidates.some((c) => c.fp.repo)) return { target: pickSession(), how: "no local repo" }
  const c = footprint.choose(candidates, fp)
  if (c.pick) return { target: c.pick, how: `footprint ${c.score}` }
  return { ask: c.why, tied: c.tied, fp }
}

/** Hold a message nobody matched, and ask the most recent session where it goes. */
function holdUnrouted(
  peerLabel: string,
  env: Envelope,
  ctx: { room?: rooms.Room; strangerInRoom?: boolean } | undefined,
  r: { ask: "none" | "tie"; tied: Registered[]; fp: footprint.Summary },
): void {
  // A standing rule says where this sender's messages about this repo go.
  const ruled = coord.autoRoute(peerLabel, r.fp.repo)
  if (ruled && sessions.get(ruled))
    return void onEnvelope(peerLabel, { ...env, toSession: sessions.get(ruled)!.name }, { ...ctx, replayingParked: true })
  seenIds.set(env.id, Date.now())
  if (unrouted.some((u) => u.id === env.id)) return
  // With a main session open, that is where the question goes (src/main.ts).
  const asked = sessions.get(coord.mainId() ?? "") ?? sessions.get(attention?.focusedId() ?? "") ?? mostRecentSession()
  const u: Unrouted = {
    id: env.id,
    label: peerLabel,
    env,
    stranger: !!ctx?.strangerInRoom,
    roomId: ctx?.room?.id,
    at: Date.now(),
    why: r.ask,
    askedSession: asked?.sessionId,
  }
  unrouted.push(u)
  log(
    `held ${env.kind} from ${peerLabel} about ${r.fp.repo}@${r.fp.branch ?? "?"}: ${r.ask === "tie" ? `tie between ${r.tied.map((t) => t.name).join(", ")}` : "no matching session"}; asking ${asked?.name ?? "nobody"}`,
  )
  if (modLive(asked)) {
    // The mod asks with a picker of sessions; nothing goes into the transcript.
    log(`route question for ${asked!.name} left to its mod`)
  } else if (asked?.socket) {
    u.surfaced = true
    recordNotice()
    injectRouteQuestion(
      { socket: asked.socket, replyTo: asked.socket, fromName: `crosstalk ◢ where does this go?` },
      routeQuestionFor(u),
    ).catch((e) => log(`inject failed: ${e.message}`))
  }
  persistUnrouted()
}

function routeQuestionFor(u: Unrouted) {
  const env = u.env as Envelope
  const fp = footprint.parseSummary(env.footprint)
  return {
    id: u.id,
    peer: u.label,
    peerSession: env.fromSession,
    repo: fp?.repo,
    branch: fp?.branch,
    why: u.why,
    sessions: [...sessions.values()].map((s) => s.name),
  }
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
/** When a session's agent was last given a peer's words (handed over, crosstalk_say action "read", delivered): steering from it waits. */
const peerTextAt = new Map<string, number>()
const persist = () => saveQueue(held)

function hold(sessionId: string, h: Held, slices?: Slice[]) {
  ;(held[sessionId] ??= []).push(h)
  if (slices?.length) slicesById.set(h.id, slices)
  persist()
}

// --- what the mod shows ---------------------------------------------------------

const msgId = (m: Held) => `msg:${m.id}`
const routeId = (u: Unrouted) => `route:${u.id}`

function findHeld(itemId: string): Held | undefined {
  for (const msgs of Object.values(held)) for (const m of msgs) if (msgId(m) === itemId) return m
}

/** Handed over, muted or replied to: out of the queue for good. */
const settledHeld = (m: Held) => {
  m.readAt ??= Date.now()
  m.surfaced = true
}

function markHeld(itemId: string, fn: (m: Held) => void) {
  const m = findHeld(itemId)
  if (!m) return
  fn(m)
  persist()
}

/** The sessions a route question offers, best first: those tied, then the most recently used. Three fit beside "Hold it". */
function routeCandidates(u: Unrouted): Registered[] {
  const live = new Map(listLocalSessions().map((s) => [s.sessionId, s.updatedAt]))
  const all = [...sessions.values()].sort(
    (a, b) => (live.get(b.sessionId) ?? b.seenAt ?? 0) - (live.get(a.sessionId) ?? a.seenAt ?? 0),
  )
  const env = u.env as Envelope
  const fp = footprint.parseSummary(env.footprint)
  const c = u.why === "tie" && fp ? footprint.choose(all.map((s) => ({ item: s, fp: footprintOf(s) })), fp) : undefined
  const tied = c && !c.pick ? c.tied : []
  const out: Registered[] = []
  for (const s of [...tied, ...all]) if (!out.some((o) => o.name === s.name)) out.push(s)
  return out.slice(0, 3)
}

/**
 * Bring the store up to date with what is held for one session, and return
 * what is still waiting on the person there. Nothing settled ever comes back:
 * an item keeps its state however often this runs.
 */
function uiSync(sid: string): ui.UiItem[] {
  // Everything that runs git or reads other state is worked out first, outside
  // the store's lock, which every hook and the mod wait on.
  // "Which thread is this session part of?", when its files match two equally,
  // unless a standing rule answers it.
  coord.autoThread(sid)
  const tq = threads.question(sid)
  const waiting = new Set(unrouted.map(routeId))
  const asks = unrouted
    .filter((u) => u.askedSession === sid || !sessions.has(u.askedSession ?? ""))
    .map((u) => ({ u, q: routeQuestionFor(u), cands: routeCandidates(u) }))
  return ui.withStore((items, now) => {
    for (const m of held[sid] ?? []) {
      // Read by the agent with crosstalk_say action "read": the card has done its job.
      if (m.readAt) {
        ui.settle(items, msgId(m), "handed", now)
        continue
      }
      ui.upsert(
        items,
        {
          id: msgId(m),
          kind: m.kind === "ask" && m.correlation ? "ask" : "message",
          sessionId: sid,
          from: m.from,
          thread: threadNames(m.threads) ?? m.thread ?? m.room ?? (m.fromSession !== "-" ? m.fromSession : undefined),
          text: m.text,
          chips: m.slices.map((s) => ({ kind: s.kind, label: s.label, bytes: s.bytes })),
          ts: m.ts,
          ...(m.auto ? { auto: true } : {}),
        },
        now,
      )
    }
    if (tq) ui.upsert(items, { id: tq.id, kind: "thread", sessionId: sid, question: tq.question, options: tq.options, ts: now }, now)
    for (const it of Object.values(items))
      if (it.kind === "thread" && it.sessionId === sid && it.id !== tq?.id) ui.settle(items, it.id, "answered", now)
    for (const { u, q, cands } of asks) {
      const where = [q.repo, q.branch].filter(Boolean).join(" @ ") || "an unknown repo"
      // Every label ever offered keeps naming its session: a picker raised a
      // while ago answers with the label it showed.
      const targets = { ...items[routeId(u)]?.targets, ...Object.fromEntries(cands.map((s) => [s.name, s.sessionId])) }
      ui.upsert(
        items,
        {
          id: routeId(u),
          kind: "route",
          sessionId: sid,
          from: u.label,
          thread: q.repo,
          question: `A message from ${q.peer}/${q.peerSession} about ${where} ${q.why === "tie" ? "matches more than one session" : "matches none of your sessions"}. Which session should get it?`,
          options: [...cands.map((s) => s.name), "Hold it"],
          names: q.sessions,
          targets,
          ts: u.at,
        },
        now,
      )
    }
    for (const it of Object.values(items))
      if (it.kind === "route" && it.sessionId === sid && !waiting.has(it.id)) ui.settle(items, it.id, "answered", now)
    repotrust.syncUi(items, sid, now)
    // A main session sees everything cross-cutting; a working one only its own (src/main.ts).
    return coord.itemsFor(items, sid)
  })
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
/**
 * Whether the relay carries live `stream` frames (relay/relay.ts, and the hosted
 * Worker since its stream allowance), which sharing a server uses; and when the
 * hosted relay has paused them for the day (src/streamgate.ts).
 */
const streamGate = createStreamGate({
  note: (id, text) => coord.note({ id, text }),
  tell: (label, text) =>
    sendEnvelope(label, { v: 1, id: crypto.randomUUID(), ts: Date.now(), from: identity!.label, fromSession: "-", to: label, kind: "message", intent: "fyi", text }),
  log,
})
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
  streamGate.connected({ hosted: workerMode })

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
    // The hosted relay's `ready` only says what it carries: TLS authenticated it,
    // and sock.onopen already did the rest.
    if (f.t === "ready" && workerMode) {
      streamGate.ready(f as any)
      log(`relay carries ${(f as any).streams ? "live stream frames" : "no stream frames"} (hosted)`)
      return
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
        // sealed join offer instead.
        log("no pinned relay identity; continuing unpinned")
      }
      backoff = 1000
      lastHeard = Date.now()
      streamGate.ready(f as any)
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
    if (f.t === "error" && !streamGate.onError(f as any, identity!.label)) log(`relay error: ${f.message}`)
  }

  sock.onopen = () => {
    if (!workerMode) return
    backoff = 1000
    lastHeard = Date.now()
    log(`relay ready as ${myFingerprint()} (hosted)`)
    flushOutbox()
    publishPresence()
    // The self-hosted path did this on its ready frame and this one did not, so
    // on the relay everybody actually uses, a machine that was off while a fact
    // or a task was written never caught up.
    requestFactSync()
  }

  sock.onclose = () => {
    ws = null
    channel = null
    backoff = Math.min(backoff * 2, 30_000)
    setTimeout(connect, backoff)
  }
  sock.onerror = () => {}
}

const FAN_OUT = new Set<Kind>(["message", "handoff", "ask", "answer", "decision"])

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
  // A person trusted through a repository has one identity per machine; a
  // message for them goes to each, so it reaches whichever one they are at.
  if (FAN_OUT.has(env.kind))
    for (const sib of repotrust.siblings(peerLabel)) {
      const p = loadPeers()[sib]
      if (p) relayQueue({ t: "send", to: p.fingerprint, id: `${env.id}.${p.fingerprint}`, body: seal(channelKey(identity!, p), JSON.stringify(env)) }, sib)
    }
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
      kind: `room invitation (with ${others.join(", ") || "nobody else yet"}); accept by telling your agent to accept ${room.name}`,
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
): void {
  // Names the sender chose (session, thread, room) are cut to a short plain
  // charset before anything reads them: they end up in notices, tags and cards.
  cleanEnvelope(env)
  // A shared server's offers and HTTP frames (src/share/): replay rules of their own, direct channels only.
  if (shares?.accept(peerLabel, env, !!ctx?.room)) return
  // A parked envelope is re-run through here once a session registers, so the
  // duplicate check has to skip that path and only record an id once the
  // message is actually held.
  if (!ctx?.replayingParked && seenIds.has(env.id))
    return log(`dropped replay of ${env.id} from ${peerLabel}`)
  // A held or parked message passed this check when it first arrived; it may
  // sit for days before someone routes it, and that is not a replay.
  const age = Date.now() - (env.ts ?? 0)
  if (!ctx?.replayingParked && (age > REPLAY_WINDOW_MS || age < -MAX_SKEW_MS)) {
    return log(`dropped stale or future-dated ${env.kind} from ${peerLabel} (${Math.round(age / 1000)}s)`)
  }

  if (env.kind === "presence") {
    peerPresence.set(peerLabel, { sessions: env.presence ?? [], at: Date.now() })
    if (!ctx?.room)
      try {
        threads.peerPresence(peerLabel, env.presence)
      } catch (e) {
        log(`threads: ${(e as Error).message}`)
      }
    return
  }

  // Thread state comes only over a direct channel, never through a room.
  if (env.kind === "thread") {
    if (ctx?.room) return log(`ignored a thread sent through #${ctx.room.name}`)
    // The same level and mutes as anything else they send. A thread frame is
    // a whole replica, so one dropped while muted loses nothing: the next one
    // after the mute carries everything.
    const tc: trust.Context = { direct: true, machine: !!loadPeers()[peerLabel]?.isMachine }
    if (trust.levelFor(peerLabel, tc) === "mute" || trust.isMuted(peerLabel, tc))
      return log(`ignored a thread from ${peerLabel}: they are muted`)
    try {
      threads.accept(peerLabel, env)
    } catch (e) {
      log(`threads: ${(e as Error).message}`)
    }
    return
  }

  // An agent never answers a question (src/ui-extra/bots.ts).
  if (env.kind === "answer" && isBot(peerLabel)) return log(`dropped an answer from ${peerLabel}: an agent cannot answer questions`)
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

  // Your sessions across your own machines (src/sessions/remote.ts): own machines only.
  if (sessionOps?.accept(peerLabel, env, !!ctx?.room)) return

  // Heads-ups, conflicts and standing rules (src/coordinator.ts): direct channels only.
  if (coord.accept(peerLabel, env, !!ctx?.room)) return

  if (env.kind === "fact" || env.kind === "fact_sync") return acceptFacts(peerLabel, env)
  if (env.kind === "task" || env.kind === "task_sync") return acceptTasks(peerLabel, env)

  const tctx: trust.Context = {
    room: ctx?.room?.name ?? (env.room ? env.room.replace(/^#/, "") : undefined),
    direct: !ctx?.strangerInRoom,
    machine: !!loadPeers()[peerLabel]?.isMachine,
  }
  const level = trust.levelFor(peerLabel, tctx)
  const muted = trust.isMuted(peerLabel, tctx) || threadMuted(env)
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
          : `Refused: you are at "${level}" here, and a question needs "ask". They can raise it by telling their agent to let you ask them questions. Send a message instead.`,
      })
    return
  }
  // Answered by a standing rule (src/rules/): nobody is asked.
  if (coord.autoAsk(peerLabel, env)) {
    seenIds.set(env.id, Date.now())
    return log(`answered ${peerLabel}'s ask by a standing rule`)
  }

  const route = routeInbound(peerLabel, env)
  if ("ask" in route) return holdUnrouted(peerLabel, env, ctx, route)
  // With a main session open, a question from another thread goes there.
  const target = sessions.get(coord.redirect({ how: route.how, kind: env.kind, intent: env.intent, target: route.target?.sessionId }) ?? "") ?? route.target
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
    // About this session's own thread: its mod hands it to the agent, as
    // data, by itself. Only for a thread the sender is in here (what the
    // envelope claims is not enough), from a person at "ask" or above, not
    // muted, over a direct channel. Anything else is an ordinary card.
    ...(() => {
      if (route.how !== "thread") return {}
      const fp = loadPeers()[peerLabel]?.fingerprint
      const ids = threads
        .idsFor(target.sessionId)
        .filter((id) => (env.threads ?? []).some((t) => threads.resolve(t) === id))
        .filter((id) => !!fp && threadModel.people(threads.thread(id)!).includes(fp))
      const auto = ids.length > 0 && !muted && tctx.direct && !tctx.machine && !isBot(peerLabel) && trust.atLeast(level, "ask")
      return auto ? { threads: ids, auto: true } : {}
    })(),
  }
  seenIds.set(env.id, Date.now())
  hold(target.sessionId, h, env.slices)
  log(
    `inbound ${env.kind}/${env.intent} from ${peerLabel} → ${target.name} [${route.how}]: ${decision.action} (${decision.why})`,
  )

  // Account for it before anything can return early, or a client that pulls
  // rather than being pushed to would never show up in the cost at all.
  usage.record(peerLabel, "recv", env.text.length, decision.interrupts)

  // Nothing to push to in pull mode. The hook collects it, and spends the
  // attention budget then rather than now.
  if (!target.socket) {
    log(`held for ${target.name}, which pulls rather than being pushed to`)
    return
  }

  // The session's mod shows it as a card and nothing reaches the model until
  // the person hands it over. Left unsurfaced, so if the mod goes away the
  // idle watcher still announces it the classic way.
  if (modLive(target)) {
    log(`held for ${target.name}, shown as a card by its mod`)
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
    peerTextAt.set(target.sessionId, Date.now())
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

/**
 * Ask everyone for anything we are missing, on every reconnect.
 *
 * This is the only thing that reconciles an absence longer than the relay's
 * day of buffering, so both relay paths have to call it, not just one.
 */
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
    if (s.status !== "idle" || modLive(reg)) continue
    // Anything unread and never announced, whether it arrived during a busy
    // stretch or while the session was already sitting idle. Not counted: what
    // the person already has as a card (a mod that went away left it there).
    const shown = ui.snapshot()
    const pending = (held[s.sessionId] ?? []).filter(
      (m) => !m.readAt && !m.surfaced && !ui.FINAL.has(shown[`msg:${m.id}`]?.state ?? "pending"),
    )
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

/**
 * What the sending session is working on, for the receiver to route by. Absent
 * when the sender is outside a repo or unknown, which routes the old way.
 */
const senderFootprint = (req: Req): footprint.Summary | undefined => {
  const reg = resolveSession(req)
  return reg ? footprint.summarise(footprintOf(reg)) : undefined
}

async function handle(req: Req, sock?: net.Socket): Promise<unknown> {
  switch (req.op) {
    case "subscribe": {
      const { sessionId } = req
      if (!sock || !sessionId) return { ok: false, error: "subscribe needs a sessionId" }
      // Claude Code drops a channel event silently unless the session opted
      // this server in, so a subscription stands for delivery only when the
      // server says channels are on (channels.ts). One from before that check
      // subscribed regardless and is not believed: its session gets the inbox
      // notice instead, which reaches the person either way.
      if (req.channels !== true) {
        log(`ignored a subscriber for ${sessionId} that did not say channels are on`)
        return { ok: true, subscribed: false }
      }
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
        // Claude Code's registry shows the title crosstalk gave the session
        // (`auth · api`); it is still called what it was called.
        name: sessionOps?.name(sessionId, before?.title && req.name === before.title ? before.name : req.name) ?? (before?.title && req.name === before.title ? before.name : req.name),
        title: before?.title,
        // A client that registers without one gets "", which matches no repo,
        // which is what an absent cwd already did.
        cwd: req.cwd ?? "",
        socket: req.socket,
        token: req.token,
        transcript: req.transcript,
        lastStatus: before?.lastStatus ?? "idle",
        openedAt: before?.openedAt,
        modSeenAt: before?.modSeenAt,
        seenAt: Date.now(),
        footprint: (() => {
          // A session that moved directory is working on something else now.
          const kept = before && before.cwd === (req.cwd ?? "") ? before.footprint : undefined
          const fp = footprint.refreshGit(kept ?? { paths: {} }, req.cwd ?? "")
          const touched = Array.isArray(req.touched)
            ? req.touched.filter((p: unknown): p is string => typeof p === "string").slice(0, 50)
            : []
          return footprint.touch(fp, req.cwd ?? "", touched)
        })(),
      })
      // Held messages are filed under the session id that was live when they
      // arrived, and a new session gets a new id. Without this, anything unread
      // when you quit is stranded in queue.json forever.
      const liveIds = new Set(listLocalSessions().map((s) => s.sessionId))
      // A session with no inbox socket (Codex, agy) is in no registry, so it
      // is alive for as long as it keeps announcing itself.
      for (const [id, reg] of sessions)
        if (!reg.socket && Date.now() - (reg.seenAt ?? 0) < PULL_LIVE_MS) liveIds.add(id)
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
        threads.forget(id)
      }
      observeThreads(sessions.get(sessionId)!)
      attention?.registered(sessions.get(sessionId)!)
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
      // Trust through the repository this session is in, in the background.
      repotrust.noteSession(req.cwd ?? "", log)
      // A key-change question goes to the mod's picker when the mod is here,
      // and otherwise once as a systemMessage the hook passes on.
      const teamSay = modLive(sessions.get(sessionId)) || ui.modActive(sessionId) ? undefined : repotrust.takeSystemMessage()
      return { ok: true, label: identity!.label, ...(teamSay ? { systemMessage: teamSay } : {}) }
    }

    // Anything running on this machine can put a line on the screen. It is you
    // talking to yourself, so it needs no identity and no room.
    case "post": {
      // `to` names the session (shipping's heads-ups); otherwise whichever is there.
      const target = (req.to && sessionById(String(req.to))) || pickSession()
      if (!target)
        return {
          ok: false,
          error:
            "no agent session is registered here yet, so there is nothing to interrupt. " +
            "Start one in this project and it will announce itself; the message is not kept.",
        }
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
      // Same split as facts: a session in a thread adds to the thread, and a
      // task id the thread holds is claimed and finished there.
      const self = req.sessionId ? resolveSession(req) : undefined
      const mine = self ? threads.idsFor(self.sessionId) : []
      if (req.write && (req.thread || (mine.length && !req.room))) {
        const inThread =
          req.write === "add" || mine.some((id) => threadModel.noteOf(threads.thread(id), String(req.id), "task")) || req.thread
        if (inThread && (req.write === "add" || req.write === "claim" || req.write === "done")) {
          const owner = req.thread ?? mine.find((id) => threadModel.noteOf(threads.thread(id), String(req.id), "task"))
          const r = threads.task(self?.sessionId, { op: req.write, text: req.text, id: req.id, note: req.note, thread: owner })
          return r.ok ? { ok: true, thread: r.thread, op: req.write, id: r.id } : r
        }
      }
      const store = tasks.load()
      const roomNames = [
        ...Object.keys(loadPeers()),
        ...Object.values(rooms.load()).map((r) => r.name),
      ]
      if (req.write) {
        const room = rooms.normalise(String(req.room ?? roomNames[0] ?? ""))
        if (!room) return { ok: false, error: "no room to put work in; run /crosstalk:join first" }
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

    case "notes": {
      // Notes, one list: this session's threads' (or the one named), then the
      // facts and tasks kept with the people joined with words, in the same shape.
      const self = req.sessionId ? resolveSession(req) : undefined
      const kinds = (Array.isArray(req.kinds) ? req.kinds : req.kind ? [req.kind] : []).filter((k: string) => threadModel.NOTE_KINDS.includes(k as threadModel.NoteKind)) as threadModel.NoteKind[]
      const named = req.thread ? threads.find(self?.sessionId, String(req.thread)) : undefined
      if (req.thread && !named) return { ok: false, error: `no thread called "${req.thread}"` }
      const mine = named ? [named] : (self ? threads.idsFor(self.sessionId) : []).map((id) => threads.thread(id)).filter((t): t is threadModel.Thread => !!t)
      const groupKinds = kinds.filter((k) => k === "fact" || k === "task")
      const groups = req.thread || (kinds.length && !groupKinds.length) ? [] : [...Object.keys(loadPeers()), ...Object.values(rooms.load()).map((r) => r.name)]
      return {
        ok: true,
        threads: mine.map((t) => t.meta.value.name),
        notes: [...mine.flatMap((t) => notesApi.threadNotes(t, kinds)), ...notesApi.groupNotes(groups, { kinds: groupKinds })],
      }
    }

    case "facts": {
      // New facts from a session in a thread go to the thread; the room store
      // keeps working for everything else, and for anything named to a room.
      const self = req.sessionId ? resolveSession(req) : undefined
      const mine = self ? threads.idsFor(self.sessionId) : []
      if (req.write === "add" && (req.thread || (mine.length && !req.room))) {
        const text = String(req.text ?? "").trim()
        if (!text) return { ok: false, error: "a fact needs some text" }
        const r = threads.fact(self?.sessionId, { text, thread: req.thread })
        return r.ok ? { ok: true, thread: r.thread, op: "add", id: r.id } : r
      }
      // A fact in one of this session's threads is confirmed or corrected there.
      if ((req.write === "confirm" || req.write === "supersede") && !req.room && threads.holding(self?.sessionId, String(req.id), "fact", req.thread)) {
        const r =
          req.write === "confirm"
            ? threads.confirmFact(self?.sessionId, { id: String(req.id), thread: req.thread })
            : threads.correctFact(self?.sessionId, { id: String(req.id), text: req.text, reason: req.reason, thread: req.thread })
        return r.ok ? { ok: true, thread: r.thread, op: req.write, id: r.id } : r
      }
      const store = facts.load()
      const roomNames = [
        ...Object.keys(loadPeers()),
        ...Object.values(rooms.load()).map((r) => r.name),
      ]
      if (req.write) {
        const room = rooms.normalise(String(req.room ?? roomNames[0] ?? ""))
        if (!room) return { ok: false, error: "no room to write to; run /crosstalk:join first" }
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
      if (req.op === "ask" && isBot(String(req.to ?? ""))) return { ok: false, error: `${String(req.to).split("/")[0]} is an agent: it can post to threads but cannot answer questions. Send it a message instead.` }
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
          footprint: senderFootprint(req),
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
      // No recipient: the people in this session's threads, and only their
      // sessions in those threads, since the thread ids travel with it.
      if (!String(req.to ?? "").trim()) {
        const self = resolveSession(req)
        const r = self ? threads.recipients(self.sessionId) : { threads: [], labels: [] }
        const names = r.threads.map((id) => threads.thread(id)?.meta.value.name).join(", ")
        if (!r.threads.length)
          return { ok: false, error: "this session is in no thread yet, so there is nobody to send to without a name. Say who it is for." }
        if (!r.labels.length) return { ok: false, error: `nobody else is in ${names} yet. Say who it is for.` }
        if (req.op === "ask" && r.labels.length > 1)
          return { ok: false, error: `ask waits on one person, and ${names} has ${r.labels.join(", ")}. Say whose answer you need.` }
        const sent: string[] = []
        const failed: { to: string; error: string }[] = []
        let last: any
        for (const label of r.labels) {
          last = await handle({ ...req, to: label, threadIds: r.threads }, sock)
          if (last?.ok) sent.push(label)
          else failed.push({ to: label, error: last?.error ?? "not sent" })
        }
        if (!sent.length) return { ok: false, error: failed.map((f) => `${f.to}: ${f.error}`).join("; ") }
        return { ...(req.op === "ask" ? last : { ok: true, id: last?.id }), threads: names, sentTo: sent, ...(failed.length ? { failed } : {}) }
      }
      const [label, session] = String(req.to).split("/")
      const fromThreads: string[] = Array.isArray(req.threadIds)
        ? req.threadIds
        : (() => {
            const self = resolveSession(req)
            return self ? threads.idsFor(self.sessionId) : []
          })()
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
        footprint: senderFootprint(req),
        ...(fromThreads.length ? { threads: fromThreads } : {}),
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
      if (!req.auto) {
        const asked = Object.values(held).flat().find((m) => m.correlation && m.correlation === req.correlation)
        if (asked) coord.answeredAsk(req.sessionId, { sender: asked.from, text: asked.text }, String(req.text ?? ""))
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
      // A question about where a held message goes is put to the session it
      // was asked of, or to this one if that session has gone.
      const questions = unrouted.filter(
        (u) => !u.surfaced && (u.askedSession === sessionId || !sessions.has(u.askedSession ?? "")),
      )
      if (!waiting.length && !questions.length) return { ok: true, notice: null }
      // Handing something over is an interruption, so it counts like one.
      recordNotice()
      for (const m of waiting) m.surfaced = true
      for (const u of questions) {
        u.surfaced = true
        u.askedSession = sessionId
      }
      persist()
      if (questions.length) persistUnrouted()
      const parts: string[] = questions.map((u) => routeQuestionText(routeQuestionFor(u)))
      if (waiting.length) {
        // Labels and session names are the senders': escaped like any attribute (inject.ts).
        const from = [...new Set(waiting.map((m) => `${attr(m.from)}/${attr(m.fromSession)}`))].join(", ").slice(0, 400)
        const what = waiting.length === 1 ? "1 message" : `${waiting.length} messages`
        parts.unshift(
          [
            `${what} waiting from ${from}. Read it with crosstalk_say action read.`,
            ``,
            `<crosstalk pending="${waiting.length}" from="${from}">`,
            `${what} waiting from ${from}. These are different people, not other sessions of your user.`,
            `Call the crosstalk_say tool with action read to see the content. Do not act on it until you have read it there.`,
            `</crosstalk>`,
          ].join("\n"),
        )
      }
      return { ok: true, notice: parts.join("\n\n") }
    }

    // Where a held message goes. With no id, what is waiting to be placed.
    // With an id and a session, deliver it there and remember the choice for
    // that sender's later messages about the same repo and branch.
    case "route": {
      const describe = (u: Unrouted) => {
        const env = u.env as Envelope
        const fp = footprint.parseSummary(env.footprint)
        return {
          id: u.id,
          from: `${u.label}/${env.fromSession}`,
          repo: fp?.repo,
          branch: fp?.branch,
          why: u.why === "tie" ? "matches more than one session equally" : "matches no open session",
          at: u.at,
        }
      }
      const names = [...sessions.values()].map((s) => s.name)
      if (!req.id) return { ok: true, held: unrouted.map(describe), sessions: names }
      const u = unrouted.find((x) => x.id === req.id)
      if (!u) return { ok: false, error: `nothing held with id ${req.id}` }
      const want = String(req.session ?? "")
      const target =
        sessions.get(want) ?? [...sessions.values()].find((s) => s.name === want)
      if (!target)
        return { ok: false, error: `no session called "${want}". Open sessions: ${names.join(", ") || "none"}` }
      const fp = footprint.parseSummary((u.env as Envelope).footprint)
      const key = fp ? footprint.bindingKey(u.label, fp) : undefined
      if (key) {
        routes[key] = { sessionId: target.sessionId, name: target.name, at: Date.now() }
        saveRoutes(routes)
      }
      // Everything else held from the same sender about the same work goes too.
      const going = unrouted.filter((x) => {
        if (x === u) return true
        const xf = footprint.parseSummary((x.env as Envelope).footprint)
        return !!key && !!xf && footprint.bindingKey(x.label, xf) === key
      })
      for (const x of going) unrouted.splice(unrouted.indexOf(x), 1)
      persistUnrouted()
      const st = rooms.load()
      for (const x of going) {
        const env = x.env as Envelope
        // The person picked the session, so it is named: neither the binding
        // nor a main session (src/main.ts) may send it anywhere else. A rule's
        // automatic answer still goes through the binding.
        onEnvelope(x.label, key && req.auto ? env : { ...env, toSession: target.name }, {
          replayingParked: true,
          strangerInRoom: x.stranger,
          room: x.roomId ? st[x.roomId] : undefined,
        })
      }
      log(`routed ${going.length} held message(s) from ${u.label} to ${target.name}`)
      if (!req.auto) coord.answeredRoute(req.sessionId, { sender: u.label, repo: fp?.repo, target: target.sessionId })
      return { ok: true, delivered: going.length, to: target.name, remembered: !!key }
    }

    // Asked by the PostToolUse hook before it works out an edit report: does
    // any other thread share this file? Cached briefly per file.
    case "edit_shared": {
      const self = resolveSession(req)
      const abs = typeof req.path === "string" ? req.path : ""
      if (!self || !abs) return { ok: true, shared: false }
      const fp = footprintOf(self)
      if (!fp.repo) return { ok: true, shared: false }
      const root = fp.root ?? threads.rootFor(fp.repo)
      const file = root ? path.relative(root, abs).split(path.sep).join("/") : ""
      // Somewhere this cannot place: let the report work it out, as before.
      if (!file || file.startsWith("..") || path.isAbsolute(file)) return { ok: true, shared: true }
      const key = `${self.sessionId}|${fp.repo}|${file}`
      const c = editShared.get(key)
      if (c && Date.now() - c.at < EDIT_SHARED_TTL_MS) return { ok: true, shared: c.shared, cached: true }
      let shared = coord.warn.shares(fp.repo, file, self.sessionId)
      if (!shared && threads.idsFor(self.sessionId).length) shared = coord.cross.dependents(fp.repo).length > 0
      if (editShared.size > 2000) editShared.clear()
      editShared.set(key, { shared, at: Date.now() })
      return { ok: true, shared }
    }

    // What crosstalk's mod shows in one session: its held messages as cards,
    // route questions put to it, and the restore offer the hook left. Polled
    // once a second, which is also how the daemon knows the mod is there.
    case "ui": {
      const sid = String(req.sessionId ?? "")
      if (!sid) return { ok: false, error: "ui needs a sessionId" }
      const reg = sessions.get(sid)
      if (reg && req.mod) reg.modSeenAt = Date.now()
      // A sealed line for Claude's own push, which only the mod can send.
      const push = req.mod ? attention?.takePush(sid) : undefined
      return {
        ok: true,
        items: uiSync(sid),
        label: identity!.label,
        threads: threads.namesFor(sid),
        // The mod toasts these; taken here, the hook does not show them again.
        ...(req.mod ? { threadNotes: [...coord.notesFor(sid, threads.takeNotes(sid)), ...(attention?.takeNotes(sid) ?? [])] } : {}),
        ...(coord.mainStatus(sid) ? { main: coord.mainStatus(sid) } : {}),
        ...(push ? { push } : {}),
      }
    }

    // The person acted on something the mod showed. The state is recorded
    // first, under the store's lock, so a second press, a second session or a
    // resumed one finds it settled and does nothing.
    case "ui_act": {
      const sid = String(req.sessionId ?? "")
      const id = String(req.id ?? "")
      const action = String(req.action ?? "") as ui.UiAction
      const value = req.value === undefined ? undefined : String(req.value)
      const before = ui.snapshot()[id]
      if (!before) return { ok: false, error: `nothing waiting with id ${id}` }
      if (before.kind === "restore") return { ok: false, error: "the restore offer is answered by crosstalk ui act, not the daemon" }
      if (before.kind === "attention") return attention ? attention.act(sid, id, action, value) : { ok: false, error: "not ready" }

      if (action === "raised" || action === "later" || action === "mute") {
        const r = ui.withStore((items, now) => ui.act(items, id, action, now))
        // Muted is done with: read, so neither a notice nor a card brings it back.
        if (r.ok && action === "mute" && before.kind !== "route") markHeld(id, settledHeld)
        return r
      }

      if (action === "answer" && value !== undefined) {
        const c = coord.uiAct(sid, before, value)
        if (c) return c
        const x = await extras.uiAct(before, value)
        if (x) return x
        const sh = await shares?.uiAct(before, value)
        if (sh) return sh
      }

      if (before.kind === "team") {
        if (action !== "answer" || !value) return { ok: false, error: "a key question is answered with Trust it or Don't trust it" }
        const r = repotrust.answerQuestion(id, value === repotrust.TRUST)
        return { ...r, item: ui.snapshot()[id] }
      }
      if (before.kind === "ship") {
        if (action !== "answer" || !value) return { ok: false, error: "a shipping question is answered with one of its options" }
        const r = await shipping.uiAnswer(id, value)
        return { ...r, error: r.ok ? undefined : r.text }
      }
      if (before.kind === "thread") {
        if (action !== "answer" || !value) return { ok: false, error: "a thread question is answered with a thread" }
        const claim = ui.withStore((items, now) => ui.act(items, id, "answer", now, value))
        if (!claim.ok) return claim
        const tq = coord.threadQuestionOf(sid)
        const r = threads.answer(sid, value)
        if (!r.ok) ui.withStore((items, now) => ui.reopen(items, id, now))
        else if (tq) coord.answered(tq, value, { sid })
        return { ...r, item: claim.item }
      }

      if (before.kind === "route") {
        if (action !== "answer" || !value) return { ok: false, error: "a route question is answered with a session" }
        const claim = ui.withStore((items, now) => ui.act(items, id, "answer", now, value))
        if (!claim.ok) return claim
        const r: any = await handle({ op: "route", id: id.slice("route:".length), session: before.targets?.[value] ?? value, sessionId: sid })
        if (!r?.ok) ui.withStore((items, now) => ui.reopen(items, id, now))
        return { ...r, item: claim.item }
      }

      const m = findHeld(id)
      if (!m) {
        ui.withStore((items, now) => ui.settle(items, id, "handed", now))
        return { ok: false, error: "that message is no longer held here" }
      }
      // The mod could not append the handed row: the message waits again,
      // rather than sitting handed and read but never delivered.
      if (action === "unhand") {
        if (before.state !== "handed") return { ok: false, error: `not handed: ${before.state}`, item: before }
        ui.withStore((items, now) => ui.reopen(items, id, now))
        markHeld(id, (h) => {
          delete h.readAt
          delete h.handedAt
          delete h.toolReadAt
          h.surfaced = false
        })
        return { ok: true, item: ui.snapshot()[id] }
      }
      if (action === "hand") {
        const claim = ui.withStore((items, now) => ui.act(items, id, "hand", now))
        if (!claim.ok) return claim
        // Passed on by the mod because it is about this session's own thread,
        // never put to the person: framed as that, not as their hand-over.
        const auto = value === "auto" || (!!m.auto && before.raisedAt === undefined)
        markHeld(id, (h) => {
          settledHeld(h)
          h.handedAt = h.toolReadAt = Date.now()
        })
        peerTextAt.set(sid, Date.now())
        return {
          ok: true,
          item: claim.item,
          auto,
          text: handedMessage({ id: m.id, peer: m.from, peerSession: m.fromSession, thread: m.thread, text: m.text, slices: m.slices, auto }),
        }
      }
      if (action === "answer") {
        if (!value?.trim()) return { ok: false, error: "a reply needs text" }
        const claim = ui.withStore((items, now) => ui.act(items, id, "answer", now, value))
        if (!claim.ok) return claim
        const to = m.fromSession && m.fromSession !== "-" ? `${m.from}/${m.fromSession}` : m.from
        const r: any =
          m.kind === "ask" && m.correlation
            ? await handle({ op: "answer", sessionId: sid, to, correlation: m.correlation, text: value, replyTo: m.id })
            : await handle({ op: "send", sessionId: sid, to, text: value, replyTo: m.id, thread: m.thread, intent: "fyi" })
        if (r?.ok) markHeld(id, settledHeld)
        else ui.withStore((items, now) => ui.reopen(items, id, now))
        if (r?.ok && m.kind === "ask") coord.answeredAsk(sid, { sender: m.from, text: m.text }, value)
        return { ...r, item: claim.item, to: m.from }
      }
      return { ok: false, error: `unknown action ${action}` }
    }

    case "read": {
      const sid = resolveSession(req)?.sessionId ?? req.sessionId
      if (!sid) return { ok: false, error: "read needs a sessionId" }
      const now = Date.now()
      // With the mod live, a card is the person's until they hand it over:
      // crosstalk_say action "read" (all or not) returns only what was handed to this
      // agent, and what is about its own thread, never the cards waiting.
      if (modLive(sessions.get(sid))) {
        const q = (held[sid] ?? []).filter((m) => m.handedAt || (m.auto && (!m.readAt || m.toolReadAt)))
        const unread = q.filter((m) => !m.toolReadAt)
        for (const m of unread) {
          m.toolReadAt = now
          m.readAt ??= now
        }
        if (unread.length) peerTextAt.set(sid, now)
        persist()
        return { ok: true, messages: req.all ? q : unread }
      }
      const q = held[sid] ?? []
      const unread = q.filter((m) => !m.readAt)
      for (const m of unread) m.readAt = now
      if (unread.length || (req.all && q.length)) peerTextAt.set(sid, now)
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
      // A session in a thread records it in the thread, which its people get
      // at once and the ref keeps. Anywhere else, DECISIONS.md as before.
      const inThread = resolveSession(req)
      if (req.thread || (inThread && threads.idsFor(inThread.sessionId).length)) {
        const r = threads.decide(inThread?.sessionId, {
          text: String(req.text ?? "").trim(),
          rationale: req.rationale,
          session: inThread?.name,
          thread: req.thread,
        })
        if (!r.ok) return r
        if (req.tell) {
          const [label] = String(req.tell).split("/")
          sendEnvelope(label, {
            v: 1,
            id: crypto.randomUUID(),
            ts: Date.now(),
            from: identity!.label,
            fromSession: inThread?.name ?? "-",
            to: label,
            kind: "decision",
            intent: "fyi",
            text: `Decision recorded in ${r.thread}: ${req.text}${req.rationale ? `\n\n${req.rationale}` : ""}`,
          })
        }
        return { ok: true, thread: r.thread }
      }
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

    // A session's threads: for the hook's banner and title, and the mod's status line.
    case "threads": {
      const self = resolveSession(req)
      if (!self) return { ok: true, threads: [], all: threads.list() }
      // With the mod there, its toasts carry the notices; the hook only takes the banner.
      const take = !!req.consume && !modLive(self) && !req.mod
      const out = threads.forSession(self.sessionId, self.name, !!req.consume, false)
      // Notices and digest lines, with the cross-cutting ones kept for a main session.
      if (take) out.notes = coord.notesFor(self.sessionId, threads.takeNotes(self.sessionId)).map((n) => n.text)
      // The title is offered only when it changes, so a name the person gave
      // the session afterwards is not overwritten on every prompt.
      const retitle = !!req.consume && !!out.title && out.title !== self.title
      if (retitle) {
        self.title = out.title
        persistSessions()
      }
      return { ok: true, ...out, name: self.name, title: retitle ? out.title : undefined, currentTitle: out.title, mod: modLive(self) }
    }

    // crosstalk_thread: place this session, or change one of its threads.
    case "thread": {
      const self = resolveSession(req)
      const sid = self?.sessionId
      // A session placed before it arrives, by id or folder (a new agent's worktree).
      if (req.expect && typeof req.expect === "object")
        return threads.expect({
          sessionId: req.expect.sessionId ? String(req.expect.sessionId) : undefined,
          cwd: req.expect.cwd ? String(req.expect.cwd) : undefined,
          thread: String(req.expect.thread ?? ""),
          why: req.expect.why ? String(req.expect.why) : undefined,
        })
      if (req.pick) {
        if (!sid) return { ok: false, error: "no session to place" }
        const tq = coord.threadQuestionOf(sid)
        const r = threads.answer(sid, String(req.pick))
        if (r.ok && tq) coord.answered(tq, String(req.pick), { sid })
        if (r.ok) ui.withStore((items, now) => {
          for (const it of Object.values(items)) if (it.kind === "thread" && it.sessionId === sid) ui.settle(items, it.id, "answered", now)
        })
        return r
      }
      if (req.leave) return sid ? threads.leave(sid, String(req.leave)) : { ok: false, error: "no session" }
      // Lowering a risk and answering a shipping question are for people: src/shipping.
      const guarded = await shipping.guardThreadEdit(sid, req)
      if (guarded.stop) return guarded.stop
      const edited = threads.edit(sid, {
        thread: req.thread,
        status: req.status,
        public: req.public,
        recap: req.recap,
        feature: req.feature,
        question: req.question,
        answer: req.answer,
        rule: req.rule,
      })
      // A person's answer is remembered; the second identical one offers a standing rule.
      const offer = edited.ok && req.answer?.id ? coord.answeredThreadQuestion(sid, req.thread, String(req.answer.id), String(req.answer.text ?? "")) : null
      return offer ? { ...edited, offer: coord.offerView(offer) } : edited
    }

    // crosstalk_ship action "feature", _ready, _review, _evidence, _flag, _incident and
    // `crosstalk ship|review|incident`: src/shipping/daemon.ts.
    case "ship": {
      const self = resolveSession(req)
      const r = await shipping.op(req, self?.sessionId ?? (req.sessionId ? String(req.sessionId) : undefined))
      return { ...r, ...(r.ok ? {} : { error: r.text }) }
    }

    case "thread_read": {
      const self = resolveSession(req)
      if (req.thread) {
        const t = threads.find(self?.sessionId, String(req.thread))
        return t ? { ok: true, threads: [threadModel.view(t)] } : { ok: false, error: `no thread called "${req.thread}"`, all: threads.list() }
      }
      const mine = self ? threads.idsFor(self.sessionId) : []
      return {
        ok: true,
        threads: mine.map((id) => threadModel.view(threads.thread(id)!)),
        ...(mine.length ? {} : { note: "this session is in no thread yet", all: threads.list() }),
      }
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

    // Who is trusted through the repository, who is waiting on a question, and
    // what changed. `refresh` syncs first instead of waiting for the next one.
    case "team": {
      const cwd = String(req.cwd ?? resolveSession(req)?.cwd ?? "")
      const synced = req.refresh && cwd ? await repotrust.sync(cwd, { force: true, log }) : undefined
      return { ok: true, ...(await repotrust.status(cwd || undefined)), ...(synced ? { synced } : {}) }
    }

    case "team_answer": {
      if (typeof req.trust !== "boolean") return { ok: false, error: "say whether to trust it" }
      return repotrust.answerQuestion(String(req.id ?? ""), req.trust)
    }

    default: {
      // The main session, standing rules, heads-ups and conflicts.
      const r = await coord.handle(req, resolveSession(req))
      if (r !== undefined) return r
      // Disk, team install, stats, leaving a thread.
      const x = await extras.handle(req, resolveSession(req)?.sessionId ?? (req.sessionId ? String(req.sessionId) : undefined))
      if (x !== undefined) return x
      // Recaps, fresh sessions, staffing, focus and permission prompts.
      const a = await attention?.handle(req, resolveSession(req))
      if (a !== undefined) return a
      // Rename, move, and your sessions on your other machines.
      const so = await sessionOps?.handle(req)
      if (so !== undefined) return so
      // A running server shared with a teammate (src/share/).
      const sh = await shares?.handle(req)
      if (sh !== undefined) return sh
      return { ok: false, error: `unknown op "${req.op}"` }
    }
  }
}

coord = new Coordinator({
  identity,
  threads,
  log,
  root: P.root,
  peers: () => loadPeers(),
  send: (label, env) => sendEnvelope(label, env),
  sessions: () => sessions,
  status: statusOf,
  presence: () => peerPresence,
  holdLocal: (sid, h, slices) => {
    hold(sid, h, slices)
    const reg = sessions.get(sid)
    log(`${h.kind} from ${h.from} held for ${reg?.name ?? sid}`)
    if (!reg?.socket || modLive(reg)) return
    h.surfaced = true
    persist()
    const notice = { count: (held[sid] ?? []).filter((m) => !m.readAt).length, peer: h.from, peerSession: h.fromSession, intent: h.intent, kind: h.kind }
    if (!push(sid, { push: "arrival", ...notice }))
      injectNotice({ socket: reg.socket, replyTo: reg.socket, fromName: `crosstalk ◢ ${h.from}` }, notice).catch((e) => log(`inject failed: ${e.message}`))
  },
  waitingIn: (sid) =>
    ui.openFor(ui.snapshot(), sid).filter((i) => i.kind !== "message" && i.kind !== "ask").length + (held[sid] ?? []).filter((m) => !m.readAt).length,
  modLive: (sid) => modLive(sessions.get(sid)),
  repoOf: (sid) => {
    const reg = sessions.get(sid)
    return reg ? footprintOf(reg).repo : undefined
  },
  route: (id, session) => handle({ op: "route", id, session, auto: true }),
  answerPeer: (label, correlation, text, replyTo) => handle({ op: "answer", to: label, correlation, text, replyTo, auto: true }),
  spawned: (sid) => {
    const reg = sessions.get(sid)
    if (attention?.isBackground(sid)) return true
    try {
      return !!(reg?.cwd && spawnedAt(reg.cwd))
    } catch {
      return false
    }
  },
  peerTextAt: (sid) => peerTextAt.get(sid),
})

// Disk, team install, local stats, leaving a thread (src/extras.ts).
const extras = createExtras({
  threads,
  log,
  fallbackSession: () => coord.mainId() ?? mostRecentSession()?.sessionId,
  modLive: (sid) => modLive(sessions.get(sid)),
  digest: (id, text) => coord.note({ id, text }),
})
attention = createAttention({
  threads,
  coord: () => coord,
  root: rootFrom(import.meta.url),
  log,
  sessions: () => sessions,
  status: statusOf,
  modLive: (sid) => modLive(sessions.get(sid)),
  repoOf: (sid) => {
    const reg = sessions.get(sid)
    return reg ? footprintOf(reg).repo : undefined
  },
})
sessionOps = createSessionOps({
  identity,
  machine: () => repotrust.thisMachine(identity!),
  threads,
  sessions: () => sessions,
  peers: () => loadPeers(),
  send: (label, env) => sendEnvelope(label, env),
  log,
  note: (id, text) => coord.note({ id, text }),
  listLocal: () => coord.sessionsList(),
  modLive: (sid) => modLive(sessions.get(sid)),
  handle: (req) => handle(req as Req) as Promise<any>,
})
// A running server shared with a teammate, over the sealed channel (src/share/).
shares = createShares({
  me: () => ({ label: identity!.label, fingerprint: myFingerprint() }),
  peers: () => loadPeers(),
  send: (label, env) => sendEnvelope(label, env),
  stream: (label, env) => {
    const peer = loadPeers()[label]
    if (!peer) return false
    // Live only, and on the hosted relay only as stream frames (src/streamgate.ts).
    const t = streamGate.route(label)
    if (!t) return false
    return relaySend({ t, to: peer.fingerprint, id: env.id, body: seal(channelKey(identity!, peer), JSON.stringify(env)) })
  },
  mode: () => streamGate.mode(),
  log,
  fallbackSession: () => coord.mainId() ?? mostRecentSession()?.sessionId,
  modLive: (sid) => modLive(sessions.get(sid)),
  note: (id, text) => coord.note({ id, text }),
})
setInterval(() => attention?.tick(), Math.max(200, Number(process.env.CROSSTALK_ATTENTION_TICK_MS ?? 15_000)))

// The board (src/ui-extra/board.ts): kept current every minute while it is in use.
setInterval(() => {
  try {
    if (boardMod.boardWanted()) boardMod.writeBoard()
  } catch {}
}, 60_000).unref()

// Terminal.app tints are opt-in (CROSSTALK_TAB_COLOUR=1). With them off, put
// back any background an earlier version tinted, once, off the start path.
if (process.platform === "darwin" && !tabStatus.appleTintOn())
  setTimeout(() => {
    try {
      const r = tabStatus.resetColours(undefined, { once: true })
      if (r.reset) log(`terminal: ${r.reset} tab background(s) back to their profile's`)
    } catch {}
  }, 2000).unref()

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
  // Which crosstalk this is, so a newer install takes over (client.ts ensureDaemon).
  try {
    fs.writeFileSync(P.daemonVersion, JSON.stringify({ pid: process.pid, version: pluginVersion(rootFrom(import.meta.url)) }), { mode: 0o600 })
  } catch {}
  log(`daemon up as "${identity!.label}" on ${P.daemonSock}`)
  connect()
  // Sessions that outlived the last daemon are placed again, and every repo
  // with threads catches up with its remote. Neither can hold anything up.
  threads.retain([...sessions.keys()])
  coord.start()
  attention?.start()
  for (const reg of sessions.values()) observeThreads(reg)
  threads.fade()
  void threads.syncAll()
  // URLs: the proxy behind <thread>.localhost, services' URLs, liveness (src/urls/).
  if (!process.env.CROSSTALK_NO_URLS)
    void createUrls({
      log,
      live: () => [...sessions.values()].map((s) => ({ sessionId: s.sessionId, cwd: s.cwd })),
      // A PR's checks passed or failed, or it merged or closed (src/urls/ci.ts): the
      // sessions in its thread are told, and a failure is kept as a task to investigate.
      onPr: (u, c) => {
        try {
          const t = u.thread ? threads.find(undefined, u.thread) : undefined
          const to = [...new Set([...(u.sessionId ? [u.sessionId] : []), ...(t ? threads.sessionsIn([t.id]) : [])])].filter((sid) => sessions.has(sid))
          const text = ciMod.changeText(u.label, u.url, c)
          if (c.kind === "failed" && t) threads.task(undefined, { op: "add", text: ciMod.investigation(u.label, u.url, c.failed), thread: t.meta.value.name })
          for (const sid of to)
            ui.withStore((items, now) =>
              ui.upsert(items, { id: `ci:${u.id}:${c.kind}:${u.lastCheck}`, kind: "message", sessionId: sid, from: "crosstalk", ...(t ? { thread: t.meta.value.name } : {}), text, auto: true, ts: now }, now),
            )
          ciMod.recordEvent(c.kind === "failed" ? `${u.label}: checks failed${c.failed?.length ? `: ${c.failed.join(", ")}` : ""}` : c.kind === "passed" ? `${u.label}: checks passed` : `${u.label} ${c.kind}`)
          log(`ci: ${text}${to.length ? ` (told ${to.length} session${to.length === 1 ? "" : "s"})` : ""}`)
        } catch (e) {
          log(`ci: ${(e as Error).message}`)
        }
      },
    }).catch((e) => log(`urls: ${(e as Error).message}`))
  // Servers that look after themselves, and baseline screenshots (src/urls/health/).
  if (!process.env.CROSSTALK_NO_URLS && !process.env.CROSSTALK_NO_HEALTH)
    createHealth({
      log,
      root: rootFrom(import.meta.url),
      sessions: () => [...sessions.values()].map((s) => ({ sessionId: s.sessionId, cwd: s.cwd })),
      threadOf: (sid) => {
        const t = threads.thread(threads.idsFor(sid)[0] ?? "")
        return t ? { id: t.id, name: t.meta.value.name } : undefined
      },
      sessionsIn: (id) => threads.sessionsIn([id]),
      // A thread's: the own-thread heads-up, handed to its agent by itself. Otherwise a held local message.
      tell: (o) =>
        o.thread
          ? coord.warn.relay({ thread: o.thread, local: o.sessions, labels: [], text: o.text, diff: { label: o.label, content: o.log || "(empty)" }, warn: {}, fromSession: "-" })
          : o.sessions.forEach((sid) => void Promise.resolve(handle({ op: "post", to: sid, source: "crosstalk health", intent: "fyi", text: o.text })).catch(() => {})),
      notifyPerson: (o) => (o.thread ? threads.notify(o.thread, o.text) : coord.note({ id: `health:${Date.now()}`, text: o.text }, o.session)),
    })
  // Every link, preview and screenshot a thread had, kept in it (src/urls/history/).
  if (!process.env.CROSSTALK_NO_URLS) startHistory({ threads, log })
})

setInterval(() => {
  try {
    threads.fade()
  } catch (e) {
    log(`threads: ${(e as Error).message}`)
  }
  void threads.syncAll()
}, Number(process.env.CROSSTALK_THREAD_SYNC_MS ?? 5 * 60_000))

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
