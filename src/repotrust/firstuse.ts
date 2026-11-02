// First use, per repository: trust through the repo starts with a yes.
//
// Publishing a statement puts this machine's public key and the person's
// GitHub login on a hidden ref in the repo, which everyone with read access
// can see. So in a GitHub repo where this machine has not published yet, the
// first interactive session asks, once per repo:
//
//   "Connect with your team in <repo>? This publishes your public key and
//    GitHub login on a hidden ref in this repo."   Connect / Not in this repo
//
// Yes creates an identity when there is none (a machine with no identity used
// to do nothing at all here), starts the daemon, publishes and syncs. No is
// remembered for that repo and it is never asked there again. Nothing is
// pushed before a yes: sync (index.ts) does nothing for a repo without one.
//
// The question is the mod's picker when the mod is in the session, otherwise
// a systemMessage answered in plain words through crosstalk_people action "connect".
// CROSSTALK_NO_REPOTRUST=1 turns all of it off; CROSSTALK_REPOTRUST_AUTO=1 is
// a standing yes (tests, and machines set up by hand).

import fs from "node:fs"
import path from "node:path"
import { ROOT, loadIdentity, saveIdentity } from "../config.ts"
import { newIdentity } from "../crypto.ts"
import { machineName, userName } from "../net.ts"
import * as ui from "../uistate.ts"
import { findRepo } from "./gitref.ts"
import { ownLogin } from "./github.ts"

export const CONNECT = "Connect"
export const NOT_HERE = "Not in this repo"

type Entry = { state: "asked" | "yes" | "no"; at: number; session?: string; cwd?: string }
type State = { v: 1; repos: Record<string, Entry> }

const FILE = () => path.join(ROOT, "repotrust", "firstuse.json")

export function load(): State {
  try {
    const s = JSON.parse(fs.readFileSync(FILE(), "utf8"))
    if (s?.v === 1 && s.repos) return s
  } catch {}
  return { v: 1, repos: {} }
}

function save(s: State) {
  fs.mkdirSync(path.dirname(FILE()), { recursive: true, mode: 0o700 })
  const tmp = `${FILE()}.${process.pid}.tmp`
  fs.writeFileSync(tmp, JSON.stringify(s, null, 2), { mode: 0o600 })
  fs.renameSync(tmp, FILE())
}

const off = () => process.env.CROSSTALK_NO_REPOTRUST === "1"

/** Whether this machine published in this repo before first use was asked: that was a yes already. */
function publishedBefore(slug: string): boolean {
  try {
    const s = JSON.parse(fs.readFileSync(path.join(ROOT, "repotrust", "state.json"), "utf8"))
    return !!s?.repos?.[slug]?.ownPublished
  } catch {
    return false
  }
}

/** What the person said for this repo: yes, no, or nothing yet. */
export function consent(slug: string, s = load()): "yes" | "no" | undefined {
  if (process.env.CROSSTALK_REPOTRUST_AUTO === "1") return "yes"
  const e = s.repos[slug]
  if (e?.state === "yes" || e?.state === "no") return e.state
  return publishedBefore(slug) ? "yes" : undefined
}

/** Sync may touch the network for this repo. */
export const allowed = (slug: string) => !off() && consent(slug) === "yes"

export const connectId = (slug: string) => `connect:${slug}`

export const questionText = (slug: string) =>
  `Connect with your team in ${slug}? This publishes your public key and GitHub login on a hidden ref in this repo.`

/**
 * The first-use question for a session starting in `cwd`, at most once per
 * repo across every session: null when there is nothing to ask.
 */
export async function offer(cwd: string, sessionId: string, now = Date.now()): Promise<{ slug: string; question: string } | null> {
  if (off() || !cwd) return null
  const repo = await findRepo(cwd).catch(() => null)
  if (!repo) return null
  const s = load()
  if (consent(repo.slug, s) || s.repos[repo.slug]) return null
  s.repos[repo.slug] = { state: "asked", at: now, session: sessionId, cwd: repo.top }
  save(s)
  return { slug: repo.slug, question: questionText(repo.slug) }
}

