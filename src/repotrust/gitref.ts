// Statements live on refs in the repository itself:
//
//   refs/crosstalk/keys/<login>/<machine>
//
// Each ref points at a parentless commit whose tree holds statement.json and
// statement.sig. Only git plumbing is used: hash-object, mktree, commit-tree,
// update-ref, fetch and push. The working tree, the index, HEAD and every
// branch are left alone. Fetched statements are kept under
// refs/crosstalk/remote/keys/ so that pruning what the remote no longer has
// never touches the one this machine is about to push.
//
// A statement only reaches the remote by push, so "has a statement on the
// ref" means "someone with push access put it there". That is the collaborator
// set; GitHub's key list then decides whose it is.

import path from "node:path"
import { isLogin, isMachine, quietEnv, run } from "./statement.ts"

export const LOCAL_PREFIX = "refs/crosstalk/keys/"
export const FETCHED_PREFIX = "refs/crosstalk/remote/keys/"
export const REFSPEC = `+${LOCAL_PREFIX}*:${FETCHED_PREFIX}*`
const MAX_BLOB = 16 * 1024

const git = (cwd: string, args: string[], o: { input?: string; env?: NodeJS.ProcessEnv; timeoutMs?: number } = {}) =>
  run("git", args, { cwd, input: o.input, env: o.env ?? quietEnv(), timeoutMs: o.timeoutMs ?? 15_000 })

export type Repo = {
  /** The working tree's top level. */
  top: string
  /** The remote statements are fetched from and pushed to. */
  remote: string
  url: string
  /** owner/repo, lowercased: how one repository is told apart from another. */
  slug: string
}

/** owner/repo from a GitHub remote URL in any of its spellings, or null. */
export function githubSlug(url: string): string | null {
  const m =
    url.match(/^(?:ssh:\/\/)?git@github\.com[:/]([^/\s]+)\/([^/\s]+?)(?:\.git)?\/?$/i) ??
    url.match(/^(?:https?|git):\/\/(?:[^@/]+@)?github\.com\/([^/\s]+)\/([^/\s]+?)(?:\.git)?\/?$/i)
  return m ? `${m[1]}/${m[2]}`.toLowerCase() : null
}

/**
 * The repository a directory is in, if it has a GitHub remote. `origin` is
 * preferred; otherwise the first remote that is on GitHub.
 *
 * CROSSTALK_REPOTRUST_ANY_REMOTE=1 accepts any remote and names it after its
 * path, which is how the tests use a bare repository on disk as "GitHub".
 */
export async function findRepo(cwd: string): Promise<Repo | null> {
  if (!cwd) return null
  const top = await git(cwd, ["rev-parse", "--show-toplevel"], { timeoutMs: 5000 })
  if (top.code !== 0) return null
  const dir = top.stdout.trim()
  const list = await git(dir, ["remote"], { timeoutMs: 5000 })
  const remotes = list.stdout.split("\n").map((s) => s.trim()).filter(Boolean)
  remotes.sort((a, b) => (a === "origin" ? -1 : b === "origin" ? 1 : 0))
  for (const remote of remotes) {
    const u = await git(dir, ["remote", "get-url", remote], { timeoutMs: 5000 })
    const url = u.stdout.trim()
    if (u.code !== 0 || !url) continue
    const slug =
      githubSlug(url) ??
      (process.env.CROSSTALK_REPOTRUST_ANY_REMOTE === "1" ? `local/${path.basename(url).replace(/\.git$/, "").toLowerCase()}` : null)
    if (slug) return { top: dir, remote, url, slug }
  }
  return null
}

/**
 * Add the refspec so an ordinary `git fetch` keeps statements current too.
 * Quiet and idempotent; a repo whose config cannot be written still works,
 * because sync fetches with the refspec spelled out.
 */
export async function ensureRefspec(r: Repo): Promise<void> {
  const have = await git(r.top, ["config", "--get-all", `remote.${r.remote}.fetch`], { timeoutMs: 5000 })
  if (have.stdout.split("\n").some((l) => l.trim() === REFSPEC)) return
  await git(r.top, ["config", "--add", `remote.${r.remote}.fetch`, REFSPEC], { timeoutMs: 5000 })
}

