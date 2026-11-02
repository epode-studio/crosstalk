// Servers that look after themselves: the state machine, pure
// (docs/urls.md, "Servers that look after themselves").
//
// One record per crosstalk service, stepped by what the daemon sees each
// tick: the process (running, exited with a status, stopped by crosstalk)
// and its URL (alive, dead after two failed checks, src/urls/liveness.ts).
//
//   healthy     running, and its URL answers (or has had no time to yet)
//   starting    a new start, its URL not answering yet, within the grace
//   crash       exited with a status other than 0
//                 -> restarted once by itself, after a backoff, when it had
//                    been healthy within the last 10 s (a sudden crash, not one
//                    that never came up), no restart of its own was spent on
//                    this episode, and fewer than 3 were spent in the hour;
//                    the agent is told either way, with its log
//   unanswering running, its URL dead: the agent is told; nothing restarts it
//   broken      a failure nobody has fixed: the tab is red, the agent told
//               once per start of the service
//   gave-up     it broke again after the agent restarted it: the person is
//               told once, and nothing more is said until it is healthy or
//               started again
//   finished    exited with status 0: it ended by itself, nothing is said
//   stopped     crosstalk_work action "stop": forgotten
//
// An episode ends when the service stays healthy for STABLE_MS: what was
// spent on it (the restart, who was told) is forgotten then. Nothing here
// loops: a restart needs a healthy period first, and at most one per episode
// and three an hour.

export type Phase = "healthy" | "starting" | "restart-due" | "restarting" | "broken" | "gave-up" | "finished"

export type Health = {
  id: string
  name: string
  root: string
  /** The start being watched: the service record's startedAt. */
  gen: number
  phase: Phase
  /** Last seen healthy, and since when without a break. */
  healthyAt?: number
  healthySince?: number
  /** When crosstalk restarted it by itself (the hour's count). */
  restarts: number[]
  /** This episode's restart is spent. */
  restarted?: boolean
  /** The start crosstalk itself made, so it is not taken for the agent's. */
  ownGen?: number
  restartAt?: number
  /** What is wrong, in a few words: "exited with status 1", "stopped answering". */
  why?: string
  /** The start the agent was last told about. */
  toldGen?: number
  /** How many heads-ups this episode. */
  told?: number
  /** The agent started it again after being told. */
  agentTried?: boolean
  personTold?: boolean
  brokenAt?: number
}

export type Seen = {
  id: string
  name: string
  root: string
  gen: number
  state: "running" | "exited" | "stopped"
  /** The exit status, when it exited and one was written. */
  exit?: string
  /** Its URL record: alive or not; undefined when it has none. */
  urlAlive?: boolean
  /** When its URL last answered. */
  urlOk?: number
}

export type Action =
  | { kind: "restart"; why: string }
  | { kind: "tell-agent"; why: string; restarting: boolean; again: boolean }
  | { kind: "broken"; why: string }
  | { kind: "healed" }
  | { kind: "tell-person"; why: string }

export const cfg = () => ({
  /** A crash this soon after it was last seen healthy is a sudden one, restarted once. */
  crashWindowMs: Number(process.env.CROSSTALK_HEALTH_CRASH_WINDOW_MS ?? 10_000),
  /** How long a new start has to answer before its silence counts. */
  graceMs: Number(process.env.CROSSTALK_HEALTH_GRACE_MS ?? 60_000),
  /** Healthy this long, and an episode is over. */
  stableMs: Number(process.env.CROSSTALK_HEALTH_STABLE_MS ?? 120_000),
  /** The first restart's wait; each one in the hour doubles it, up to a minute. */
  backoffMs: Number(process.env.CROSSTALK_HEALTH_BACKOFF_MS ?? 1000),
  perHour: 3,
  /** A restart that shows no new start in this long failed. */
  restartWaitMs: 15_000,
  /** Heads-ups an episode at most. */
  maxTold: 3,
})

export type Cfg = ReturnType<typeof cfg>

const HOUR = 3600_000

export const backoff = (restartsInHour: number, c: Cfg = cfg()) => Math.min(60_000, c.backoffMs * 2 ** restartsInHour)

