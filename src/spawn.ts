// New agents on request: "put two more on auth", "start an agent to fix the
// flaky test".
//
// Each new agent gets its own copy of the code, a git worktree of the asking
// session's repository on a branch of its own, so parallel agents never step
// on each other. Dependencies are shared, never copied: node_modules and a
// virtualenv in the main checkout are symlinked in. Then it opens in a tab of
// the person's own terminal, in the window that already holds that repository
// (src/terminal/layout.ts), running `claude "<task>"`.
//
// With background, it runs in crosstalk's own tmux server instead
// (`tmux -L crosstalk`, one tmux session per agent), which outlives every
// window; "show me <name>" opens a tab attached to it.
//
// Where the worktree goes: next to the repository's existing worktrees when it
// has any (Claude Code's .claude/worktrees/, a ../repo-worktrees/ folder, …),
// else <crosstalk home>/worktrees/<repo>/<name>. Every agent started is
// recorded in <crosstalk home>/spawned/, which is how its tab is named, how
// cleanup knows the worktree is crosstalk's to remove, and how show finds it.

import fs from "node:fs"
import path from "node:path"
import { spawnSync } from "node:child_process"
import { P } from "./config.ts"
import * as R from "./restore.ts"
import { git as liveGit, repoName, slug, worktrees, type Git, type Worktree } from "./terminal/repo.ts"
import { openForRepo, type Tab } from "./terminal/layout.ts"
import { refuseBot } from "./ui-extra/bots.ts"
import * as bgx from "./attention/background.ts"
import { focusSession } from "./attention/show.ts"
import * as St from "./attention/staffing.ts"
import type { View } from "./attention/dispose.ts"
import { request } from "./client.ts"

export const DEP_DIRS = ["node_modules", ".venv", "venv"]
export const MAX_AGENTS = 8
export const BRANCH_PREFIX = "crosstalk/"
export const TMUX_SOCKET = "crosstalk"

export type SpawnRec = {
  id: string
  name: string
  task: string
  /** The repository's main checkout. */
  repo: string
  worktree: string
  /** Where the agent starts: the worktree, or the same subfolder of it the asker was in. */
  cwd: string
  branch: string
  base: string
  createdAt: number
  background: boolean
  /** The tmux session in crosstalk's own server, for a background agent. */
  tmux?: string
  /** A background agent that is Claude Code's own (`claude --bg`), where there is no tmux. */
  claudeBg?: boolean
  /** The session that asked. */
  by?: string
  /** Its name, for the thread's "started from". */
  byName?: string
  /** The thread it starts in, by name and id: the daemon places it there from its first registration. */
  thread?: string
  threadId?: string
  /** The agent's own session, once its first hook has run. */
  sessionId?: string
  /** Dependency folders linked in from the main checkout. */
  links: string[]
  /** When the cleanup offer named it, so it is offered once. */
  offeredAt?: number
  removedAt?: number
}

const dir = () => path.join(P.root, "spawned")
const fileOf = (id: string) => path.join(dir(), `${id.replace(/[^A-Za-z0-9._-]/g, "_")}.json`)

export function readSpawned(): SpawnRec[] {
  let names: string[]
  try {
    names = fs.readdirSync(dir()).filter((f) => f.endsWith(".json"))
  } catch {
    return []
  }
  const out: SpawnRec[] = []
  for (const f of names)
    try {
      const r = JSON.parse(fs.readFileSync(path.join(dir(), f), "utf8"))
      if (r?.id && r.worktree) out.push(r)
    } catch {}
  return out.sort((a, b) => a.createdAt - b.createdAt)
}

export function writeSpawned(r: SpawnRec) {
  fs.mkdirSync(dir(), { recursive: true, mode: 0o700 })
  const tmp = `${fileOf(r.id)}.${process.pid}.tmp`
  fs.writeFileSync(tmp, JSON.stringify(r, null, 2), { mode: 0o600 })
  fs.renameSync(tmp, fileOf(r.id))
}

/** The spawned agent working in this folder, if any: its worktree or below. */
export function spawnedAt(cwd: string, recs = readSpawned()): SpawnRec | null {
  const c = path.resolve(cwd)
  return recs.find((r) => !r.removedAt && (c === path.resolve(r.worktree) || c.startsWith(path.resolve(r.worktree) + path.sep))) ?? null
}

// --- planning ----------------------------------------------------------------------

