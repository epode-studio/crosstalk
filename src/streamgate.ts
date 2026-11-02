// How a shared server's frames (src/share/) go over the relay, and when they
// stop. daemon.ts makes one of these and asks it about every share frame.
//
//   self-hosted relay   `stream` frames when its `ready` says `streams`, else
//                       ordinary sends (relay/relay.ts before stream frames)
//   hosted relay        `stream` frames only. Never stored sends: on the shared
//                       free plan those burn everyone's request quota and its
//                       storage, a write per frame (worker/README.md)
//   paused              the hosted relay said `stream_paused` (its daily
//                       allowance is spent): nothing more streams until the
//                       time it gave, and both people are told in plain words,
//                       once; ordinary messages are untouched

export const PAUSED_TEXT =
  "sharing through the shared relay is paused until tomorrow; run your own relay with `--host` or `worker/`. Ordinary messages still work."

export const NO_STREAMS_TEXT =
  "the shared relay does not carry live share traffic yet (it needs redeploying from `worker/`), so sharing waits rather than costing everyone's storage; run your own relay with `--host` or `worker/` to share now."

export type GateDeps = {
  /** A plain line for the person here. */
  note: (id: string, text: string) => void
  /** A plain message to someone this machine was sharing with. */
  tell: (label: string, text: string) => void
  log: (s: string) => void
  now?: () => number
}

/** Long enough for any one share's people; anyone older than this is not mid-share. */
const RECENT_MS = 15 * 60_000

export function createStreamGate(d: GateDeps) {
  const now = d.now ?? Date.now
  let hosted = false
  let streams: boolean | undefined
  let openedAt = 0
  let pausedUntil = 0
  let toldNoStreams = false
  const recent = new Map<string, number>()

  return {
    /** A new relay link: nothing is known about streams until its `ready`. */
    connected(o: { hosted: boolean }) {
      hosted = o.hosted
      streams = undefined
      openedAt = now()
    },
    /** The relay's `ready`. */
    ready(o: { streams?: unknown }) {
      streams = !!o.streams
    },
    /** How a share frame goes now, or null when it does not go at all. */
    route(label: string): "stream" | "send" | null {
      const t = now()
      if (t < pausedUntil) return null
      if (hosted && !streams) {
        // A hosted relay's `ready` comes straight after it opens. One that never says
        // `streams` predates them: say so once, and send nothing.
        if (!toldNoStreams && t - openedAt > 5_000) {
          toldNoStreams = true
          d.log("share: the hosted relay does not advertise stream frames; share frames are not sent")
          d.note(`streams:none:${t}`, `◢ crosstalk: ${NO_STREAMS_TEXT}`)
        }
        return null
      }
      recent.set(label, t)
      return streams ? "stream" : "send"
    },
    /** The mode src/share/ paces for. */
    mode(): "stream" | "send" | "worker" {
      return streams ? (hosted ? "worker" : "stream") : "send"
    },
    paused(): boolean {
      return now() < pausedUntil
    },
    /** A relay `error` frame. True when it was about streams (and is dealt with). */
    onError(f: { code?: unknown; until?: unknown; scope?: unknown; to?: unknown; message?: unknown }, me = "this machine"): boolean {
      if (f.code === "stream_offline" || f.code === "stream_burst") {
        d.log(`share: relay: ${String(f.message ?? f.code).slice(0, 200)}`)
        return true
      }
      if (f.code !== "stream_paused") return false
      const t = now()
      const fresh = t >= pausedUntil
      // Until the time it gave (the next 00:00 UTC), and never past a day from now.
      const until = Number(f.until)
      pausedUntil = Number.isFinite(until) && until > t ? Math.min(until, t + 25 * 60 * 60_000) : t + 60 * 60_000
      if (!fresh) return true
      const why = f.scope === "relay" ? "everyone's sharing together has used the shared relay's daily allowance" : "this machine has used its daily allowance on the shared relay"
      d.log(`share: paused by the hosted relay until ${new Date(pausedUntil).toISOString()} (${why})`)
      d.note(`streams:paused:${t}`, `◢ crosstalk: ${PAUSED_TEXT} (${why}.)`)
      for (const [label, at] of recent) if (t - at < RECENT_MS) d.tell(label, `◢ crosstalk: ${me}'s ${PAUSED_TEXT}`)
      recent.clear()
      return true
    },
  }
}

export type StreamGate = ReturnType<typeof createStreamGate>
