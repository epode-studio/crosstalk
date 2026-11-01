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
  /** The session that asked. */
  by?: string
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
    return { name, branch: BRANCH_PREFIX + name, worktree, cwd, links, tab: { cwd, argv: [o.claude, o.task], name } }
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

function ensureConf() {
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
  { cmd: "tmux", args: ["-L", TMUX_SOCKET, "-f", tmuxConf(), "new-session", "-d", "-s", p.name, "-c", p.cwd, p.tab.argv.map(R.shq).join(" ")] },
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
}): SpawnOutcome {
  const g = o.git ?? liveGit
  const env = o.env ?? process.env
  const task = (o.task ?? "").trim()
  if (!task) return { ok: false, text: "◢ crosstalk: say what the new agent should do.", agents: [] }
  const top = g(o.cwd, ["rev-parse", "--show-toplevel"])
  if (!top.ok || !top.out)
    return { ok: false, text: `◢ crosstalk: ${o.cwd} is not in a git repository, and each new agent needs its own copy of the code.`, agents: [] }
  const base = g(o.cwd, ["rev-parse", "HEAD"])
  if (!base.ok) return { ok: false, text: "◢ crosstalk: this repository has no commit yet to start an agent from.", agents: [] }
  const wts = worktrees(o.cwd, g)
  const main = wts[0]?.path ?? top.out
  const common = g(o.cwd, ["rev-parse", "--path-format=absolute", "--git-common-dir"])
  if (o.background && !which("tmux", env))
    return { ok: false, text: "◢ crosstalk: background agents run in tmux, which is not installed here. Install tmux, or start the agent in a tab instead.", agents: [] }

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
      ...(o.background ? { tmux: p.name } : {}),
      by: o.by,
      links: linked,
    }
    writeSpawned(rec)
    made.push(rec)
  }
  if (!made.length) return { ok: false, text: `◢ crosstalk: started no agent. ${notes.join("; ")}`, agents: [] }

  const started = plans.filter((p) => made.some((m) => m.name === p.name))
  let where = ""
  let ok = true
  if (o.background) {
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
      { cwd: o.cwd, envVars: env, git: g, by: o.by },
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
  const head = `◢ crosstalk: started ${plural(made.length, "agent")} (${names}), each in its own copy of the code, ${where}.`
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
  const session = rec?.tmux ?? (tmuxHas(slug(o.name), env) ? slug(o.name) : null)
  if (!session) {
    if (rec && !rec.background) return { ok: true, text: `◢ crosstalk: ${rec.name} runs in a tab of its own already, in ${rec.cwd}.` }
    const bg = readSpawned().filter((r) => r.background && !r.removedAt && tmuxHas(r.tmux!, env)).map((r) => r.name)
    return { ok: false, text: `◢ crosstalk: no background agent called ${o.name}.${bg.length ? ` Running in the background: ${bg.join(", ")}.` : ""}` }
  }
  if (!tmuxHas(session, env)) return { ok: false, text: `◢ crosstalk: ${rec?.name ?? session} is not running any more.` }
  const r = openForRepo([{ cwd: rec?.cwd ?? o.cwd, argv: attachArgv(session), name: session }], { cwd: rec?.cwd ?? o.cwd, envVars: env, by: o.by })
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
