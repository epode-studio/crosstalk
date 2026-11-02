// Trust through repository access, with no words.
//
// For a repository with a GitHub remote, the daemon:
//
//   1. signs a statement binding this machine's crosstalk key to your GitHub
//      login with the SSH key you push with, and pushes it to
//      refs/crosstalk/keys/<login>/<machine>;
//   2. fetches everyone else's statements from the same refs, and the keys
//      GitHub lists for each of them;
//   3. verifies each with ssh-keygen, decides who is trusted (decide.ts), and
//      makes each one a peer, so a sealed channel exists through the relay
//      with nobody typing anything;
//   4. turns anything that changed into a question for you.
//
// Your own machines are statements signed by a key on your own account: the
// same person, several crosstalk identities, each reachable.
//
// State lives in <crosstalk home>/repotrust/state.json. Peers it adds are
// marked `via: "repo"`, and it never touches a peer you verified with words.

import fs from "node:fs"
import path from "node:path"
import { ROOT, loadIdentity, loadPeers, savePeers, type Identity, type Peer } from "../config.ts"
import { fingerprint as fingerprintOf } from "../crypto.ts"
import { machineName } from "../net.ts"
import * as ui from "../uistate.ts"
import { answer as applyAnswer, decide, memberKey, type Member, type Pins, type Question, type Seen } from "./decide.ts"
import { collaborators, keysFor, ownLogin, signingKey } from "./github.ts"
import { fetchStatements, findRepo, ensureRefspec, listStatements, publish, type Repo } from "./gitref.ts"
import { canonical, cleanMachine, keyHint, makeStatement, parse, sign, verify } from "./statement.ts"
import * as firstuse from "./firstuse.ts"

const DIR = () => path.join(ROOT, "repotrust")
const FILE = () => path.join(DIR(), "state.json")

type RepoState = {
  slug: string
  top: string
  remote: string
  members: Record<string, Member>
  lastSync?: number
  lastError?: string
  /** What became of this machine's own statement here, in words. */
  own?: string
  ownPublished?: boolean
  invalid?: { ref: string; why: string }[]
}

export type OpenQuestion = Question & { repo: string; at: number; announced?: boolean }

type Event = { at: number; text: string }

type State = {
  v: 1
  pins: Pins
  repos: Record<string, RepoState>
  questions: Record<string, OpenQuestion>
  /** This machine's signed statement, reused until the identity or login changes. */
  signed?: { login: string; machine: string; fingerprint: string; text: string; sig: string }
  events: Event[]
}

const empty = (): State => ({ v: 1, pins: {}, repos: {}, questions: {}, events: [] })

export function load(): State {
  try {
    const s = JSON.parse(fs.readFileSync(FILE(), "utf8"))
    if (s && s.v === 1) return { ...empty(), ...s }
  } catch {}
  return empty()
}

function save(s: State) {
  fs.mkdirSync(DIR(), { recursive: true, mode: 0o700 })
  s.events = s.events.slice(-50)
  const tmp = `${FILE()}.${process.pid}.tmp`
  fs.writeFileSync(tmp, JSON.stringify(s, null, 2), { mode: 0o600 })
  fs.renameSync(tmp, FILE())
}

const event = (s: State, text: string) => s.events.push({ at: Date.now(), text })

export const thisMachine = (id: Identity) => cleanMachine(process.env.CROSSTALK_MACHINE ?? id.machine ?? machineName())

const minMs = () => Number(process.env.CROSSTALK_REPOTRUST_MIN_MS ?? 10 * 60 * 1000)

// --- peers -------------------------------------------------------------------------

/**
 * Bring peers.json in line with everyone trusted through any repository.
 *
 * A collaborator is called by their login; a second machine of theirs, and
 * every machine of yours, is <login>-<machine>. Names are kept once given, and
 * a name already taken by someone else takes a suffix, as joining a room does.
 */