const STOP = new Set(
  "a an the on to for and of in with at by from into onto this that it its be is are please can could would you start put get run spin up fire one two three four five six seven eight more another new agent agents session sessions claude someone somebody work working".split(" "),
)

/** A short name from the task: its first two words that mean something. */
export function nameFromTask(task: string): string {
  const words = task
    .toLowerCase()
    .replace(/[^a-z0-9\s-]/g, " ")
    .split(/\s+/)
    .filter((w) => w && !STOP.has(w))
  return slug(words.slice(0, 2).join("-"), 24) || "agent"
}

/** Names nobody has: `auth`, then `auth-2`; several are `auth-1`, `auth-2`, … skipping any taken. */
export function namesFor(o: { count: number; name?: string; task: string; taken: (n: string) => boolean }): string[] {
  const base = slug(o.name ?? "", 24) || nameFromTask(o.task)
  const out: string[] = []
  const free = (n: string) => !o.taken(n) && !out.includes(n)
  if (o.count === 1) {
    for (let i = 1; out.length < 1; i++) {
      const n = i === 1 ? base : `${base}-${i}`
      if (free(n)) out.push(n)
    }
    return out
  }
  for (let i = 1; out.length < o.count; i++) if (free(`${base}-${i}`)) out.push(`${base}-${i}`)
  return out
}

/**
 * Where this repository keeps its worktrees: the folder most of its existing
 * ones are in, else crosstalk's own.
 */
export function worktreeHome(o: { main: string; worktrees: Worktree[]; home: string }): string {
  const counts = new Map<string, number>()
  for (const w of o.worktrees.slice(1)) {
    if (w.bare || !w.path) continue
    const d = path.dirname(w.path)
    if (d === path.dirname(o.main) && !/worktree/i.test(path.basename(w.path))) continue // a sibling clone-alike, not a convention
    counts.set(d, (counts.get(d) ?? 0) + 1)
  }
  let best: string | null = null
  for (const [d, n] of counts) if (!best || n > counts.get(best)!) best = d
  return best ?? path.join(o.home, "worktrees", repoName(o.main))
}

export type Planned = {
  name: string
  branch: string
  worktree: string
  cwd: string
  /** [from, to]: a dependency folder of the main checkout, linked into the worktree. */
  links: [string, string][]
  tab: Tab
}

export function planSpawn(o: {
  count: number
  task: string
  name?: string
  /** The asking session's folder. */
  cwd: string
  /** Its checkout's top folder. */
  top: string
  worktrees: Worktree[]
  home: string
  claude: string
  exists: (p: string) => boolean
  branchExists: (b: string) => boolean
  /** The first prompt, when it is more than the task (a thread's brief and the task). */
  prompt?: string
  /** The thread the agents start in, so their tabs go beside its tabs. */
  thread?: string
}): Planned[] {
  const main = o.worktrees[0]?.path ?? o.top
  const where = worktreeHome({ main, worktrees: o.worktrees, home: o.home })
  const rel = path.relative(o.top, o.cwd)
  const sub = rel && !rel.startsWith("..") && !path.isAbsolute(rel) ? rel : ""
  const count = Math.max(1, Math.min(MAX_AGENTS, Math.floor(o.count || 1)))
  const names = namesFor({
    count,
    name: o.name,
    task: o.task,
    taken: (n) => o.exists(path.join(where, n)) || o.branchExists(BRANCH_PREFIX + n),
  })
  return names.map((name) => {
    const worktree = path.join(where, name)
    const cwd = sub ? path.join(worktree, sub) : worktree
    const links: [string, string][] = DEP_DIRS.filter((d) => o.exists(path.join(main, d))).map((d) => [path.join(main, d), path.join(worktree, d)])
    return { name, branch: BRANCH_PREFIX + name, worktree, cwd, links, tab: { cwd, argv: [o.claude, o.prompt ?? o.task], name, ...(o.thread ? { thread: o.thread } : {}) } }
  })
}

// --- crosstalk's tmux server ---------------------------------------------------------

export const tmuxConf = () => path.join(P.root, "tmux.conf")

/** crosstalk owns this server, so it may show the state outright. */
export const TMUX_CONF = [
  `# crosstalk's own tmux server (tmux -L crosstalk), for agents it runs in the background.`,
  `set -g status-left '#[bold]◢ crosstalk#[default] #S  '`,
  `set -g status-left-length 40`,
  `set -g status-right '#{?#{==:#{@crosstalk_state},waiting},#[fg=colour208]● waiting on you,#{?#{==:#{@crosstalk_state},working},#[fg=colour33]● working,#{?#{==:#{@crosstalk_state},done},#[fg=colour34]✓ done,}}}'`,
  `set -g set-titles on`,
  `set -g set-titles-string '#S'`,
  `set -g detach-on-destroy on`,
  `set -g history-limit 50000`,
  ``,
].join("\n")

