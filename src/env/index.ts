// Servers that just start (docs/urls.md, "Servers that just start"): a new
// worktree gets the main checkout's gitignored env and secret files, so its
// dev server starts without anyone copying a .env by hand.
//
// When it happens
//   - crosstalk makes a worktree (src/spawn.ts), and
//   - a session first starts in a worktree of a repository (the hook, at
//     SessionStart: Claude Code's own .claude/worktrees/, or any other)
//
// Asked once per repository, the first time there is something to copy:
// "Copy .env and 2 other local files into new worktrees of api?" as the mod's
// picker, else a systemMessage the agent answers with crosstalk_env. The
// answer is kept in <crosstalk home>/env/consent.json and never asked again;
// crosstalk_env {confirm} changes it. Without a yes nothing is copied.
//
// The files stay on this machine. Their names are all that is ever said
// (tool results, the systemMessage, the daemon's log); their contents are read
// by copy.ts alone and written into the worktree, never into a thread, the
// relay, a log or a tool result. CROSSTALK_NO_ENV_COPY=1 turns it off.

import crypto from "node:crypto"
import fs from "node:fs"
import path from "node:path"
import { P } from "../config.ts"
import { git as repoGit, worktrees, type Git as RepoGit } from "../terminal/repo.ts"
import { select, git as liveGit, type Git, type Selection } from "./select.ts"
import { copyInto, type CopyResult } from "./copy.ts"

export const YES = "Copy them"
export const NO = "Not in this repo"

type Entry = { state: "asked" | "yes" | "no"; at: number; name: string; session?: string; cwd?: string }
type State = { v: 1; repos: Record<string, Entry> }

const file = () => path.join(P.root, "env", "consent.json")
export const off = () => process.env.CROSSTALK_NO_ENV_COPY === "1"

export function load(): State {
  try {
    const s = JSON.parse(fs.readFileSync(file(), "utf8"))
    if (s?.v === 1 && s.repos && typeof s.repos === "object") return s
  } catch {}
  return { v: 1, repos: {} }
}

function save(s: State) {
  fs.mkdirSync(path.dirname(file()), { recursive: true, mode: 0o700 })
  const tmp = `${file()}.${process.pid}.tmp`
  fs.writeFileSync(tmp, JSON.stringify(s, null, 2), { mode: 0o600 })
  fs.renameSync(tmp, file())
}

/** A repository's key: its main checkout, resolved. */
export function keyOf(main: string): string {
  try {
    return fs.realpathSync(main)
  } catch {
    return path.resolve(main)
  }
}

export const envId = (main: string) => `env:${crypto.createHash("sha1").update(keyOf(main)).digest("hex").slice(0, 12)}`

export function consent(main: string, s = load()): "yes" | "no" | undefined {
  const e = s.repos[keyOf(main)]
  return e?.state === "yes" || e?.state === "no" ? e.state : undefined
}

/** A folder's repository: its main checkout and its own worktree's top. Null outside git. */
export function where(cwd: string, g: RepoGit = repoGit): { main: string; top: string; linked: boolean } | null {
  const top = g(cwd, ["rev-parse", "--show-toplevel"])
  if (!top.ok || !top.out) return null
  const main = worktrees(cwd, g)[0]
  if (!main || main.bare) return { main: top.out, top: top.out, linked: false }
  return { main: main.path, top: top.out, linked: keyOf(main.path) !== keyOf(top.out) }
}