export function applyPeers(s: State, id: Identity, myLogin: string | null): { added: string[]; removed: string[] } {
  const me = fingerprintOf(id.ed.pub)
  const desired = new Map<string, { m: Member; repos: string[] }>()
  for (const r of Object.values(s.repos))
    for (const m of Object.values(r.members)) {
      if (m.fingerprint === me) continue
      const d = desired.get(m.fingerprint)
      if (d) d.repos.push(r.slug)
      else desired.set(m.fingerprint, { m, repos: [r.slug] })
    }

  const peers = loadPeers()
  const before = JSON.stringify(peers)
  const added: string[] = []
  const removed: string[] = []
  for (const [label, p] of Object.entries(peers)) {
    if (p.via !== "repo") continue
    const d = desired.get(p.fingerprint)
    if (!d) {
      delete peers[label]
      removed.push(label)
      continue
    }
    peers[label] = { ...p, edPub: d.m.edPub, xPub: d.m.xPub, repos: d.repos.sort() }
  }
  const byFp = new Set(Object.values(peers).map((p) => p.fingerprint))
  const taken = (name: string) => !!peers[name]
  // Oldest first, so a person's first machine is the one called by their login.
  const since = (m: Member) => s.pins[m.login]?.machines[m.machine]?.created ?? Number.MAX_SAFE_INTEGER
  const order = [...desired].sort(([, a], [, b]) => since(a.m) - since(b.m) || a.m.machine.localeCompare(b.m.machine))
  for (const [fp, { m, repos }] of order) {
    if (byFp.has(fp)) continue // already a peer: by repo, or verified with words
    const own = !!myLogin && m.login === myLogin
    let label = own ? `${m.login}-${m.machine}` : m.login
    if (taken(label)) label = `${m.login}-${m.machine}`
    if (taken(label)) {
      let i = 2
      while (taken(`${m.login}-${m.machine}-${i}`)) i++
      label = `${m.login}-${m.machine}-${i}`
    }
    const p: Peer = {
      label,
      edPub: m.edPub,
      xPub: m.xPub,
      fingerprint: fp,
      joinedAt: Date.now(),
      machine: m.machine,
      via: "repo",
      person: m.login,
      repos: repos.sort(),
      ...(own ? { own: true } : {}),
    }
    peers[label] = p
    byFp.add(fp)
    added.push(label)
  }
  // Only a real change is written, so this never races a room join for nothing.
  if (JSON.stringify(peers) !== before) savePeers(peers)
  return { added, removed }
}

/**
 * The other machines of the person a peer is: a message to marie reaches
 * whichever of her machines she is at, the way one linked identity did.
 */
export function siblings(label: string, peers = loadPeers()): string[] {
  const p = peers[label]
  if (!p || p.via !== "repo" || !p.person) return []
  return Object.values(peers)
    .filter((o) => o.via === "repo" && o.person === p.person && o.fingerprint !== p.fingerprint)
    .map((o) => o.label)
}

// --- sync --------------------------------------------------------------------------

let chain: Promise<unknown> = Promise.resolve()

export type SyncResult = {
  ok: boolean
  repo?: string
  skipped?: string
  trusted?: string[]
  questions?: string[]
  revoked?: string[]
  own?: string
  error?: string
}

/** One sync of the repository `cwd` is in. Serialised: two never run at once. */
export function sync(cwd: string, o: { force?: boolean; log?: (...a: unknown[]) => void } = {}): Promise<SyncResult> {
  const next = chain.then(() => syncNow(cwd, o)).catch((e) => ({ ok: false, error: (e as Error).message }))
  chain = next
  return next as Promise<SyncResult>
}

