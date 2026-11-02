// URL tracking's front door (docs/urls.md): the store with threads wired in,
// and what feeds it.
//
//   urls()                the store (store.ts), knowing the thread of a
//                         session (threads.json's placements) or of a worktree
//                         (the sessions and services in it)
//   syncServices()        crosstalk services' ports → local URLs, by service
//   recordPreview/Pr()    shipping's previews and PRs (src/shipping/engine.ts)
//   collectFromOutput()   links a Bash command printed (src/hook.ts PostToolUse)
//   targets()             running services, for the proxy's names
//   badge()               `auth.localhost:1355` for the tab, when the proxy is up
//   shownUrl()            the URL to show or open: the proxy's name for a local
//                         service while the proxy is up, else the URL itself
//
// Later builds (sharing, screenshots, self-healing, history) take records from
// here: `urls().forThread("auth")`, `urls().forSession({ sessionId, worktree })`.

import path from "node:path"
import { loadRegistered } from "../config.ts"
import * as Svc from "../services/service.ts"
import * as Pt from "../services/ports.ts"
import { readThreads, type ThreadState } from "../ui-extra/threadfile.ts"
import { UrlStore, type Url } from "./store.ts"
import { extractUrls, labelFor } from "./extract.ts"
import { label as dnsLabel, proxyUrl, type Route, type Target } from "./routes.ts"
import { readState, type ProxyState } from "./proxy.ts"

export * from "./store.ts"

// --- threads ----------------------------------------------------------------------

let threadsMemo: { at: number; st: ThreadState } | null = null
/** threads.json, read at most once a second. */
function threads(): ThreadState {
  const now = Date.now()
  if (!threadsMemo || now - threadsMemo.at > 1000) threadsMemo = { at: now, st: readThreads() }
  return threadsMemo.st
}

/** A session's first thread, by name. */
export function threadOfSession(sessionId: string | undefined, st: ThreadState = threads()): string | undefined {
  if (!sessionId) return undefined
  for (const id of st.placed[sessionId]?.threads ?? []) {
    let t = st.threads[id]
    for (let i = 0; t && t.meta.value.combinedInto && i < 10; i++) t = st.threads[t.meta.value.combinedInto]
    if (t) return t.meta.value.name
  }
  return undefined
}

const roots = new Map<string, string>()
/** A folder's worktree (its git top folder), remembered for the life of this process. */
export function rootOf(cwd: string): string {
  const hit = roots.get(cwd)
  if (hit) return hit
  const r = Pt.rootOf(cwd)
  roots.set(cwd, r)
  return r
}

/** The thread of a worktree: of a session in it, or of the session that started a service there. */
export function threadOfRoot(root: string | undefined, st: ThreadState = threads()): string | undefined {
  if (!root) return undefined
  const ids: string[] = []
  try {
    for (const s of Svc.readAll()) if (s.root === root && s.by) ids.push(s.by)
  } catch {}
  try {
    for (const [sid, reg] of Object.entries(loadRegistered())) if (reg?.cwd && (reg.cwd === root || rootOf(reg.cwd) === root)) ids.push(sid)
  } catch {}
  for (const sid of ids) {
    const t = threadOfSession(sid, st)
    if (t) return t
  }
  return undefined
}

/** What a worktree's URLs are grouped and named by: its thread, else its folder's name. */
export const groupFor = (root: string, st?: ThreadState) => threadOfRoot(root, st) ?? (dnsLabel(path.basename(root)) || "local")

/** The store, with threads wired in. */
export const urls = (o: { file?: string; now?: () => number } = {}) =>
  new UrlStore({
    ...o,
    threadOf: (u) => threadOfSession(u.sessionId) ?? threadOfRoot(u.worktree),
  })

// --- the proxy's names ------------------------------------------------------------------

