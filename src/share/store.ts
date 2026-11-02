// Shares this machine made and was given, in <crosstalk home>/shares.json.
// The daemon alone writes it; the pane and the CLI only read the URL records
// it keeps in urls.json.

import fs from "node:fs"
import path from "node:path"
import { P } from "../config.ts"

/** A share this machine made: one local service, the people it is for, until when. */
export type OutShare = {
  id: string
  /** The URL record it was made from (urls.json). */
  urlId: string
  /** Its label there: `auth · dev server`. */
  label: string
  /** What the viewer's proxy calls it, before the owner's name: `auth` → `auth.paul.localhost`. */
  name: string
  thread?: string
  worktree?: string
  service?: string
  /** The session that asked. */
  by?: string
  /** What is forwarded to: a crosstalk service (its port followed), or one port. */
  target: { svc?: string; port?: number }
  with: { label: string; fingerprint: string }[]
  createdAt: number
  expiresAt: number
  revokedAt?: number
  ended?: "expired" | "revoked"
  /** A public link, when the person asked for one: cloudflared's URL and process. */
  public?: { url: string; pid: number }
}

/** A share given to this machine: whose, what, its local listener. */
export type InShare = {
  id: string
  owner: string
  fingerprint: string
  label: string
  name: string
  thread?: string
  expiresAt: number
  at: number
  /** The listener's port, while it runs. */
  port?: number
  /** The session its card went to. */
  sessionId?: string
  ended?: "expired" | "revoked" | "declined" | "removed"
  endedAt?: number
}

type File = { v: 1; out: OutShare[]; in: InShare[] }

/** Ended ones are kept a week, so an offer played again later is known for what it is. */
const KEEP_ENDED_MS = 7 * 24 * 60 * 60_000

export const file = () => path.join(P.root, "shares.json")

export function read(f = file()): File {
  try {
    const raw = JSON.parse(fs.readFileSync(f, "utf8"))
    return { v: 1, out: Array.isArray(raw?.out) ? raw.out : [], in: Array.isArray(raw?.in) ? raw.in : [] }
  } catch {
    return { v: 1, out: [], in: [] }
  }
}

export function write(s: File, f = file(), now = Date.now()) {
  const keep = <T extends { ended?: string; expiresAt: number; endedAt?: number; revokedAt?: number }>(x: T) => !x.ended || now - (x.endedAt ?? x.revokedAt ?? x.expiresAt) < KEEP_ENDED_MS
  const out = { v: 1, out: s.out.filter(keep), in: s.in.filter(keep) }
  fs.mkdirSync(path.dirname(f), { recursive: true, mode: 0o700 })
  const tmp = `${f}.${process.pid}.tmp`
  fs.writeFileSync(tmp, JSON.stringify(out, null, 1), { mode: 0o600 })
  fs.renameSync(tmp, f)
}

export const active = <T extends { ended?: string; expiresAt: number }>(x: T, now = Date.now()) => !x.ended && x.expiresAt > now