/** Fetch every statement from the remote. False when the remote could not be reached. */
export async function fetchStatements(r: Repo): Promise<{ ok: boolean; error?: string }> {
  const f = await git(
    r.top,
    ["fetch", "--quiet", "--no-tags", "--prune", "--no-write-fetch-head", "--no-recurse-submodules", r.remote, REFSPEC],
    { timeoutMs: 30_000 },
  )
  return f.code === 0 ? { ok: true } : { ok: false, error: f.stderr.trim().split("\n").pop() || `git fetch exited ${f.code}` }
}

export type Found = { login: string; machine: string; text: string; sig: string; oid: string }

/** Every statement fetched from the remote, as stored. Malformed refs are skipped, not trusted. */
export async function listStatements(r: Repo, prefix = FETCHED_PREFIX): Promise<{ found: Found[]; skipped: string[] }> {
  const out = await git(r.top, ["for-each-ref", "--format=%(refname) %(objectname) %(objecttype)", prefix], { timeoutMs: 10_000 })
  const found: Found[] = []
  const skipped: string[] = []
  for (const line of out.stdout.split("\n")) {
    const [ref, oid, type] = line.trim().split(" ")
    if (!ref) continue
    const rest = ref.slice(prefix.length).split("/")
    const [login, machine] = rest
    if (rest.length !== 2 || !isLogin(login) || !isMachine(machine) || type !== "commit") {
      skipped.push(ref)
      continue
    }
    const read = async (name: string) => {
      const sz = await git(r.top, ["cat-file", "-s", `${oid}:${name}`], { timeoutMs: 5000 })
      if (sz.code !== 0 || Number(sz.stdout.trim()) > MAX_BLOB) return null
      const b = await git(r.top, ["cat-file", "blob", `${oid}:${name}`], { timeoutMs: 5000 })
      return b.code === 0 ? b.stdout : null
    }
    const text = await read("statement.json")
    const sig = await read("statement.sig")
    if (text === null || sig === null) {
      skipped.push(ref)
      continue
    }
    found.push({ login, machine, text, sig, oid })
  }
  return { found, skipped }
}

const PLUMBING_ENV = () => ({
  ...quietEnv(),
  GIT_AUTHOR_NAME: "crosstalk",
  GIT_AUTHOR_EMAIL: "crosstalk@localhost",
  GIT_COMMITTER_NAME: "crosstalk",
  GIT_COMMITTER_EMAIL: "crosstalk@localhost",
})

/**
 * Write this machine's statement to its ref and push it, with whatever
 * credentials git already uses for this remote. Hooks are not run: this is
 * crosstalk's own ref, not your work, and a pre-push hook that runs your test
 * suite has no business running from a background daemon.
 */
export async function publish(r: Repo, login: string, machine: string, text: string, sig: string): Promise<{ ok: boolean; error?: string }> {
  if (!isLogin(login) || !isMachine(machine)) return { ok: false, error: "bad ref name" }
  const blob = async (s: string) => (await git(r.top, ["hash-object", "-w", "--stdin"], { input: s })).stdout.trim()
  const a = await blob(text)
  const b = await blob(sig)
  if (!/^[0-9a-f]{40,64}$/.test(a) || !/^[0-9a-f]{40,64}$/.test(b)) return { ok: false, error: "git would not store the statement" }
  const tree = (await git(r.top, ["mktree"], { input: `100644 blob ${a}\tstatement.json\n100644 blob ${b}\tstatement.sig\n` })).stdout.trim()
  const commit = await git(r.top, ["commit-tree", tree, "-m", `crosstalk identity for ${login} on ${machine}`], { env: PLUMBING_ENV() })
  const oid = commit.stdout.trim()
  if (commit.code !== 0 || !/^[0-9a-f]{40,64}$/.test(oid)) return { ok: false, error: "git would not make the commit" }
  const ref = `${LOCAL_PREFIX}${login}/${machine}`
  await git(r.top, ["update-ref", ref, oid])
  const push = await git(r.top, ["push", "--quiet", "--no-verify", "--force", r.remote, `${oid}:${ref}`], { timeoutMs: 30_000 })
  if (push.code !== 0) return { ok: false, error: push.stderr.trim().split("\n").pop() || `git push exited ${push.code}` }
  // What was pushed is now also what the remote has.
  await git(r.top, ["update-ref", `${FETCHED_PREFIX}${login}/${machine}`, oid])
  return { ok: true }
}
