// What the session manager needs from "services that outlive sessions"
// (src/services*, built separately): which of a session's own processes are
// still running (a dev server, a watcher), and stopping them. Closing a
// session keeps them by default and says so; "and stop its services" stops
// them. Sending a session to the background never touches them.
//
// Nothing here knows how services are started or found. Until the services
// build registers itself with setServices, a session has none, and closing it
// says nothing about services.
//
// MERGE NOTE: the services build calls setServices({ running, stop }) once,
// where its module loads (it is imported by src/server.ts, src/uicli.ts and
// src/daemon.ts, which is where close runs), and nothing else in this folder
// changes.

export type Service = { name: string; pid?: number; port?: number }

export type ServicesPort = {
  /** What is running for this session (by id) or its folder (its worktree). */
  running(o: { sessionId: string; cwd: string }): Service[]
  /** Stop them, gracefully. Resolves to the names stopped. */
  stop(o: { sessionId: string; cwd: string }): Promise<string[]>
}

const none: ServicesPort = { running: () => [], stop: async () => [] }
let port: ServicesPort = none

export const setServices = (p: ServicesPort | null) => void (port = p ?? none)
export const services = (): ServicesPort => port

/** Its services, never throwing: a broken services module does not stop a close. */
export function runningFor(o: { sessionId: string; cwd: string }): Service[] {
  try {
    return port.running(o) ?? []
  } catch {
    return []
  }
}

/** " Its dev server keeps running." / " Its dev server and worker stop too." / "" */
export function keepsLine(list: Service[], stop: boolean): string {
  if (!list.length) return ""
  const names = list.map((s) => s.name)
  const what = names.length === 1 ? names[0] : `${names.slice(0, -1).join(", ")} and ${names[names.length - 1]}`
  return stop ? ` Its ${what} ${names.length === 1 ? "stops" : "stop"} too.` : ` Its ${what} ${names.length === 1 ? "keeps" : "keep"} running.`
}