const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`

/** "Copy .env and 2 other local files into new worktrees of api?" */
export function questionText(name: string, files: string[]): string {
  const first = files[0] ?? ".env"
  const rest = files.length - 1
  return `Copy ${first}${rest > 0 ? ` and ${plural(rest, "other local file")}` : ""} into new worktrees of ${name}? They are gitignored and stay on this machine: never in git, a thread or the relay.`
}

export const nameOf = (main: string) => path.basename(keyOf(main))

/** Names, joined for a sentence: `.env, .dev.vars and config/app.local.json`. */
export const names = (xs: string[]) => (xs.length <= 1 ? xs.join("") : `${xs.slice(0, -1).join(", ")} and ${xs[xs.length - 1]}`)

export type Prepared = {
  /** File names copied in. */
  copied: string[]
  /** Asked now, for the first time: the question and the picker's id. */
  offer?: { id: string; question: string; name: string; files: string[] }
  state?: "yes" | "no" | "asked"
  refused?: { rel: string; why: string }[]
}

/**
 * A new (or newly opened) worktree of `main`: copy in what is missing when the
 * person said yes for this repo; ask once when nobody has; nothing on a no.
 */
export function prepare(o: { main: string; worktree: string; sessionId?: string; cwd?: string; git?: Git; now?: number }): Prepared {
  if (off() || keyOf(o.main) === keyOf(o.worktree)) return { copied: [] }
  const s = load()
  const key = keyOf(o.main)
  const e = s.repos[key]
  if (e?.state === "no") return { copied: [], state: "no" }
  if (e?.state === "asked") return { copied: [], state: "asked" }
  const sel: Selection = select(o.main, o.git ?? liveGit)
  if (!sel.files.length) return { copied: [], ...(e ? { state: e.state } : {}) }
  if (e?.state === "yes") {
    const r = copyInto({ main: o.main, worktree: o.worktree, files: sel.files, git: o.git })
    return { copied: r.copied, state: "yes", refused: [...sel.refused, ...r.refused] }
  }
  const name = nameOf(o.main)
  s.repos[key] = { state: "asked", at: o.now ?? Date.now(), name, ...(o.sessionId ? { session: o.sessionId } : {}), cwd: o.cwd ?? o.worktree }
  save(s)
  const files = sel.files.map((f) => f.rel)
  return { copied: [], state: "asked", offer: { id: envId(o.main), question: questionText(name, files), name, files } }
}

/** Repos asked about and not answered, newest first. */
export function openAsks(s = load()): string[] {
  return Object.entries(s.repos)
    .filter(([, e]) => e.state === "asked")
    .sort((a, b) => b[1].at - a[1].at)
    .map(([k]) => k)
}

/** The repo a picker id names. */
export const mainForId = (id: string, s = load()) => Object.keys(s.repos).find((k) => envId(k) === id)

/**
 * The person's answer for a repo, kept for good. A yes copies into the folder
 * given (when it is a worktree of the repo) and into every worktree crosstalk
 * made of it, what each is missing.
 */
export function answer(o: { main: string; yes: boolean; worktrees?: string[]; git?: Git; now?: number }): { ok: boolean; text: string; copied: Record<string, string[]> } {
  const s = load()
  const key = keyOf(o.main)
  const name = s.repos[key]?.name ?? nameOf(o.main)
  s.repos[key] = { ...s.repos[key], name, state: o.yes ? "yes" : "no", at: o.now ?? Date.now() }
  save(s)
  if (!o.yes) return { ok: true, text: `◢ crosstalk: not copying local files into new worktrees of ${name}. You will not be asked there again; crosstalk_env {confirm: true} changes it.`, copied: {} }
  const sel = select(o.main, o.git ?? liveGit)
  const copied: Record<string, string[]> = {}
  const refused = new Set<string>(sel.refused.map((r) => `${r.rel} (${r.why})`))
  for (const wt of [...new Set(o.worktrees ?? [])]) {
    if (keyOf(wt) === key || !fs.existsSync(wt)) continue
    const r: CopyResult = copyInto({ main: o.main, worktree: wt, files: sel.files, git: o.git })
    if (r.copied.length) copied[wt] = r.copied
    for (const x of r.refused) refused.add(`${x.rel} (${x.why})`)
  }
  const done = Object.entries(copied)
  const text =
    `◢ crosstalk: new worktrees of ${name} get its local files (${sel.files.length ? names(sel.files.map((f) => f.rel)) : "none right now"}) copied in from the main checkout.` +
    (done.length ? ` Copied into ${done.map(([wt, fs_]) => `${path.basename(wt)} (${names(fs_)})`).join(", ")}.` : "") +
    (refused.size ? ` Left out: ${[...refused].slice(0, 6).join(", ")}.` : "")
  return { ok: true, text, copied }
}

/** What crosstalk_env without confirm says: the answer, and what would be copied. Names only. */
export function status(main: string): string {
  const name = nameOf(main)
  const c = consent(main)
  const sel = select(main)
  const list = sel.files.length ? names(sel.files.map((f) => f.rel)) : "nothing"
  const refused = sel.refused.length ? ` Left out: ${sel.refused.map((r) => `${r.rel} (${r.why})`).join(", ")}.` : ""
  const said = c === "yes" ? "copied into each new worktree" : c === "no" ? "not copied (you said not in this repo)" : "not copied until you say so"
  return `◢ crosstalk: ${name}'s gitignored local files: ${list}. They are ${said}.${refused} crosstalk_env {confirm: true|false} changes it.`
}
