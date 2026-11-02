// Whether each URL still answers (docs/urls.md).
//
//   local      HEAD, then GET when HEAD fails or is refused, two seconds
//              each: every 30 seconds while a session is live in its
//              worktree (CROSSTALK_URL_CHECK_MS), every five minutes when none
//              is; a failure is looked at again after five seconds, and two in
//              a row mark it dead
//   preview    the same, every five minutes
//   pr         `gh pr view <url> --json state`, every ten minutes, where gh
//              is installed: open is alive, merged or closed is dead
//   link       never: a link found in a command's output is not fetched, and
//              neither is anything else a command printed unless it is local
//
// Any HTTP answer counts as answering (a 500 is a server that runs); the
// status is kept for the builds that come after (self-healing).

import { spawnSync } from "node:child_process"
import fs from "node:fs"
import path from "node:path"
import type { Url, UrlStore } from "./store.ts"
import { isLocalHost } from "./extract.ts"

export const liveEvery = () => Number(process.env.CROSSTALK_URL_CHECK_MS ?? 30_000)
export const IDLE_MS = 5 * 60_000
export const PREVIEW_MS = 5 * 60_000
export const PR_MS = 10 * 60_000
export const RETRY_MS = () => Math.min(5000, liveEvery())

export type Probe = { ok: boolean; status?: number }

/** One URL, HEAD then GET, never following a redirect. */
export async function probe(url: string, timeoutMs = 2000): Promise<Probe> {
  const once = async (method: "HEAD" | "GET"): Promise<Probe> => {
    try {
      const r = await fetch(url, { method, redirect: "manual", signal: AbortSignal.timeout(timeoutMs), headers: { "user-agent": "crosstalk-liveness" } })
      try {
        await r.body?.cancel()
      } catch {}
      return { ok: true, status: r.status }
    } catch {
      return { ok: false }
    }
  }
  const h = await once("HEAD")
  if (h.ok && h.status !== 405 && h.status !== 501) return h
  const g = await once("GET")
  return g.ok ? g : h
}

const isLocal = (u: Url) => {
  try {
    return isLocalHost(new URL(u.url).hostname)
  } catch {
    return false
  }
}

/** Whether crosstalk may fetch it at all: local ones, and previews shipping recorded. Never a link from output. */
export const checkable = (u: Url) => (u.kind === "local" && isLocal(u)) || (u.kind === "preview" && u.source === "preview") || u.kind === "pr"

/** When it is next due. `live` says whether a session is live where it runs. */
export function nextDue(u: Url, live: boolean): number {
  if (!u.lastCheck) return 0
  if (u.fails && u.alive) return u.lastCheck + RETRY_MS()
  const every = u.kind === "pr" ? PR_MS : u.kind === "preview" ? PREVIEW_MS : live ? liveEvery() : IDLE_MS
  return u.lastCheck + every
}

let ghPath: string | null | undefined
function gh(): string | null {
  if (ghPath !== undefined) return ghPath
  ghPath = null
  for (const d of (process.env.PATH ?? "").split(path.delimiter))
    try {
      if (d) {
        fs.accessSync(path.join(d, "gh"), fs.constants.X_OK)
        ghPath = path.join(d, "gh")
        break
      }
    } catch {}
  return ghPath
}

export type PrState = (url: string, cwd?: string) => string | undefined
const ghState: PrState = (url, cwd) => {
  const bin = gh()
  if (!bin) return undefined
  const r = spawnSync(bin, ["pr", "view", url, "--json", "state"], { encoding: "utf8", timeout: 20_000, ...(cwd && fs.existsSync(cwd) ? { cwd } : {}) })
  if (r.status !== 0) return undefined
  try {
    return String(JSON.parse(r.stdout).state ?? "") || undefined
  } catch {
    return undefined
  }
}

/**
 * Check what is due, at most `max` at a time. `liveRoots` are the worktrees a
 * session is live in now. Returns what was checked.
 */
export async function tick(store: UrlStore, o: { liveRoots: Set<string>; liveSessions?: Set<string>; now?: number; probe?: (url: string) => Promise<Probe>; prState?: PrState; max?: number } = { liveRoots: new Set() }): Promise<Url[]> {
  const now = o.now ?? Date.now()
  const p = o.probe ?? ((u: string) => probe(u))
  const due = store
    .read()
    .filter(checkable)
    .filter((u) => u.alive || u.kind !== "pr")
    .filter((u) => nextDue(u, (!!u.worktree && o.liveRoots.has(u.worktree)) || (!!u.sessionId && !!o.liveSessions?.has(u.sessionId))) <= now)
    .slice(0, o.max ?? 16)
  const out: Url[] = []
  await Promise.all(
    due.map(async (u) => {
      if (u.kind === "pr") {
        const s = (o.prState ?? ghState)(u.url, u.worktree)
        if (!s) {
          store.update(u.id, { lastCheck: now })
          return
        }
        const r = s === "OPEN" ? store.markOk(u.id, { state: s }) : store.markDead(u.id, { state: s })
        if (r) out.push(r)
        return
      }
      const r = await p(u.url)
      const after = r.ok ? store.markOk(u.id, { status: r.status }) : store.markFailed(u.id)
      if (after) out.push(after)
    }),
  )
  return out
}