const extra: (() => Target[])[] = []
/** More names for the proxy, from another part of the daemon: servers shared with this machine (src/share/). */
export const addTargets = (fn: () => Target[]) => void extra.push(fn)
const changed: (() => void)[] = []
/** The proxy, to hear that the names changed (it reads them again at once). */
export const onTargetsChanged = (fn: () => void) => void changed.push(fn)
/** Names changed now (a share given here started or ended): the proxy reads them again, not at its next poll. */
export function targetsChanged() {
  for (const fn of changed)
    try {
      fn()
    } catch {}
}

/** Running services, for the proxy: cheap (no port lookup; the ports last seen, else the PORT given). */
export function targets(): Target[] {
  const st = threads()
  const more = extra.flatMap((fn) => {
    try {
      return fn()
    } catch {
      return []
    }
  })
  return [...Svc.running().map((s) => ({ group: groupFor(s.root, st), service: s.name, port: s.ports?.[0] ?? s.port, root: s.root, startedAt: s.startedAt })), ...more]
}

/** How good a name a route is: the group's own (`auth`), then `web.auth`, then a bare service name. */
const rank = (r: Route) => (r.host === r.group ? 0 : r.host === `${r.service}.${r.group}` ? 1 : 2)

/** The proxy's name for a worktree's service: the group's own name when it is the main one, else `<service>.<group>`. */
export function nameFor(routes: Route[], root: string, service: string): string | undefined {
  const s = dnsLabel(service)
  return routes.filter((r) => r.root === root && r.service === s).sort((a, b) => rank(a) - rank(b))[0]?.host
}

/** The URL to show for a record: the proxy's name while it is up, else its own. */
export function shownUrl(u: Pick<Url, "url" | "name" | "kind">, state: ProxyState | null = readState()): string {
  return (u.kind === "local" || u.kind === "shared") && u.name && state ? proxyUrl(u.name.replace(/\.localhost$/, ""), state.port) : u.url
}

/**
 * `auth.localhost:1355` (no port on 80): the name of the worktree's main
 * service, for the tab and the status line, while the proxy is up and
 * something runs there. Undefined otherwise, and the ports are shown instead.
 */
export function badge(root: string, state: ProxyState | null = readState()): string | undefined {
  if (!state) return undefined
  const mine = state.routes.filter((r) => r.root === root)
  if (!mine.length) return undefined
  const best = [...mine].sort((a, b) => Number(b.main) - Number(a.main) || rank(a) - rank(b))[0]
  return `${best.host}.localhost${state.port === 80 ? "" : `:${state.port}`}`
}

// --- what feeds the store ---------------------------------------------------------------

/**
 * crosstalk services → local URLs: one record per service, its URL following
 * its port; a service that is not running any more is marked dead. With
 * `ports`, the listening ports are looked up again (ss or lsof).
 */
export function syncServices(o: { store?: UrlStore; ports?: boolean; state?: ProxyState | null } = {}): number {
  const store = o.store ?? urls()
  const state = o.state === undefined ? readState() : o.state
  const st = threads()
  const live = Svc.list({ ports: o.ports ?? false })
  const have = new Map(store.read().map((u) => [u.id, u]))
  let n = 0
  for (const s of live) {
    const id = `svc:${s.id}`
    if (s.state !== "running") {
      if (have.get(id)?.alive) store.markDead(id)
      continue
    }
    const port = s.listening[0] ?? s.ports?.[0] ?? s.port
    if (!port) continue
    const group = groupFor(s.root, st)
    const name = state ? nameFor(state.routes, s.root, s.name) : undefined
    const thread = threadOfRoot(s.root, st)
    store.add({
      id,
      url: `http://localhost:${port}`,
      kind: "local",
      source: "service",
      label: labelFor({ kind: "local", group, service: s.name, url: "" }),
      worktree: s.root,
      service: s.name,
      ...(thread ? { thread } : {}),
      ...(s.by ? { sessionId: s.by } : {}),
      ...(name ? { name: `${name}.localhost` } : {}),
    })
    n++
  }
  // A record whose service is gone altogether.
  for (const u of have.values()) if (u.source === "service" && u.alive && !live.some((s) => `svc:${s.id}` === u.id)) store.markDead(u.id)
  return n
}

