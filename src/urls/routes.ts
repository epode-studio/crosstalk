// Names, not ports: which `*.localhost` name goes to which port (docs/urls.md).
// Pure; the proxy (proxy.ts) asks it on every connection.
//
//   <group>.localhost              the group's main service (a thread's name,
//                                  else its worktree's folder)
//   <service>.<group>.localhost    each of its services
//   <service>.localhost            a service whose name no other group uses
//                                  and that is no group's name
//
// The main service is the one named web, dev, app, frontend, site, ui or
// server, else the one started first.

export type Target = { group: string; service: string; port: number; root?: string; startedAt?: number }
export type Route = { host: string; port: number; group: string; service: string; root?: string; main: boolean }
export type Table = { routes: Route[]; byHost: Map<string, Route> }

const MAIN = ["web", "dev", "app", "frontend", "site", "ui", "server", "start"]

/** A DNS label: lower case letters, digits and hyphens, 63 at most. */
export const label = (s: string) =>
  s
    .toLowerCase()
    .replace(/[^a-z0-9-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 63)
    .replace(/-+$/, "")

export function buildTable(targets: Target[]): Table {
  const groups = new Map<string, Target[]>()
  for (const t of targets) {
    const g = label(t.group)
    const s = label(t.service)
    if (!g || !s || !(t.port > 0 && t.port < 65536)) continue
    groups.set(g, [...(groups.get(g) ?? []), { ...t, group: g, service: s }])
  }
  const routes: Route[] = []
  const byHost = new Map<string, Route>()
  const put = (r: Route) => {
    if (byHost.has(r.host)) return
    byHost.set(r.host, r)
    routes.push(r)
  }
  const mains = new Map<string, Target>()
  for (const [g, ts] of groups) {
    const rank = (t: Target) => {
      const i = MAIN.indexOf(t.service)
      return i === -1 ? MAIN.length : i
    }
    const main = [...ts].sort((a, b) => rank(a) - rank(b) || (a.startedAt ?? 0) - (b.startedAt ?? 0))[0]
    mains.set(g, main)
    put({ host: g, port: main.port, group: g, service: main.service, root: main.root, main: true })
  }
  for (const [g, ts] of groups) for (const t of ts) put({ host: `${t.service}.${g}`, port: t.port, group: g, service: t.service, root: t.root, main: mains.get(g) === t })
  // A bare service name, when only one group has a service of that name and no group is called that.
  const owners = new Map<string, Target[]>()
  for (const ts of groups.values()) for (const t of ts) owners.set(t.service, [...(owners.get(t.service) ?? []), t])
  for (const [s, ts] of owners) if (ts.length === 1 && !groups.has(s)) put({ host: s, port: ts[0].port, group: ts[0].group, service: s, root: ts[0].root, main: mains.get(ts[0].group) === ts[0] })
  return { routes, byHost }
}

/** `auth` out of a Host header of `auth.localhost:1355`; null for anything not under .localhost (bare `localhost` is ""). */
export function hostLabel(hostHeader: string | undefined): string | null {
  if (!hostHeader) return null
  let h = hostHeader.trim().toLowerCase()
  if (h.startsWith("[")) return null
  h = h.replace(/:\d+$/, "").replace(/\.$/, "")
  if (h === "localhost") return ""
  if (!h.endsWith(".localhost")) return null
  const sub = h.slice(0, -".localhost".length)
  return /^[a-z0-9-]+(\.[a-z0-9-]+)*$/.test(sub) ? sub : null
}

export const lookup = (t: Table, hostHeader: string | undefined): Route | undefined => {
  const l = hostLabel(hostHeader)
  return l ? t.byHost.get(l) : undefined
}

/** The URL a route is reached by through the proxy on `port`: no port in it on 80. */
export const proxyUrl = (host: string, port: number) => `http://${host}.localhost${port === 80 ? "" : `:${port}`}`

/** The name a group's service goes by: the group's own when it is the main one, else `<service>.<group>`. */
export function nameOf(t: Table, group: string, service: string): string | undefined {
  const g = label(group)
  const s = label(service)
  const rank = (r: Route) => (r.host === r.group ? 0 : r.host === `${r.service}.${r.group}` ? 1 : 2)
  return t.routes.filter((r) => r.group === g && r.service === s).sort((a, b) => rank(a) - rank(b))[0]?.host
}