/** Where the question goes: the mod's picker, else a systemMessage. Exactly one. */
export async function surface(cwd: string, sessionId: string, mod = ui.modActive(sessionId)): Promise<{ systemMessage?: string; item?: ui.UiItem }> {
  const o = await offer(cwd, sessionId)
  if (!o) return {}
  const text = `◢ crosstalk: ${o.question} Say "connect me" to go ahead, or "not in this repo" and you will not be asked here again.`
  if (!mod) return { systemMessage: text }
  try {
    return {
      item: ui.withStore((items, now) =>
        ui.upsert(items, { id: connectId(o.slug), kind: "connect", sessionId, thread: o.slug, question: o.question, options: [CONNECT, NOT_HERE], ts: now }, now),
      ),
    }
  } catch {
    return { systemMessage: text }
  }
}

/** Repos asked about and not answered, newest first: what "connect me" with no repo named means. */
export function openAsks(s = load()): string[] {
  return Object.entries(s.repos)
    .filter(([, e]) => e.state === "asked")
    .sort((a, b) => b[1].at - a[1].at)
    .map(([slug]) => slug)
}

/**
 * The person's answer. Yes: an identity when there is none, then the caller
 * starts the daemon and syncs (connect()). Recorded either way, for good.
 */
export async function record(slug: string, yes: boolean, now = Date.now()): Promise<{ ok: boolean; text: string; created?: string }> {
  const s = load()
  s.repos[slug] = { ...s.repos[slug], state: yes ? "yes" : "no", at: now }
  save(s)
  try {
    ui.withStore((items, t) => ui.settle(items, connectId(slug), "answered", t))
  } catch {}
  if (!yes) return { ok: true, text: `Not connecting in ${slug}. You will not be asked there again.` }
  let created: string | undefined
  if (!loadIdentity()) {
    const login = await ownLogin().catch(() => null)
    const label = login ?? userName()
    saveIdentity({ ...newIdentity(label), machine: machineName() })
    created = label
  }
  return { ok: true, text: `Connecting in ${slug}.`, created }
}

/**
 * Everything a yes sets off: recorded, an identity, the daemon, and a sync
 * that publishes. Used by `crosstalk ui act` and crosstalk_people action "connect".
 */
export async function connect(o: {
  cwd?: string
  slug?: string
  yes: boolean
  ensureDaemon: () => Promise<boolean>
  request: (req: Record<string, unknown>, timeoutMs?: number) => Promise<any>
}): Promise<{ ok: boolean; text: string }> {
  if (off()) return { ok: false, text: "Trust through the repository is turned off on this machine (CROSSTALK_NO_REPOTRUST)." }
  let slug = o.slug
  let cwd = o.cwd
  if (!slug && cwd) slug = (await findRepo(cwd).catch(() => null))?.slug
  slug ??= openAsks()[0]
  if (!slug) return { ok: false, text: "This is not a git repository with a GitHub remote, so there is nobody to connect with here." }
  const r = await record(slug, o.yes)
  if (!o.yes) return r
  // The folder the question was asked in, when the answer came without one.
  cwd ??= load().repos[slug]?.cwd
  const up = await o.ensureDaemon()
  if (!up) return { ok: false, text: `${r.created ? `Made you "${r.created}" on this machine. ` : ""}Connected in ${slug}, but the crosstalk daemon did not start, so nothing is published yet.` }
  const synced = cwd ? await o.request({ op: "team", cwd, refresh: true }, 90_000).catch(() => null) : null
  const own = synced?.synced?.own ?? synced?.you
  return {
    ok: true,
    text: `${r.created ? `Made you "${r.created}" on this machine. ` : ""}Connected in ${slug}${own ? `: ${own}` : ""}.`,
  }
}