/** A shipping preview: `auth · preview`; one record per thread and feature, its URL following each deploy. */
export function recordPreview(o: { thread: string; feature: string; url?: string; ok?: boolean; down?: boolean; worktree?: string; store?: UrlStore }) {
  if (!o.url || !/^https?:\/\//.test(o.url)) return undefined
  const store = o.store ?? urls()
  const id = `preview:${o.thread}:${o.feature}`
  if (o.down) return store.markDead(id)
  return store.add({
    id,
    url: o.url,
    kind: "preview",
    source: "preview",
    label: labelFor({ kind: "preview", group: o.thread, feature: o.feature, url: o.url }),
    thread: o.thread,
    feature: o.feature,
    ...(o.worktree ? { worktree: o.worktree } : {}),
  })
}

/** A pull request: `auth · PR #12`. */
export function recordPr(o: { thread: string; feature?: string; url?: string; worktree?: string; store?: UrlStore }) {
  if (!o.url || !/^https?:\/\//.test(o.url)) return undefined
  const store = o.store ?? urls()
  return store.add({
    id: `pr:${o.url}`,
    url: o.url,
    kind: "pr",
    source: "pr",
    label: labelFor({ kind: "pr", group: o.thread, url: o.url }),
    thread: o.thread,
    ...(o.feature ? { feature: o.feature } : {}),
    ...(o.worktree ? { worktree: o.worktree } : {}),
  })
}

/**
 * Links a command printed, as data: local ones (`auth · :5173`), PRs, and
 * other links, with credentials taken out and the noise of installs left out.
 * A localhost URL on a crosstalk service's port is that service's already.
 * Nothing is fetched here.
 */
export function collectFromOutput(o: { sessionId: string; cwd: string; text: string; store?: UrlStore }): Url[] {
  if (!/https?:\/\//i.test(o.text)) return []
  const found = extractUrls(o.text)
  if (!found.length) return []
  const store = o.store ?? urls()
  const root = rootOf(o.cwd)
  const st = threads()
  const thread = threadOfSession(o.sessionId, st) ?? threadOfRoot(root, st)
  const group = thread ?? (dnsLabel(path.basename(root)) || undefined)
  const svcPorts = new Set<number>()
  try {
    for (const s of Svc.readAll()) if (!s.stoppedAt && s.root === root) for (const p of [s.port, ...(s.ports ?? [])]) svcPorts.add(p)
  } catch {}
  const out: Url[] = []
  for (const f of found) {
    if (f.kind === "local" && f.port && svcPorts.has(f.port) && /^(localhost|127\.0\.0\.1|\[::1\])$/.test(f.host)) continue
    out.push(
      store.add({
        ...(f.kind === "pr" ? { id: `pr:${f.url}` } : {}),
        url: f.url,
        kind: f.kind,
        source: "output",
        label: labelFor({ kind: f.kind, group, url: f.url }),
        sessionId: o.sessionId,
        worktree: root,
        ...(thread ? { thread } : {}),
      }),
    )
  }
  return out
}

/** What the hook hands over at PostToolUse: a Bash call's output, from whichever field the client put it in. */
export function outputOf(hook: any): string {
  const tool = String(hook?.tool_name ?? hook?.toolName ?? "")
  if (tool !== "Bash") return ""
  const r = hook?.tool_response ?? hook?.toolResponse ?? hook?.tool_output
  if (typeof r === "string") return r.slice(0, 256 * 1024)
  if (r && typeof r === "object") return [r.stdout, r.stderr, r.output].filter((x) => typeof x === "string").join("\n").slice(0, 256 * 1024)
  return ""
}
