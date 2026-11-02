// Your sessions across your own machines.
//
// From the laptop, "what's running on my desk?" lists the desk's sessions,
// "resume the billing one on the desk" resumes it there, "close it" closes it
// there. Requests and answers are envelopes like any other over the sealed
// relay, of two kinds of their own: `sessions_req` and `sessions_res`.
//
// Who may ask. Only your own machines: a peer marked `own` by repository
// trust, that is, a machine whose statement is signed by a key on your own
// GitHub account (src/repotrust). Never another person, however trusted,
// never a bot, never through a room. Anyone else's sessions_req is answered
// with a refusal and logged. (A machine joined with `crosstalk link` is the
// same identity as this one, not a peer, so it is not addressed this way.)
//
// What a request may do on the machine it reaches:
//
//   list, find   answered at once.
//   resume,      raise a confirmation there when the person is at that machine
//   spawn        (typed in a session with the mod in the last few minutes);
//                otherwise go ahead, in crosstalk's background tmux, since
//                nobody's terminal is in front to open a tab in. Starting
//                compute on your own machine for you is what was asked.
//   close,       only ever with a yes there. Nobody at that machine means
//   background   refused: ending a session unattended, from afar, could lose
//                work nobody sees go.
//
// The asking side gates first, as any action does (control.ts gate): the
// person's pick in the mod or their own typed words. Every request is
// rate-limited per machine and every action is written to the target
// machine's digest.

import crypto from "node:crypto"
import fs from "node:fs"
import path from "node:path"
import type { Identity, Peer } from "../config.ts"
import type { Envelope } from "../protocol.ts"
import * as R from "../restore.ts"
import * as ui from "../uistate.ts"
import * as activity from "../attention/activity.ts"
import { isBot } from "../ui-extra/bots.ts"
import { readSpawned, spawnAgents } from "../spawn.ts"
import { repoKey, repoName, slug } from "../terminal/repo.ts"
import * as I from "./index.ts"
import * as C from "./control.ts"
import type { RemoteAct } from "./control.ts"

export type RemoteDeps = {
  identity: Identity
  machine: () => string
  peers: () => Record<string, Peer>
  send: (label: string, env: Envelope) => unknown
  log: (...a: unknown[]) => void
  /** A line in this machine's digest. */
  note: (id: string, text: string) => void
  /** This machine's open sessions, as crosstalk_sessions lists them. */
  listLocal: () => unknown[]
  /** Whether a session's mod is live, and registered sessions. */
  modLive: (sessionId: string) => boolean
  registered: () => Map<string, { sessionId: string; cwd: string; name: string }>
  /** How control.ts reaches the machine, from inside the daemon. */
  deps: () => C.Deps
  now?: () => number
}

type Req = { op: "list" } | { op: "find"; query: string } | { op: "act"; act: RemoteAct }
type Waiter = { peer: string; resolve: (v: any) => void; timer: ReturnType<typeof setTimeout> }

/** At most this many requests per machine per minute, and this many actions per ten minutes. */
export const LIMITS = { perMinute: 20, actsPer10Min: 6 }

/** Your own machine: repository trust says so, and it is a person's machine, not a bot. */
export const isOwn = (p: Peer | undefined): boolean => !!p && p.own === true && !p.isMachine

export class SessionsRemote {
  private waiting = new Map<string, Waiter>()
  private seen = new Map<string, number[]>()
  private acts = new Map<string, number[]>()
  constructor(private d: RemoteDeps) {}
  private now = () => (this.d.now ?? Date.now)()

  /** Your own machines, by label. */
  own(): Peer[] {
    return Object.values(this.d.peers()).filter(isOwn)
  }

  /** A machine by its name, its peer label, or the end of its label (`paul-desk` is `desk`). */
  machine(name: string): Peer | undefined {
    const n = name.trim().toLowerCase()
    const own = this.own()
    return own.find((p) => p.label.toLowerCase() === n) ?? own.find((p) => (p.machine ?? "").toLowerCase() === n) ?? own.find((p) => p.label.toLowerCase().endsWith(`-${n}`))
  }

  /** Under the limit: record it and say yes. */
  private allow(map: Map<string, number[]>, label: string, n: number, windowMs: number): boolean {
    const now = this.now()
    const list = (map.get(label) ?? []).filter((t) => now - t < windowMs)
    if (list.length >= n) {
      map.set(label, list)
      return false
    }
    list.push(now)
    map.set(label, list)
    return true
  }

  // --- asking ---------------------------------------------------------------------

