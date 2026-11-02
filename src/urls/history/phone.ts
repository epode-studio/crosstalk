// On the phone (docs/urls.md, "On the phone"): a QR code in the pane for a URL
// the person picks, "show me a QR for the auth page".
//
// A phone cannot open `http://auth.localhost`: that name, like every local
// URL, is this machine. So what is encoded is
//
//   a preview, a PR, a public link   the URL itself
//   a local server                   its share link, when the sharing build
//                                    (src/share/) gave it one; else the
//                                    thread's preview, when it has one that
//                                    answers; else nothing, and the person is
//                                    told the phone needs a share link
//
// The code is drawn in the pane and nowhere else: it is written to
// <crosstalk home>/qr/<session>.json, which `crosstalk ui pane` adds to the
// pane it prints. Neither the code nor what it encodes goes into a tool
// result, because a share link is a key to the running server.

import fs from "node:fs"
import path from "node:path"
import { P } from "../../config.ts"
import type { Url } from "../store.ts"
import { encode, halfBlocks } from "./qr.ts"

export const QR_TTL_MS = 30 * 60_000

/** What the pane draws. Never model context. */
export type PaneQr = { label: string; caption: string; rows: string[]; at: number; why?: string }

const LOCAL_HOST = /^(localhost|127(?:\.\d{1,3}){3}|0\.0\.0\.0|\[::1?\]|[a-z0-9.-]*\.localhost)$/i

/** A URL a phone cannot reach: this machine's own names. */
export function isLocalUrl(url: string): boolean {
  try {
    const u = new URL(url)
    return LOCAL_HOST.test(u.hostname)
  } catch {
    return false
  }
}

const https = (x: unknown): string | undefined => (typeof x === "string" && /^https:\/\/[^\s]+$/.test(x) && !isLocalUrl(x) ? x : undefined)

/**
 * The sharing build's link for a local record, when it has one. The contract
 * (src/share/ fills it in): the record carries `shareUrl` (or `share.url`), or
 * another record names it in `sharedFrom` and is itself public. Until then
 * there is none, and the phone needs one.
 */
export function shareLinkFor(u: Url, all: Url[]): string | undefined {
  const own = https((u as any).shareUrl) ?? https((u as any).share?.url)
  if (own) return own
  const other = all.find((r) => (r as any).sharedFrom === u.id && https(r.url) && r.alive !== false)
  return other?.url
}

export type Target = { ok: true; url: string; label: string; via: "public" | "share" | "preview"; note?: string } | { ok: false; text: string }

/** What the phone gets for a record: itself, its share link, or the thread's preview. */
export function phoneTarget(u: Url, all: Url[]): Target {
  if (u.kind !== "local" && !isLocalUrl(u.url)) return { ok: true, url: u.url, label: u.label, via: "public" }
  const share = shareLinkFor(u, all)
  if (share) return { ok: true, url: share, label: u.label, via: "share" }
  const preview = all.find((r) => r.kind === "preview" && r.thread && r.thread === u.thread && r.alive !== false && !isLocalUrl(r.url))
  if (preview) return { ok: true, url: preview.url, label: preview.label, via: "preview", note: `${u.label} runs only on this machine, so the code is for ${preview.label}, the deployed copy` }
  return {
    ok: false,
    text: `◢ crosstalk: ${u.label} runs on this machine only (a local URL), so a QR code for it would not open on a phone. The phone needs a share link for it, or a preview that is deployed. Sharing a local server with your own phone ("share it with my phone") is not built yet; a deployed preview of the thread works today.`,
  }
}

const qrDir = () => path.join(P.root, "qr")
const qrFile = (sessionId: string) => path.join(qrDir(), `${sessionId.replace(/[^A-Za-z0-9._-]/g, "_")}.json`)

/** The pane's QR for a URL. Throws when it is too long for one. */
export function paneQrFor(o: { url: string; label: string; via: string; note?: string; now?: number }): PaneQr {
  const q = encode(o.url)
  let host = ""
  try {
    host = new URL(o.url).host
  } catch {}
  // A share link's path is its key: the caption names the host only.
  const caption = o.via === "share" ? `${host} · share link` : o.url.length <= 60 ? o.url : `${o.url.slice(0, 57)}…`
  return { label: o.label, caption, rows: halfBlocks(q.modules), at: o.now ?? Date.now(), ...(o.note ? { why: o.note } : {}) }
}

export function writePaneQr(sessionId: string, qr: PaneQr) {
  fs.mkdirSync(qrDir(), { recursive: true, mode: 0o700 })
  const f = qrFile(sessionId)
  const tmp = `${f}.${process.pid}.tmp`
  fs.writeFileSync(tmp, JSON.stringify(qr), { mode: 0o600 })
  fs.renameSync(tmp, f)
}

/** The session's QR for its pane, while it is fresh. */
export function readPaneQr(sessionId: string | undefined, now = Date.now()): PaneQr | undefined {
  if (!sessionId) return undefined
  try {
    const q = JSON.parse(fs.readFileSync(qrFile(sessionId), "utf8"))
    if (!Array.isArray(q?.rows) || typeof q.label !== "string" || now - Number(q.at) > QR_TTL_MS) return undefined
    return { label: q.label, caption: String(q.caption ?? ""), rows: q.rows.map(String).slice(0, 40), at: Number(q.at), ...(q.why ? { why: String(q.why) } : {}) }
  } catch {
    return undefined
  }
}

export function clearPaneQr(sessionId: string) {
  try {
    fs.unlinkSync(qrFile(sessionId))
  } catch {}
}