export function ensureConf() {
  fs.mkdirSync(P.root, { recursive: true, mode: 0o700 })
  try {
    if (fs.readFileSync(tmuxConf(), "utf8") === TMUX_CONF) return
  } catch {}
  fs.writeFileSync(tmuxConf(), TMUX_CONF, { mode: 0o600 })
}

/** The person's own tmux variables would point a nested client at the wrong server. */
export function cleanEnv(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const e = { ...env }
  delete e.TMUX
  delete e.TMUX_PANE
  return e
}

export const backgroundSteps = (p: Planned): R.Step[] => [
  // Marked, so its permission prompts come to the person as questions (src/attention/permission.ts).
  { cmd: "tmux", args: ["-L", TMUX_SOCKET, "-f", tmuxConf(), "new-session", "-d", "-s", p.name, "-c", p.cwd, bgx.tmuxArgv(p.tab.argv, p.name).map(R.shq).join(" ")] },
]

export const attachArgv = (name: string) => ["env", "-u", "TMUX", "-u", "TMUX_PANE", "tmux", "-L", TMUX_SOCKET, "attach-session", "-t", `=${name}`]

export function tmuxHas(name: string, env: NodeJS.ProcessEnv = process.env): boolean {
  return spawnSync("tmux", ["-L", TMUX_SOCKET, "has-session", "-t", `=${name}`], { stdio: "ignore", timeout: 3000, env: cleanEnv(env) }).status === 0
}

// --- doing it ----------------------------------------------------------------------

function run(s: R.Step, env: NodeJS.ProcessEnv): { ok: boolean; out: string } {
  const r = spawnSync(s.cmd, s.args, { input: s.input, encoding: "utf8", timeout: 60_000, env })
  return { ok: r.status === 0, out: `${r.stdout ?? ""}${r.stderr ?? ""}${r.error ? String(r.error) : ""}`.trim() }
}

function which(bin: string, env: NodeJS.ProcessEnv): string | undefined {
  for (const d of (env.PATH ?? "").split(path.delimiter)) {
    if (!d) continue
    const p = path.join(d, bin)
    try {
      fs.accessSync(p, fs.constants.X_OK)
      return p
    } catch {}
  }
  return undefined
}

/**
 * Linked dependency folders are not ignored by a `node_modules/` pattern (a
 * link is a file to git), so the repository's local exclude names them. That
 * file is the repository's own and never committed.
 */
export function excludeLinks(commonDir: string, names: string[]) {
  if (!names.length) return
  const f = path.join(commonDir, "info", "exclude")
  let text = ""
  try {
    text = fs.readFileSync(f, "utf8")
  } catch {}
  const have = new Set(text.split("\n").map((l) => l.trim()))
  const add = names.map((n) => `/${n}`).filter((l) => !have.has(l))
  if (!add.length) return
  fs.mkdirSync(path.dirname(f), { recursive: true })
  fs.writeFileSync(f, `${text}${text && !text.endsWith("\n") ? "\n" : ""}# crosstalk: dependency folders shared from the main checkout\n${add.join("\n")}\n`)
}

export type SpawnOutcome = { ok: boolean; text: string; agents: SpawnRec[] }

/** The thread new agents start in. */
export type ThreadCtx = {
  id: string
  name: string
  /** The thread as the daemon shows it, for the brief. */
  view?: View
  /** The asking session's name. */
  from?: string
  /** Whether the asking session is in it (its tab is then one of the thread's tabs). */
  asking?: boolean
}

/**
 * The thread an agent asked for from this session starts in: the one named,
 * else the asking session's own first thread. Asked of the daemon; without
 * one, or with the session in no thread, there is none and the agent starts
 * from its task alone. A thread named that does not exist is an error.
 */
