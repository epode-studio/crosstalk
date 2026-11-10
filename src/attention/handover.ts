// After an update, the main session moves onto the new version by itself.
//
// A session runs the crosstalk it started with until it restarts. The main
// session is where the person reads everything, so after an update crosstalk
// restarts it: closes it (archived) and resumes it in a new tab, the same
// session with its whole conversation, now on the new version. Its inbox goes
// with it, since everything there is keyed by the session, and it is made main
// again as soon as it is back.
//
// Only at a quiet moment: main idle, nothing typed or run in it for a few
// minutes (longer while it is the tab in front), never twice for one version.
// CROSSTALK_NO_HANDOVER=1 turns it off.

export const disabled = (env: NodeJS.ProcessEnv = process.env) => env.CROSSTALK_NO_HANDOVER === "1"

/** Quiet this long first; longer while it is the tab in front, where the person may be about to type. */
export const QUIET_MS = 3 * 60_000
export const QUIET_FRONT_MS = 10 * 60_000

export type Main = {
  sessionId: string
  /** When the session started: before the update was installed means it runs the old version. */
  startedAt?: number
  /** Its last hook: a prompt, a tool, a turn ending. */
  seenAt?: number
  status?: string
  inFront: boolean
}

/** Whether to move main onto the new version now. */
export function due(o: { main: Main | null; installedAt?: number; version: string; done?: string; now: number; env?: NodeJS.ProcessEnv }): boolean {
  if (disabled(o.env) || !o.main || !o.installedAt || !o.version) return false
  if (o.done === `${o.main.sessionId}@${o.version}`) return false
  if (!o.main.startedAt || o.main.startedAt >= o.installedAt) return false
  if (/busy|working|running|thinking|waiting/i.test(o.main.status ?? "")) return false
  const quiet = o.main.inFront ? QUIET_FRONT_MS : QUIET_MS
  return o.now - (o.main.seenAt ?? o.now) >= quiet
}

/** What Lately says. */
export const line = (version: string) => `restarted your main session on crosstalk ${version}, with its whole conversation and inbox`