  private ask(p: Peer, req: Req, timeoutMs: number): Promise<any> {
    const correlation = crypto.randomUUID()
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        this.waiting.delete(correlation)
        resolve({ ok: false, error: `${p.label} did not answer (is it on, with crosstalk running?)` })
      }, timeoutMs)
      this.waiting.set(correlation, { peer: p.label, resolve, timer })
      this.d.send(p.label, {
        v: 1,
        id: crypto.randomUUID(),
        ts: Date.now(),
        from: this.d.identity.label,
        fromSession: "-",
        to: p.label,
        kind: "sessions_req",
        intent: "fyi",
        text: "",
        correlation,
        sessions: req,
      })
    })
  }

  /** The daemon's `sessions_remote` op: from this machine's own session, to another of your machines. */
  async request(o: { machine?: string; req: Req }): Promise<any> {
    const timeout = Number(process.env.CROSSTALK_REMOTE_TIMEOUT_MS ?? (o.req.op === "act" ? 40_000 : 6000))
    if (!o.machine) {
      if (o.req.op === "act") return { ok: false, error: "say which machine" }
      const own = this.own()
      const all = await Promise.all(own.map(async (p) => ({ machine: p.machine ?? p.label, label: p.label, ...(await this.ask(p, o.req, timeout)) })))
      return { ok: true, machines: all }
    }
    const p = this.machine(o.machine)
    if (!p) {
      const others = Object.values(this.d.peers()).find((x) => x.label.toLowerCase() === o.machine!.toLowerCase())
      return {
        ok: false,
        error: others
          ? `${others.label} is not one of your own machines, so its sessions are not yours to see or act on.`
          : `no machine of yours called "${o.machine}".${this.own().length ? ` Yours: ${this.own().map((x) => x.machine ?? x.label).join(", ")}.` : " None of your other machines is known here yet."}`,
      }
    }
    const r = await this.ask(p, o.req, timeout)
    return { machine: p.machine ?? p.label, label: p.label, ...r }
  }

  // --- answering -----------------------------------------------------------------------

  /** A sessions frame. True when it was one. */
  accept(label: string, env: Envelope, inRoom: boolean): boolean {
    if (env.kind !== "sessions_req" && env.kind !== "sessions_res") return false
    if (env.kind === "sessions_res") {
      const w = env.correlation ? this.waiting.get(env.correlation) : undefined
      if (!w || w.peer !== label || inRoom) {
        this.d.log(`ignored a sessions answer from ${label}: nothing of theirs was waiting`)
        return true
      }
      this.waiting.delete(env.correlation!)
      clearTimeout(w.timer)
      w.resolve(env.sessions && typeof env.sessions === "object" ? env.sessions : { ok: false, error: "an empty answer" })
      return true
    }
    const peer = this.d.peers()[label]
    const reply = (body: unknown) =>
      this.d.send(label, { v: 1, id: crypto.randomUUID(), ts: Date.now(), from: this.d.identity.label, fromSession: "-", to: label, kind: "sessions_res", intent: "fyi", text: "", correlation: env.correlation, sessions: body })
    if (inRoom || !peer || isBot(label) || !isOwn(peer)) {
      this.d.log(`refused a sessions request from ${label}: ${inRoom ? "through a room" : !peer ? "not a peer" : isBot(label) ? "a bot" : "not one of your own machines"}`)
      if (peer && !inRoom && env.correlation) reply({ ok: false, error: `${this.d.machine()} only answers your own machines about its sessions.` })
      return true
    }
    if (!this.allow(this.seen, label, LIMITS.perMinute, 60_000)) {
      this.d.log(`rate-limited a sessions request from ${label}`)
      reply({ ok: false, error: `too many requests from ${label}; try again in a minute.` })
      return true
    }
    this.answer(label, env.sessions as Req)
      .then(reply)
      .catch((e) => reply({ ok: false, error: (e as Error).message }))
    return true
  }

  private async answer(label: string, req: Req): Promise<any> {
    const machine = this.d.machine()
    if (!req || typeof req !== "object") return { ok: false, error: "an empty request" }
    if (req.op === "list") return { ok: true, machine, sessions: this.d.listLocal() }
    if (req.op === "find") {
      const hits = I.find(String(req.query ?? ""), I.all({ env: this.d.deps().env }))
      return { ok: true, machine, hits: hits.map(({ past: p, score }) => ({ id: p.id, title: p.title, cwd: p.cwd, threads: p.threads, branch: p.branch, recap: p.recap, endedAt: p.endedAt, archived: !!p.archived, score })), text: I.describeHits(hits) }
    }
    if (req.op !== "act" || !req.act || typeof req.act !== "object") return { ok: false, error: "unknown request" }
    const a = clean(req.act)
    if (!a) return { ok: false, error: "a malformed action" }
    if (!this.allow(this.acts, label, LIMITS.actsPer10Min, 10 * 60_000)) {
      this.d.log(`rate-limited a remote ${a.kind} from ${label}`)
      return { ok: false, error: `too many actions from ${label} in ten minutes; nothing was done.` }
    }
    const what = C.describeRemote(a)
    const id = `remote:${crypto.randomBytes(4).toString("hex")}`
    const digest = (outcome: string) => this.d.note(id, `◢ crosstalk: ${label}, your machine, asked to ${what}: ${outcome}`)
    this.d.log(`remote ${a.kind} from ${label}: ${what}`)

    let local: C.Action
    if (a.kind === "spawn") {
      const cwd = this.folderFor(a.repo)
      if (!cwd.ok) {
        digest(`refused (${cwd.error})`)
        return { ok: false, error: cwd.error }
      }
      local = { kind: "spawn", task: a.task, name: a.name, count: a.count, cwd: cwd.cwd }
    } else if (a.kind === "resume") local = { kind: "resume", session: a.session }
    else if (a.kind === "close") local = { kind: "close", session: a.session, services: a.services === "stop" ? "stop" : "keep" }
    else local = { kind: "background", session: a.session }

    const here = this.personAt()
    if (here) {
      C.raise({ by: here.sessionId, cwd: here.cwd, action: local, question: `From ${label}: ${C.questionFor(local)}`, from: label })
      digest(`asked you in ${here.name}`)
      return { ok: true, pending: true, text: `◢ crosstalk: asked on ${machine}, in ${here.name}: nothing happens unless the person there says yes.` }
    }
    if (a.kind === "close" || a.kind === "background") {
      digest("refused: nobody was at this machine to say yes")
      return { ok: false, text: `◢ crosstalk: nobody is at ${machine} to say yes, and a session is never ended from afar without that. Nothing was done.` }
    }
    const d = this.d.deps()
    const out =
      local.kind === "resume"
        ? await C.resume(local.session, { cwd: d.env.HOME ?? "/", background: true, from: label }, d)
        : local.kind === "spawn"
          ? spawnAgents({ task: local.task, name: local.name, count: local.count, cwd: local.cwd, background: true, env: d.env, peer: label })
          : { ok: false, text: "nothing to do" }
    digest(out.ok ? `done, in the background (nobody was at this machine)` : `failed: ${out.text.replace(/^◢ crosstalk: /, "").split("\n")[0]}`)
    return { ok: out.ok, text: out.text.replace(/^◢ crosstalk: /, `◢ crosstalk on ${machine}: `) }
  }

  /** The person, if they are at this machine: the session they typed in last, recently, with its mod live. */
  personAt(): { sessionId: string; cwd: string; name: string } | null {
    const last = activity.lastTyped()
    if (!last || this.now() - last.at > activity.awayMinutes() * 60_000) return null
    const reg = this.d.registered().get(last.sessionId)
    if (!reg || !(this.d.modLive(last.sessionId) || ui.modActive(last.sessionId))) return null
    return { sessionId: reg.sessionId, cwd: reg.cwd, name: reg.name }
  }

  /**
   * The folder a remote spawn starts in: one this machine has had a session
   * in, named by its repository's name or its own. Never any path the other
   * side makes up.
   */
  folderFor(repo?: string): { ok: true; cwd: string } | { ok: false; error: string } {
    const known = new Map<string, string>()
    const add = (cwd?: string) => {
      if (!cwd || known.has(cwd)) return
      try {
        if (!fs.statSync(cwd).isDirectory()) return
      } catch {
        return
      }
      known.set(cwd, repoName(repoKey(cwd)))
    }
    for (const r of R.readAll()) add(r.cwd)
    for (const s of readSpawned()) if (!s.removedAt) add(s.repo)
    for (const p of Object.values(I.load()).slice(0, 200)) add(p.cwd)
    // Each repository once, by its main checkout when that is known.
    const repos = new Map<string, string>()
    for (const [cwd, name] of known) {
      const main = repoKey(cwd)
      if (!repos.has(name) || main === cwd) repos.set(name, known.has(main) ? main : cwd)
    }
    if (!repos.size) return { ok: false, error: `${this.d.machine()} has no repository it has had a session in yet` }
    const want = slug(repo ?? "")
    if (!want) {
      if (repos.size === 1) return { ok: true, cwd: [...repos.values()][0] }
      return { ok: false, error: `say which repository: ${[...repos.keys()].join(", ")}` }
    }
    const hit = repos.get(want) ?? [...known].find(([cwd]) => slug(path.basename(cwd)) === want)?.[0]
    return hit ? { ok: true, cwd: hit } : { ok: false, error: `no repository called ${repo} on ${this.d.machine()}: ${[...repos.keys()].join(", ")}` }
  }
}

/** Only the fields an action has, as strings, cut short. */
export function clean(a: any): RemoteAct | null {
  const s = (v: unknown, n = 200) => (typeof v === "string" ? v.slice(0, n) : "")
  switch (a?.kind) {
    case "close":
      return s(a.session) ? { kind: "close", session: s(a.session), services: a.services === "stop" ? "stop" : "keep" } : null
    case "background":
      return s(a.session) ? { kind: "background", session: s(a.session) } : null
    case "resume":
      return s(a.session) ? { kind: "resume", session: s(a.session) } : null
    case "spawn": {
      const task = s(a.task, 8000).trim()
      if (!task || /^\s*-/.test(task)) return null
      return { kind: "spawn", task, ...(s(a.name, 40) ? { name: s(a.name, 40) } : {}), ...(s(a.repo, 100) ? { repo: s(a.repo, 100) } : {}), ...(Number(a.count) > 0 ? { count: Math.min(8, Math.floor(Number(a.count))) } : {}) }
    }
    default:
      return null
  }
}
