// The daemon's side of the session manager: renaming a session and moving it
// between threads (the daemon owns sessions and threads), and requests to and
// from your other machines (remote.ts). daemon.ts makes one of these and calls
// handle() for ops it does not know, accept() for envelopes, and name() when a
// session registers again.

import type { Identity, Peer } from "../config.ts"
import type { Envelope } from "../protocol.ts"
import type { ThreadService } from "../threads/service.ts"
import * as N from "./names.ts"
import * as C from "./control.ts"
import { SessionsRemote } from "./remote.ts"

type Reg = { sessionId: string; name: string; cwd: string }

export type OpsDeps = {
  identity: Identity
  machine: () => string
  threads: ThreadService
  sessions: () => Map<string, Reg>
  peers: () => Record<string, Peer>
  send: (label: string, env: Envelope) => unknown
  log: (...a: unknown[]) => void
  note: (id: string, text: string) => void
  listLocal: () => unknown[]
  modLive: (sessionId: string) => boolean
  /** The daemon's own request handler, so control.ts asks it without a socket. */
  handle: (req: Record<string, unknown>) => Promise<any>
}

export function createSessionOps(d: OpsDeps) {
  const deps = (): C.Deps => ({ ...C.liveDeps(process.env), ask: (req) => d.handle(req) })
  const remote = new SessionsRemote({
    identity: d.identity,
    machine: d.machine,
    peers: d.peers,
    send: d.send,
    log: d.log,
    note: d.note,
    listLocal: d.listLocal,
    modLive: d.modLive,
    registered: d.sessions,
    deps,
  })

  /** What a session is called: the person's name for it wins over what it registers with. */
  const name = (sessionId: string, registered: string) => N.nameOf(sessionId) ?? registered

  async function handle(req: any): Promise<unknown> {
    switch (req?.op) {
      case "session_rename": {
        const sid = String(req.sessionId ?? "")
        const n = N.clean(String(req.name ?? ""))
        if (!sid || !n) return { ok: false, error: "say which session and what to call it" }
        N.setName(sid, n)
        const reg = d.sessions().get(sid)
        if (reg) reg.name = n
        // Its entry in each of its threads goes by the new name.
        const local = d.threads.local(sid)
        if (local) d.threads.observe({ ...local, name: n })
        d.log(`session ${sid.slice(0, 8)} renamed to ${n}`)
        return { ok: true, name: n, threads: d.threads.namesFor(sid), title: d.threads.title(sid, n) ?? n }
      }
      case "session_move": {
        const sid = String(req.sessionId ?? "")
        const want = String(req.thread ?? "").trim()
        if (!sid || !want) return { ok: false, error: "say which session and which thread" }
        const t = d.threads.find(sid, want)
        if (!t) return { ok: false, error: `no thread called "${want}". Threads: ${d.threads.list().map((x) => x.name).join(", ") || "none"}` }
        const r = d.threads.expect({ sessionId: sid, thread: t.id, why: "you moved it here" })
        if (!r.ok) return r
        // Registered already, and placed before: the person's choice pins it now.
        if (!d.threads.idsFor(sid).includes(t.id)) d.threads.answer(sid, t.meta.value.name)
        for (const other of d.threads.idsFor(sid)) if (other !== t.id) d.threads.leave(sid, other)
        d.log(`session ${sid.slice(0, 8)} moved to ${t.meta.value.name}`)
        return { ok: true, threads: d.threads.namesFor(sid) }
      }
      case "sessions_remote":
        return remote.request({ machine: req.machine ? String(req.machine) : undefined, req: req.req })
      default:
        return undefined
    }
  }

  return { handle, accept: (label: string, env: Envelope, inRoom: boolean) => remote.accept(label, env, inRoom), name, remote }
}