async function syncNow(cwd: string, o: { force?: boolean; log?: (...a: unknown[]) => void }): Promise<SyncResult> {
  const log = o.log ?? (() => {})
  const id = loadIdentity()
  if (!id) return { ok: false, skipped: "no crosstalk identity on this machine yet" }
  const repo = await findRepo(cwd)
  if (!repo) return { ok: false, skipped: "not in a git repository with a GitHub remote" }
  // Nothing is fetched or pushed in a repo the person has not said yes to (firstuse.ts).
  if (!firstuse.allowed(repo.slug)) return { ok: true, repo: repo.slug, skipped: `not connected in ${repo.slug}: first use asks once` }

  let s = load()
  const prev = s.repos[repo.slug]
  if (!o.force && prev?.lastSync && Date.now() - prev.lastSync < minMs()) return { ok: true, repo: repo.slug, skipped: "synced recently" }

  const rs: RepoState = { slug: repo.slug, top: repo.top, remote: repo.remote, members: prev?.members ?? {} }
  const me = fingerprintOf(id.ed.pub)
  const machine = thisMachine(id)
  const login = await ownLogin(repo.top)

  await ensureRefspec(repo)
  const fetched = await fetchStatements(repo)
  if (!fetched.ok) {
    rs.lastError = `could not fetch from ${repo.remote}: ${fetched.error}`
    log(`repotrust ${repo.slug}: ${rs.lastError}`)
  }
  const { found, skipped } = await listStatements(repo)

  const logins = new Set<string>([...found.map((f) => f.login), ...Object.values(rs.members).map((m) => m.login)])
  if (login) logins.add(login)
  const keys: Record<string, { keys: string[]; fresh: boolean } | undefined> = {}
  for (const l of logins) {
    const k = await keysFor(l)
    if (k.set && (k.set.fetchedAt > 0 || k.fresh)) keys[l] = { keys: k.set.keys, fresh: k.fresh }
    if (k.error && !k.fresh) log(`repotrust: keys for ${l}: ${k.error}`)
  }

  // This machine's own statement.
  let signedHere: State["signed"]
  if (!login) rs.own = "no GitHub login known here, so this machine is not published; the four words still work"
  else {
    const mine = keys[login]?.keys ?? []
    let signed = s.signed && s.signed.fingerprint === me && s.signed.login === login && s.signed.machine === machine ? s.signed : undefined
    if (signed && !(await verify({ login, machine, text: signed.text, sig: signed.sig, keys: mine })).ok) signed = undefined
    if (!signed) {
      const k = await signingKey(mine, path.join(DIR(), "tmp"))
      if (!k.key) rs.own = `not published: ${k.why}; the four words still work`
      else {
        const st = makeStatement({ login, machine, edPub: id.ed.pub, xPub: id.x.pub })
        const r = await sign(st, k.key)
        if (!r.ok) rs.own = `not published: ${r.reason}; the four words still work`
        else signed = { login, machine, fingerprint: me, text: canonical(st), sig: r.sig }
      }
    }
    if (signed) {
      signedHere = signed
      const there = found.find((f) => f.login === login && f.machine === machine)
      if (there && there.text === signed.text && there.sig === signed.sig) {
        rs.own = `published as ${login} on ${machine}`
        rs.ownPublished = true
      } else if (!fetched.ok) rs.own = `signed as ${login} on ${machine}, waiting to reach ${repo.remote}`
      else {
        const p = await publish(repo, login, machine, signed.text, signed.sig)
        rs.own = p.ok ? `published as ${login} on ${machine}` : `signed, but could not push it: ${p.error}`
        rs.ownPublished = p.ok
        if (p.ok) log(`repotrust ${repo.slug}: published this machine as ${login}/${machine}`)
      }
    }
  }

  // Everyone's statements, checked.
  const seen: Seen[] = []
  const invalid: { ref: string; why: string }[] = skipped.map((ref) => ({ ref, why: "not a well formed statement" }))
  for (const f of found) {
    const ref = `${f.login}/${f.machine}`
    const parsed = parse(f.text)
    if (parsed.ok && parsed.statement.fingerprint === me) continue // this machine
    // This machine's own slot holds an older identity of this machine until
    // the push above replaces it: that is not another machine of yours.
    if (login && f.login === login && f.machine === machine) continue
    const k = keys[f.login]
    if (!k) {
      invalid.push({ ref, why: "GitHub's keys for them are not known yet" })
      continue
    }
    const v = await verify({ login: f.login, machine: f.machine, text: f.text, sig: f.sig, keys: k.keys })
    if (!v.ok) {
      invalid.push({ ref, why: v.reason })
      continue
    }
    seen.push({ login: f.login, machine: f.machine, statement: v.statement, signer: v.signer })
  }

  // A second opinion from GitHub, when gh can give one.
  const collab = await collaborators(repo.slug, repo.top)
  const vetted = collab ? seen.filter((x) => collab.has(x.login) || x.login === login) : seen
  for (const x of seen) if (!vetted.includes(x)) invalid.push({ ref: `${x.login}/${x.machine}`, why: "GitHub does not list them as a collaborator" })

  // Reload before writing: an answer may have landed while this was fetching.
  s = load()
  if (signedHere) s.signed = signedHere
  const elsewhere = new Set<string>()
  for (const [slug, r] of Object.entries(s.repos))
    if (slug !== repo.slug) for (const m of Object.values(r.members)) elsewhere.add(`${m.login}/${m.machine}/${m.fingerprint}`)

  const out = decide({ pins: s.pins, members: rs.members, seen: vetted, keys, fetchOk: fetched.ok, elsewhere })
  s.pins = out.pins
  rs.members = out.members
  rs.invalid = invalid
  rs.lastSync = Date.now()
  if (fetched.ok) rs.lastError = undefined
  s.repos[repo.slug] = rs

  const raised = new Set(out.questions.map((q) => q.id))
  for (const q of out.questions)
    if (!s.questions[q.id]) {
      s.questions[q.id] = { ...q, repo: repo.slug, at: Date.now() }
      event(s, questionText(q))
      log(`repotrust ${repo.slug}: question ${q.id}`)
    }
  // A question whose statement is gone from this repo has nothing left to answer.
  for (const [qid, q] of Object.entries(s.questions)) if (q.repo === repo.slug && !raised.has(qid) && fetched.ok) delete s.questions[qid]
  for (const l of out.firstSight) if (l !== login) event(s, `${l} is trusted through ${repo.slug}`)
  for (const r of out.revoked) event(s, `${r.login} on ${r.machine} is no longer trusted: ${r.why}`)

  save(s)
  const peers = applyPeers(s, id, login)
  if (peers.added.length) log(`repotrust ${repo.slug}: trusted ${peers.added.join(", ")}`)
  if (peers.removed.length) log(`repotrust ${repo.slug}: no longer trusted ${peers.removed.join(", ")}`)
  return {
    ok: true,
    repo: repo.slug,
    trusted: Object.keys(rs.members),
    questions: out.questions.map((q) => q.id),
    revoked: out.revoked.map((r) => `${r.login}/${r.machine}`),
    own: rs.own,
  }
}