/** One tick for one service. Returns the next record (undefined: forget it) and what to do. */
export function step(prev: Health | undefined, s: Seen, now: number, c: Cfg = cfg()): { next: Health | undefined; actions: Action[] } {
  const actions: Action[] = []
  // The tab shows it broken until it is healthy again, across a new start.
  const wasBroken = prev?.brokenAt !== undefined
  if (s.state === "stopped") {
    if (wasBroken) actions.push({ kind: "healed" })
    return { next: undefined, actions }
  }
  // Already down when first seen (before the daemon started), or finished: nothing to say until it is started again.
  if (s.state === "exited" && (!prev || (prev.phase === "finished" && prev.gen === s.gen))) return { next: prev ?? { id: s.id, name: s.name, root: s.root, gen: s.gen, phase: "finished", restarts: [] }, actions }
  let h: Health = prev ? { ...prev, restarts: prev.restarts.filter((t) => now - t < HOUR) } : { id: s.id, name: s.name, root: s.root, gen: s.gen, phase: "starting", restarts: [] }
  // A new start: crosstalk's own restart, or someone else's (the agent's crosstalk_work action "serve").
  if (prev && s.gen !== prev.gen) {
    const ours = prev.ownGen === s.gen || prev.phase === "restarting"
    h = { ...h, gen: s.gen, phase: "starting", healthySince: undefined }
    if (!ours && prev.toldGen !== undefined) h.agentTried = true
    delete h.restartAt
  }

  const answeredThisStart = !!s.urlOk && s.urlOk >= h.gen
  const silent = s.state === "running" && s.urlAlive === false && (answeredThisStart || now - h.gen > c.graceMs)
  const healthy = s.state === "running" && !silent && (s.urlAlive !== false)

  if (healthy) {
    if (wasBroken) actions.push({ kind: "healed" })
    const since = h.phase === "healthy" && h.healthySince ? h.healthySince : now
    h = { ...h, phase: s.urlAlive === undefined || answeredThisStart || s.urlAlive ? "healthy" : "starting", healthyAt: now, healthySince: since }
    delete h.why
    delete h.brokenAt
    // Long enough: the episode is over.
    if (now - since >= c.stableMs) {
      delete h.restarted
      delete h.toldGen
      delete h.told
      delete h.agentTried
      delete h.personTold
      delete h.ownGen
    }
    return { next: h, actions }
  }

  if (s.state === "exited" && s.exit === "0") {
    if (wasBroken) actions.push({ kind: "healed" })
    const done: Health = { ...h, phase: "finished" }
    delete done.brokenAt
    return { next: done, actions }
  }

  // Waiting out a restart's backoff.
  if (h.phase === "restart-due" && s.state === "exited") {
    if (now >= (h.restartAt ?? 0)) {
      h = { ...h, phase: "restarting", restarts: [...h.restarts, now], restarted: true }
      actions.push({ kind: "restart", why: h.why ?? "it crashed" })
    }
    return { next: h, actions }
  }
  // The new start shows on a later tick; one that never comes is a failed restart, and broken.
  if (h.phase === "restarting" && now - (h.restarts[h.restarts.length - 1] ?? 0) < c.restartWaitMs) return { next: h, actions }
  if (s.state === "running" && !silent) return { next: { ...h, phase: "starting" }, actions }

  const crash = s.state === "exited"
  const why = crash ? (s.exit !== undefined ? `exited with status ${s.exit}` : "exited") : "stopped answering"
  // Already broken for this start: nothing new to say.
  if ((h.phase === "broken" || h.phase === "gave-up") && h.toldGen === h.gen) return { next: h, actions }

  const sudden = crash && s.exit !== undefined && s.exit !== "0" && !!prev?.healthyAt && now - prev.healthyAt <= c.crashWindowMs
  const canRestart = sudden && !h.restarted && !h.agentTried && h.restarts.length < c.perHour
  const again = h.toldGen !== undefined
  if (canRestart) {
    h = { ...h, phase: "restart-due", why, restartAt: now + backoff(h.restarts.length, c), toldGen: h.gen, told: (h.told ?? 0) + 1 }
    actions.push({ kind: "tell-agent", why, restarting: true, again })
    return { next: h, actions }
  }

  // Broken: the tab goes red; the agent is told, unless it already tried and failed.
  const gaveUp = !!h.agentTried
  h = { ...h, phase: gaveUp ? "gave-up" : "broken", why, brokenAt: h.brokenAt ?? now }
  delete h.restartAt
  if (!wasBroken) actions.push({ kind: "broken", why })
  if (gaveUp) {
    if (!h.personTold) {
      h.personTold = true
      actions.push({ kind: "tell-person", why })
    }
  } else if ((h.told ?? 0) < c.maxTold) {
    actions.push({ kind: "tell-agent", why, restarting: false, again })
    h.told = (h.told ?? 0) + 1
  }
  h.toldGen = h.gen
  return { next: h, actions }
}