export async function threadFor(o: { sessionId?: string; cwd: string; thread?: string; ask?: Ask }): Promise<{ ok: true; thread?: ThreadCtx } | { ok: false; text: string }> {
  const ask = o.ask ?? ((req) => request(req, 4000))
  const named = (o.thread ?? "").trim()
  let r: any
  try {
    r = await ask({ op: "thread_read", sessionId: o.sessionId, cwd: o.cwd, ...(named ? { thread: named } : {}) })
  } catch {
    // No daemon: nothing to brief from, unless a thread was named.
    return named ? { ok: false, text: `◢ crosstalk: cannot reach the daemon to find the thread ${named}.` } : { ok: true }
  }
  if (!r?.ok) return named ? { ok: false, text: `◢ crosstalk: no thread called "${named}".${r?.all?.length ? ` Threads: ${r.all.map((t: { name: string }) => t.name).join(", ")}.` : ""}` } : { ok: true }
  const v = (r.threads ?? [])[0] as View | undefined
  if (!v?.id) return { ok: true }
  let mine: string[] = []
  let from: string | undefined
  if (o.sessionId) {
    try {
      const s = await ask({ op: "threads", sessionId: o.sessionId, cwd: o.cwd })
      mine = (s?.threads ?? []).map((t: { id: string }) => t.id)
      from = typeof s?.name === "string" && s.name ? s.name : undefined
    } catch {}
  }
  return { ok: true, thread: { id: v.id, name: v.name, view: v, ...(from ? { from } : {}), asking: !named || mine.includes(v.id) } }
}

type Ask = (req: Record<string, unknown>) => Promise<any>

/** spawnAgents, from a session: in its thread (or the one named), with the thread's brief. */
export async function spawnFromSession(o: Parameters<typeof spawnAgents>[0] & { threadName?: string; ask?: Ask }): Promise<SpawnOutcome> {
  const bot = refuseBot(o.peer, "start an agent on this machine")
  if (bot) return { ok: false, text: `◢ crosstalk: ${bot}`, agents: [] }
  const t = await threadFor({ sessionId: o.by, cwd: o.cwd, thread: o.threadName, ask: o.ask })
  if (!t.ok) return { ok: false, text: t.text, agents: [] }
  return spawnAgents({ ...o, thread: t.thread })
}