// --- questions -------------------------------------------------------------------

export function questionText(q: Question): string {
  const fp = q.statement.fingerprint
  if (q.kind === "changed")
    return `${q.login}'s crosstalk key on ${q.machine} changed (was ${q.was}, now ${fp}). Until you say so, the old key stays trusted and the new one is not.`
  if (q.kind === "returned")
    return `${q.login}'s crosstalk key on ${q.machine} (${fp}) was revoked earlier and has been published again.`
  return `${q.login} has a new machine, ${q.machine} (${fp}), vouched for by an SSH key that is new on their GitHub account (${keyHint(q.signer)}).`
}

export const TRUST = "Trust it"
export const DONT = "Don't trust it"

export const openQuestions = (s = load()) => Object.values(s.questions).sort((a, b) => a.at - b.at)

/** Find a question by its id, or by "login" / "login/machine" when that is unambiguous. */
function findQuestion(s: State, ref: string): OpenQuestion | { error: string } {
  if (s.questions[ref]) return s.questions[ref]
  const r = ref.trim().toLowerCase().replace(/^@/, "")
  const hits = openQuestions(s).filter((q) => q.login === r || `${q.login}/${q.machine}` === r)
  if (hits.length === 1) return hits[0]
  if (!hits.length) return { error: `no open question about ${ref}` }
  return { error: `more than one question about ${ref}; use one of: ${hits.map((q) => q.id).join(", ")}` }
}

/** The person's answer, from the mod's picker or from crosstalk_team. */
export function answerQuestion(ref: string, trust: boolean): { ok: boolean; text?: string; error?: string } {
  const id = loadIdentity()
  if (!id) return { ok: false, error: "no crosstalk identity on this machine" }
  const s = load()
  const q = findQuestion(s, ref)
  if ("error" in q) return { ok: false, error: q.error }
  s.pins = applyAnswer(s.pins, q, trust)
  delete s.questions[q.id]
  const rs = s.repos[q.repo]
  if (trust && rs)
    rs.members[memberKey(q.login, q.machine)] = {
      login: q.login,
      machine: q.machine,
      fingerprint: q.statement.fingerprint,
      edPub: q.statement.edPub,
      xPub: q.statement.xPub,
    }
  event(s, `you ${trust ? "trusted" : "did not trust"} ${q.login}'s key on ${q.machine} (${q.statement.fingerprint})`)
  save(s)
  try {
    ui.withStore((items, now) => ui.settle(items, q.id, "answered", now))
  } catch {}
  applyPeers(s, id, s.signed?.login ?? null)
  return {
    ok: true,
    text: trust
      ? `${q.login}'s key on ${q.machine} is trusted now.`
      : `${q.login}'s new key on ${q.machine} is not trusted, and you will not be asked about it again.`,
  }
}

