// crosstalk notices problems by itself (docs/design/next-generation.md, "No
// commands": "Something broken: crosstalk notices and tells you, with the fix").
//
// At SessionStart, at most once a day per machine, a few cheap checks run. Only
// when one finds something broken does the person hear of it, once: as the
// mod's picker when the mod is there, else a systemMessage (seen by the person,
// never by the model). Nothing is said when all is well.
//
// The whole report is still `crosstalk doctor`, and crosstalk_doctor returns it
// when someone asks "is crosstalk OK?".

import fs from "node:fs"
import path from "node:path"
import { spawnSync } from "node:child_process"
import { P, identityUnreadable, loadIdentity, loadPeers, loadRelay } from "../config.ts"
import * as ui from "../uistate.ts"
import { cliArgv } from "./run.ts"

export type Problem = { key: string; what: string; fix: string }

export const FIX_IT = "Ask the agent to fix it"
export const NOT_NOW = "Not now"
export const DAY_MS = 24 * 60 * 60_000

const stateFile = () => path.join(P.root, "doctor-check.json")

export type Probe = {
  env: NodeJS.ProcessEnv
  root?: string
  /** Whether the relay answers, in at most a second and a half. */
  relayUp?: (url: string) => Promise<boolean>
}

export async function relayUp(url: string, ms = 1500): Promise<boolean> {
  try {
    const r = await fetch(`${url.replace(/^ws/, "http").replace(/\/ws$/, "")}/health`, { signal: AbortSignal.timeout(ms) })
    return r.ok
  } catch {
    return false
  }
}

/** The cheap checks: files, one environment variable, and the relay only when there is someone to reach. */
export async function quickProblems(o: Probe): Promise<Problem[]> {
  const out: Problem[] = []
  if (identityUnreadable())
    out.push({
      key: "identity",
      what: `your crosstalk identity file (${P.identity}) will not parse`,
      fix: "restore it from a backup; starting again makes you a new person to everyone you work with",
    })
  if (o.root && fs.existsSync(path.join(o.root, "bin", "crosstalk")) && !fs.existsSync(path.join(o.root, "dist", "cli.js")))
    out.push({ key: "dist", what: "crosstalk's installed files are incomplete (dist/ is missing)", fix: "reinstall the plugin: claude plugin update crosstalk" })
  const sock = o.env.CLAUDE_CODE_MESSAGING_SOCKET
  if (sock && !fs.existsSync(sock))
    out.push({ key: "socket", what: "this session's inbox socket is missing, so nothing can reach it", fix: "start a new session (a session started in bare mode binds none)" })
  const id = loadIdentity()
  if (id && Object.keys(loadPeers()).length) {
    const url = loadRelay().url
    if (!(await (o.relayUp ?? relayUp)(url)))
      out.push({
        key: "relay",
        what: `the relay (${url}) does not answer, so messages wait here instead of going out`,
        fix: "check the network; if a teammate hosts the relay, their machine has to be awake. Messages are kept and go when it is back",
      })
  }
  return out
}

/** One sentence the person reads: what is wrong and how to fix it. */
export function describeProblems(ps: Problem[]): string {
  if (ps.length === 1) return `crosstalk found a problem: ${ps[0].what}. To fix it: ${ps[0].fix}.`
  return `crosstalk found ${ps.length} problems: ${ps.map((p, i) => `(${i + 1}) ${p.what}; to fix it, ${p.fix}`).join(". ")}.`
}

type Seen = { at: number; keys?: string[] }

function readSeen(): Seen | null {
  try {
    return JSON.parse(fs.readFileSync(stateFile(), "utf8"))
  } catch {
    return null
  }
}

/**
 * At SessionStart: the checks, unless they ran less than a day ago. Returns a
 * systemMessage to show when the mod is not there; with the mod, the problem
 * is put in its store and nothing is returned.
 */
export async function atSessionStart(o: Probe & { sessionId: string; now?: number; mod?: boolean; everyMs?: number }): Promise<{ systemMessage?: string; problems: Problem[]; ran: boolean }> {
  const now = o.now ?? Date.now()
  const every = o.everyMs ?? Number(o.env.CROSSTALK_DOCTOR_EVERY_MS ?? DAY_MS)
  const seen = readSeen()
  if (seen && now - seen.at < every) return { problems: [], ran: false }
  const problems = await quickProblems(o)
  fs.mkdirSync(P.root, { recursive: true, mode: 0o700 })
  fs.writeFileSync(stateFile(), JSON.stringify({ at: now, keys: problems.map((p) => p.key) }), { mode: 0o600 })
  if (!problems.length) return { problems, ran: true }
  const text = describeProblems(problems)
  const mod = o.mod ?? ui.modActive(o.sessionId, now)
  if (mod) {
    try {
      ui.withStore((items, t) =>
        ui.upsert(items, { id: `doctor:${o.sessionId}:${now}`, kind: "doctor", sessionId: o.sessionId, question: text, options: [FIX_IT, NOT_NOW], text: problems.map((p) => p.key).join(","), ts: t }, t),
      )
      return { problems, ran: true }
    } catch {}
  }
  return { systemMessage: `◢ ${text} Say "is crosstalk OK?" for the whole report.`, problems, ran: true }
}

/** The mod's picker answered a doctor item: what to hand the agent, if anything. */
export function act(id: string, action: string, value: string | undefined) {
  const claim = ui.withStore((items, now) => ui.act(items, id, action === "raised" || action === "later" ? action : "answer", now, value))
  if (!claim.ok || action === "raised" || action === "later") return claim
  const it = claim.item
  if (value === FIX_IT)
    return {
      ok: true,
      item: it,
      prompt: `crosstalk says something is wrong. ${it.question ?? ""} Help me fix it; crosstalk_doctor has the whole report.`,
      text: "handed to the agent",
    }
  return { ok: true, item: it, text: `Left as it is. Say "is crosstalk OK?" any time.` }
}

/** The whole `crosstalk doctor` report, as text. */
export function fullReport(root: string, env: NodeJS.ProcessEnv = process.env): string {
  const [cmd, ...args] = cliArgv(root)
  const r = spawnSync(cmd, [...args, "doctor"], { encoding: "utf8", env, timeout: 60_000 })
  const out = `${r.stdout ?? ""}${r.stderr ?? ""}`.trim()
  return out || `crosstalk doctor did not answer${r.error ? `: ${r.error.message}` : ""}`
}
