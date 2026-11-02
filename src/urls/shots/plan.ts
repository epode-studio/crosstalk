// Which of a thread's URLs get captured, pure (docs/urls.md, "Screenshots").
//
//   yes    local servers on this machine (a crosstalk service, or a localhost
//          URL a command printed) and shipping's previews, while they answer
//   no     pull requests (a page about the code, not the running thing),
//          links found in output (never fetched by crosstalk), anything dead,
//          and anything someone else shared: those only when the person asks
//          for that address by name
//
// At most MAX_TARGETS a time, crosstalk's own services first.

import type { Url } from "../store.ts"
import { isLocalHost } from "../extract.ts"
import { keyOf } from "./store.ts"

export const MAX_TARGETS = 6

export type Target = { key: string; url: string; label: string; urlId?: string; path?: string; worktree?: string; thread?: string }
export type Skipped = { label: string; why: string }

const hostOf = (u: string) => {
  try {
    return new URL(u).hostname
  } catch {
    return ""
  }
}

/** A path on a URL: `/login` on http://localhost:4100 is http://localhost:4100/login. */
export function withPath(base: string, p?: string): string {
  if (!p) return base
  try {
    return new URL(p.startsWith("/") ? p : `/${p}`, base).toString()
  } catch {
    return base
  }
}

/** A clean path: one starting with /, no scheme or host, no control characters. */
export function cleanPath(p: unknown): string | undefined {
  if (typeof p !== "string" || !p.trim()) return undefined
  const s = p.trim()
  if (/^[a-z][a-z0-9+.-]*:/i.test(s) || s.startsWith("//") || /[\s\u0000-\u001f]/.test(s)) return undefined
  return (s.startsWith("/") ? s : `/${s}`).slice(0, 300)
}

/** Recorded as someone else's: a share from a teammate (src/share/), whatever its kind. */
export const sharedFromElsewhere = (u: Url) => {
  const x = u as Url & { sharedBy?: string; sharedFrom?: string; from?: string; owner?: string; peer?: string }
  return !!(x.sharedBy || x.sharedFrom || x.from || x.owner || x.peer) || !["service", "preview", "pr", "output", "manual"].includes(u.source)
}

export function why(u: Url): string | undefined {
  if (sharedFromElsewhere(u)) return "someone else's share: captured only when the person asks for it"
  if (u.kind === "pr") return "a pull request, not the running thing"
  if (u.kind === "link") return "a link found in output; crosstalk never fetches those"
  if (u.kind === "local" && !isLocalHost(hostOf(u.url))) return "not on this machine"
  if (u.kind === "preview" && u.source !== "preview") return "not a preview shipping recorded"
  if (!u.alive) return "not answering"
  return undefined
}

/** The targets for a thread's URLs, with a path on each when one is given. */
export function plan(urls: Url[], o: { path?: string; max?: number } = {}): { targets: Target[]; skipped: Skipped[] } {
  const targets: Target[] = []
  const skipped: Skipped[] = []
  const seen = new Set<string>()
  const order = [...urls].sort((a, b) => Number(b.source === "service") - Number(a.source === "service") || Number(b.alive) - Number(a.alive) || b.lastSeen - a.lastSeen)
  for (const u of order) {
    const no = why(u)
    if (no) {
      skipped.push({ label: u.label, why: no })
      continue
    }
    const url = withPath(u.url, o.path)
    if (seen.has(url)) continue
    seen.add(url)
    if (targets.length >= (o.max ?? MAX_TARGETS)) {
      skipped.push({ label: u.label, why: "more than six at once" })
      continue
    }
    targets.push({ key: keyOf({ urlId: u.id, url: u.url, path: o.path }), url, label: u.label, urlId: u.id, ...(o.path ? { path: o.path } : {}), ...(u.worktree ? { worktree: u.worktree } : {}), ...(u.thread ? { thread: u.thread } : {}) })
  }
  return { targets, skipped }
}

/** One address the person named: any http(s) URL, captured because they asked. */
export function planUrl(url: string, o: { label?: string; known?: Url[]; path?: string } = {}): Target | undefined {
  if (!/^https?:\/\/[^\s\u0000-\u001f]+$/.test(url)) return undefined
  const rec = o.known?.find((u) => u.url === url || u.url.replace(/\/$/, "") === url.replace(/\/$/, ""))
  const full = withPath(url, o.path)
  return {
    key: keyOf({ urlId: rec?.id, url: rec?.url ?? url, path: o.path }),
    url: full,
    label: rec?.label ?? o.label ?? url.replace(/^https?:\/\//, "").slice(0, 60),
    ...(rec ? { urlId: rec.id } : {}),
    ...(o.path ? { path: o.path } : {}),
    ...(rec?.worktree ? { worktree: rec.worktree } : {}),
    ...(rec?.thread ? { thread: rec.thread } : {}),
  }
}