const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`

export function spawnAgents(o: {
  count?: number
  task: string
  name?: string
  background?: boolean
  cwd: string
  by?: string
  env?: NodeJS.ProcessEnv
  git?: Git
  /** The peer this is done for, if any: an agent (a bot) is refused. */
  peer?: string
  /**
   * The thread the asking session is in (or was named): each agent starts
   * from its brief (`view`, src/attention/staffing.ts) and is placed in it.
   * Without a view the task is the whole prompt (staffing writes its own brief).
   */
  thread?: ThreadCtx
}): SpawnOutcome {
  const bot = refuseBot(o.peer, "start an agent on this machine")
  if (bot) return { ok: false, text: `◢ crosstalk: ${bot}`, agents: [] }
  const g = o.git ?? liveGit
  const env = o.env ?? process.env
  const task = (o.task ?? "").trim()
  if (!task) return { ok: false, text: "◢ crosstalk: say what the new agent should do.", agents: [] }
  // The task is claude's first argument: one starting with "-" would be read
  // as a flag (--dangerously-skip-permissions), not as the prompt.
  if (bgx.isFlagLike(task)) return { ok: false, text: `◢ crosstalk: a task cannot start with "-" (claude would read it as an option). Start it with a word.`, agents: [] }
  const top = g(o.cwd, ["rev-parse", "--show-toplevel"])
  if (!top.ok || !top.out)
    return { ok: false, text: `◢ crosstalk: ${o.cwd} is not in a git repository, and each new agent needs its own copy of the code.`, agents: [] }
  const base = g(o.cwd, ["rev-parse", "HEAD"])
  if (!base.ok) return { ok: false, text: "◢ crosstalk: this repository has no commit yet to start an agent from.", agents: [] }
  const wts = worktrees(o.cwd, g)
  const main = wts[0]?.path ?? top.out
  const common = g(o.cwd, ["rev-parse", "--path-format=absolute", "--git-common-dir"])
  // No tmux (native Windows, mostly): Claude Code's own background sessions, if this claude has them.
  const claudeBin = which("claude", env) ?? "claude"
  const claudeBg = !!o.background && !which("tmux", env) && bgx.claudeBackground(claudeBin, env).bg
  if (o.background && !which("tmux", env) && !claudeBg)
    return { ok: false, text: "◢ crosstalk: background agents run in tmux, which is not installed here. Install tmux, or start the agent in a tab instead.", agents: [] }

  const prompt = o.thread?.view ? St.threadBrief(o.thread.view, task, { from: o.thread.from }) : task
  const plans = planSpawn({
    count: o.count ?? 1,
    task,
    name: o.name,
    cwd: o.cwd,
    top: top.out,
    worktrees: wts,
    home: P.root,
    claude: which("claude", env) ?? "claude",
    exists: (p) => fs.existsSync(p),
    branchExists: (b) => g(main, ["rev-parse", "--verify", "--quiet", `refs/heads/${b}`]).ok,
    prompt,
    thread: o.thread?.name,
  })

  const made: SpawnRec[] = []
  const notes: string[] = []
  for (const p of plans) {
    fs.mkdirSync(path.dirname(p.worktree), { recursive: true })
    const add = g(main, ["worktree", "add", "--quiet", "-b", p.branch, p.worktree, base.out])
    if (!add.ok) {
      notes.push(`could not make a copy for ${p.name}: ${add.out.split("\n").pop()}`)
      continue
    }
    const linked: string[] = []
    for (const [from, to] of p.links) {
      try {
        if (fs.existsSync(to)) continue
        fs.symlinkSync(from, to, "dir")
        linked.push(path.basename(to))
      } catch {}
    }
    if (common.ok) excludeLinks(common.out, linked)
    fs.mkdirSync(p.cwd, { recursive: true })
    const rec: SpawnRec = {
      id: `${repoName(main)}--${p.name}`,
      name: p.name,
      task,
      repo: main,
      worktree: p.worktree,
      cwd: p.cwd,
      branch: p.branch,
      base: base.out,
      createdAt: Date.now(),
      background: !!o.background,
      ...(o.background ? (claudeBg ? { claudeBg: true } : { tmux: p.name }) : {}),
      by: o.by,
      ...(o.thread ? { thread: o.thread.name, threadId: o.thread.id, ...(o.thread.from ? { byName: o.thread.from } : {}) } : {}),
      links: linked,
    }
    writeSpawned(rec)
    made.push(rec)
  }
  if (!made.length) return { ok: false, text: `◢ crosstalk: started no agent. ${notes.join("; ")}`, agents: [] }

  const started = plans.filter((p) => made.some((m) => m.name === p.name))
  let where = ""
  let ok = true
  if (o.background && claudeBg) {
    const failed: string[] = []
    for (const p of started) {
      const st = bgx.bgStep({ claude: claudeBin, name: p.name, task: prompt, cwd: p.cwd })
      const r = spawnSync(st.cmd, st.args, { cwd: st.cwd, encoding: "utf8", timeout: 60_000, env: { ...env, ...st.env } })
      if (r.status !== 0) failed.push(`${p.name} (${`${r.stderr ?? ""}${r.error ?? ""}`.trim().split("\n").pop()})`)
    }
    if (failed.length) {
      ok = false
      notes.push(`could not start in the background: ${failed.join(", ")}`)
    }
    where = `in the background as Claude Code's own background session${started.length === 1 ? "" : "s"}. Say "show me ${started[0].name}" to watch ${started.length === 1 ? "it" : "one"}`
  } else if (o.background) {
    ensureConf()
    const failed: string[] = []
    for (const p of started) {
      const r = run(backgroundSteps(p)[0], cleanEnv(env))
      if (!r.ok) failed.push(`${p.name} (${r.out.split("\n").pop()})`)
    }
    if (failed.length) {
      ok = false
      notes.push(`could not start in the background: ${failed.join(", ")}`)
    }
    where = `in the background, where ${started.length === 1 ? "it keeps" : "they keep"} running when windows close. Say "show me ${started[0].name}" to watch ${started.length === 1 ? "it" : "one"}`
  } else {
    const r = openForRepo(
      started.map((p) => p.tab),
      { cwd: o.cwd, envVars: env, git: g, by: o.by, thread: o.thread?.name, byInThread: !!o.thread?.asking },
    )
    if (r.opened.kind === "manual" || !r.ok) {
      // Nothing could open it: the commands to paste are the answer, not a failure.
      ok = r.opened.kind === "manual"
      fs.mkdirSync(P.root, { recursive: true, mode: 0o700 })
      const file = path.join(P.root, "spawn-commands.sh")
      fs.writeFileSync(file, `#!/bin/sh\n# New agents crosstalk could not open a tab for. Each line is one tab.\n${r.opened.typed.join("\n")}\n`, { mode: 0o700 })
      where = `but this terminal cannot open tabs from outside. Paste each line into its own tab (also in ${file}):\n${r.opened.typed.map((l) => `  ${l}`).join("\n")}`
      if (r.out) notes.push(r.out.split("\n").pop()!)
    } else where = `in new tabs in ${r.opened.where}`
  }
  const names = made.map((m) => m.name).join(", ")
  const head = `◢ crosstalk: started ${plural(made.length, "agent")} (${names}), each in its own copy of the code, ${where}.${o.thread ? ` ${made.length === 1 ? "It is" : "They are"} in the thread ${o.thread.name}${o.thread.view ? ", starting from its brief" : ""}.` : ""}`
  const deps = made[0].links.length ? ` ${made[0].links.join(" and ")} ${made[0].links.length === 1 ? "is" : "are"} shared with the main checkout, not copied.` : ""
  return { ok, text: head + deps + (notes.length ? `\n  ${notes.join("\n  ")}` : ""), agents: made }
}

