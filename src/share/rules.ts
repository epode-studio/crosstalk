// What may be shared, and what a viewer takes (docs/urls.md, "Sharing"). Pure.

import { cleanName } from "../protocol.ts"
import { label as dnsLabel } from "../urls/routes.ts"
import * as F from "./frames.ts"

const LOOPBACK = /^(localhost|127\.0\.0\.1|\[::1\]|0\.0\.0\.0)$/i

/**
 * The port a URL record may be shared on: a local server's, never crosstalk's
 * own proxy (through it, a Host header would reach every service here). A
 * proxy name (`auth.localhost`) is not shared by itself: the service it
 * names is.
 */
export function gate(u: { url: string; kind: string }, o: { proxyPort?: number }): { port: number } | { error: string } {
  let url: URL
  try {
    url = new URL(u.url)
  } catch {
    return { error: "not a URL" }
  }
  if (/\.localhost$/i.test(url.hostname)) return { error: "that is a name through crosstalk's proxy; share the service itself (crosstalk_work action \"urls\" lists it)" }
  if (u.kind !== "local" || url.protocol !== "http:" || !LOOPBACK.test(url.hostname)) return { error: "only a local server (http on localhost) can be shared" }
  const port = Number(url.port || 80)
  if (!(port > 0 && port < 65536)) return { error: "no port" }
  if (o.proxyPort && port === o.proxyPort) return { error: "that is crosstalk's own proxy; share the service itself" }
  return { port }
}

/** A label someone else chose, as plain text: letters, digits, spaces and `.·:#@/()+-`, 80 at most. */
export function cleanLabel(v: unknown, max = 80): string | undefined {
  if (typeof v !== "string") return undefined
  const s = v
    .normalize("NFKC")
    .replace(/[^\p{L}\p{N} .·:#@/()+_-]+/gu, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, max)
    .trim()
  return s || undefined
}

export type OfferPeer = { label: string; fingerprint?: string; bot?: boolean; muted?: boolean; level?: string }

/**
 * Whether the viewer takes an offer: from a person with a direct channel
 * (never through a room, never an agent, not muted), fresh, for at most a
 * week, for a share that has not already ended here (a replay). The names in
 * it are cut to plain text: they end up in a card, a pane and the agent's
 * URL list.
 */
export function decideOffer(
  offer: any,
  o: { now: number; envTs: unknown; inRoom: boolean; peer: OfferPeer | undefined; ended?: boolean },
): { ok: true; id: string; label: string; name: string; thread?: string; expiresAt: number } | { ok: false; why: string } {
  if (o.inRoom) return { ok: false, why: "an offer through a room" }
  if (!o.peer?.fingerprint) return { ok: false, why: "no direct channel" }
  if (o.peer.bot) return { ok: false, why: "from an agent" }
  if (o.peer.muted || o.peer.level === "mute") return { ok: false, why: "they are muted" }
  if (!F.fresh(o.envTs, o.now, F.OFFER_SKEW_MS)) return { ok: false, why: "stale" }
  if (!offer || !F.isId(offer.id)) return { ok: false, why: "malformed" }
  if (o.ended) return { ok: false, why: "that share already ended here" }
  const expiresAt = Number(offer.expiresAt)
  if (!(expiresAt > o.now) || expiresAt > o.now + F.MAX_MS + F.OFFER_SKEW_MS) return { ok: false, why: "expiry out of range" }
  const label = cleanLabel(offer.label) ?? "a server"
  const name = dnsLabel(String(offer.name ?? "").replace(/\./g, "-")) || "shared"
  const thread = cleanName(offer.thread, 64)
  return { ok: true, id: offer.id, label, name, ...(thread ? { thread } : {}), expiresAt }
}

/** How a share reads in a pane and a URL list: `auth · dev server · shared with marie · until 18:00`. */
export function label(o: { side: "out" | "in"; label: string; with?: string[]; from?: string; expiresAt: number; public?: boolean }, now = Date.now()): string {
  const until = F.untilText(o.expiresAt, now)
  if (o.side === "in") return `${o.label} · from ${o.from} · ${until}`
  const who = o.public ? "PUBLIC link" : `shared with ${(o.with ?? []).join(", ") || "nobody"}`
  return `${o.label} · ${who} · ${until}`
}