/**
 * Open questions as the mod's picker items in one session, and questions that
 * were answered elsewhere settled. Runs inside the daemon's ui sync.
 */
export function syncUi(items: Record<string, ui.UiItem>, sessionId: string, now: number, s = load()) {
  const open = new Set(Object.keys(s.questions))
  for (const q of openQuestions(s))
    ui.upsert(
      items,
      {
        id: q.id,
        kind: "team",
        sessionId,
        from: q.login,
        thread: q.repo,
        question: `${questionText(q)} Trust the new key?`,
        options: [TRUST, DONT],
        ts: q.at,
      },
      now,
    )
  for (const it of Object.values(items)) if (it.kind === "team" && !open.has(it.id)) ui.settle(items, it.id, "answered", now)
}

/**
 * For a session without the mod: the questions not yet told to anyone, as one
 * systemMessage, which the person sees and the model does not. Each is told
 * once; it stays open, and listed by crosstalk_team, until it is answered.
 */
export function takeSystemMessage(): string | undefined {
  const s = load()
  const fresh = openQuestions(s).filter((q) => !q.announced)
  if (!fresh.length) return undefined
  for (const q of fresh) s.questions[q.id].announced = true
  save(s)
  return fresh
    .map((q) => `◢ crosstalk: ${questionText(q)} Say "trust ${q.login}'s new key" or "don't trust it".`)
    .join("\n")
}

// --- status ------------------------------------------------------------------------

export type TeamStatus = {
  repo?: string
  you?: string
  trusted: { who: string; login: string; machine: string; fingerprint: string; yours: boolean; repos: string[] }[]
  pending: { id: string; login: string; machine: string; question: string }[]
  changed: string[]
  notTrusted: { ref: string; why: string }[]
  lastSync?: string
  error?: string
  note?: string
}

export async function status(cwd?: string): Promise<TeamStatus> {
  const s = load()
  const repo = cwd ? await findRepo(cwd).catch(() => null) : null
  const rs = repo ? s.repos[repo.slug] : undefined
  const peers = Object.values(loadPeers()).filter((p) => p.via === "repo")
  const inRepo = (p: Peer) => !repo || (p.repos ?? []).includes(repo.slug)
  return {
    repo: repo?.slug,
    you: rs?.own,
    trusted: peers.filter(inRepo).map((p) => ({
      who: p.label,
      login: p.person ?? p.label,
      machine: p.machine ?? "",
      fingerprint: p.fingerprint,
      yours: !!p.own,
      repos: p.repos ?? [],
    })),
    pending: openQuestions(s)
      .filter((q) => !repo || q.repo === repo.slug)
      .map((q) => ({ id: q.id, login: q.login, machine: q.machine, question: questionText(q) })),
    changed: s.events.slice(-10).map((e) => `${new Date(e.at).toISOString().slice(0, 16).replace("T", " ")} ${e.text}`),
    notTrusted: rs?.invalid ?? [],
    lastSync: rs?.lastSync ? new Date(rs.lastSync).toISOString() : undefined,
    error: rs?.lastError,
    note: repo ? undefined : cwd ? "this directory is not in a git repository with a GitHub remote" : undefined,
  }
}

// --- daemon wiring -----------------------------------------------------------------

const watched = new Map<string, number>() // cwd -> when a sync was last asked for it
let timer: ReturnType<typeof setInterval> | null = null

/**
 * A session registered in `cwd`. Sync its repository soon, rate limited, and
 * keep every repository seen so far in sync periodically. Never throws, never
 * blocks the caller: all of it happens in the background.
 */
export function noteSession(cwd: string, log: (...a: unknown[]) => void = () => {}) {
  if (!cwd || process.env.CROSSTALK_NO_REPOTRUST === "1") return
  // Register runs every turn; the repo is looked at no more than once a minute.
  const last = watched.get(cwd) ?? 0
  if (Date.now() - last < Math.min(minMs(), 60_000)) return
  watched.set(cwd, Date.now())
  void sync(cwd, { log }).catch(() => {})
  if (!timer) {
    timer = setInterval(() => {
      for (const c of watched.keys()) void sync(c, { log }).catch(() => {})
    }, Math.max(minMs(), 60_000))
    timer.unref?.()
  }
}

export type { Repo }