// --- show me ----------------------------------------------------------------------

export function findAgent(name: string, recs = readSpawned()): SpawnRec | null {
  const n = slug(name)
  const live = recs.filter((r) => !r.removedAt)
  return live.find((r) => r.name === n) ?? live.filter((r) => r.name.startsWith(n)).pop() ?? live.find((r) => r.name.includes(n)) ?? null
}

/** "show me auth": a tab of the person's terminal, attached to the background agent. */
export function show(o: { name: string; cwd: string; env?: NodeJS.ProcessEnv; by?: string }): { ok: boolean; text: string } {
  const env = o.env ?? process.env
  const rec = findAgent(o.name)
  if (rec?.claudeBg) {
    // Claude Code's own background session: `claude attach` in a new tab.
    const claude = which("claude", env) ?? "claude"
    const r = openForRepo([{ cwd: rec.cwd, argv: bgx.attachArgv(claude, rec.name), name: rec.name, thread: rec.thread }], { cwd: rec.cwd, envVars: env, by: o.by, thread: rec.thread })
    if (r.opened.kind === "manual" || !r.ok) return { ok: r.opened.kind === "manual", text: `◢ crosstalk: to watch ${rec.name}, run:\n  ${R.shq(claude)} attach ${R.shq(rec.name)}` }
    return { ok: true, text: `◢ crosstalk: opened ${rec.name} in a new tab in ${r.opened.where}. Leaving it leaves it running.` }
  }
  const session = rec?.tmux ?? (tmuxHas(slug(o.name), env) ? slug(o.name) : null)
  if (!session) {
    // One of the person's own sessions: its tab, brought to the front.
    if (!rec || !rec.background) {
      const f = focusSession({ name: rec?.name ?? o.name, env })
      if (f.found) return { ok: f.ok, text: f.text }
    }
    if (rec && !rec.background) return { ok: true, text: `◢ crosstalk: ${rec.name} runs in a tab of its own already, in ${rec.cwd}.` }
    const bg = readSpawned().filter((r) => r.background && !r.removedAt && tmuxHas(r.tmux!, env)).map((r) => r.name)
    return { ok: false, text: `◢ crosstalk: no background agent called ${o.name}.${bg.length ? ` Running in the background: ${bg.join(", ")}.` : ""}` }
  }
  if (!tmuxHas(session, env)) return { ok: false, text: `◢ crosstalk: ${rec?.name ?? session} is not running any more.` }
  const r = openForRepo([{ cwd: rec?.cwd ?? o.cwd, argv: attachArgv(session), name: session, thread: rec?.thread }], { cwd: rec?.cwd ?? o.cwd, envVars: env, by: o.by, thread: rec?.thread })
  if (r.opened.kind === "manual") return { ok: true, text: `◢ crosstalk: this terminal cannot open a tab from outside. To watch ${session}, run:\n  ${R.shq("tmux")} -L ${TMUX_SOCKET} attach -t ${R.shq("=" + session)}` }
  if (!r.ok) return { ok: false, text: `◢ crosstalk: could not open a tab for ${session}: ${r.out.split("\n").pop()}` }
  return { ok: true, text: `◢ crosstalk: opened ${session} in a new tab in ${r.opened.where}. Closing that tab leaves it running.` }
}

/** For the hook: the name a spawned agent's session goes by, claimed by its session id. */
export function claim(sessionId: string, cwd: string): SpawnRec | null {
  const rec = spawnedAt(cwd)
  if (!rec) return null
  if (rec.sessionId !== sessionId) writeSpawned({ ...rec, sessionId })
  return rec
}
