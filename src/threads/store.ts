// Threads on their own git ref, refs/crosstalk/threads, never checked out.
//
// Only plumbing: hash-object, mktree, commit-tree, update-ref, ls-tree and
// cat-file. Nothing here reads or writes the working tree or the index, runs a
// hook, or moves HEAD, so a thread commit is invisible to everything the user
// does with git except `git log refs/crosstalk/threads`.
//
// The ref is flat: one file per thread, plus RULES.md for the repo-wide
// standing rules once the build that writes them lands.
//
// Fetching and pushing use the user's own remote and credentials, never
// prompting (GIT_TERMINAL_PROMPT=0, ssh in batch mode), and run asynchronously
// in the daemon only, so no hook ever waits on the network.
//
// One caveat the refspec brings. `+refs/crosstalk/*:refs/crosstalk/*` in the
// remote's fetch list means a plain `git fetch` force-updates the local ref to
// the remote's. A local commit that was not pushed yet is then dropped from the
// ref, but not from crosstalk: the daemon's own copy (service.ts) holds every
// thread and every commit is written from it merged with whatever the ref has,
// so the next commit puts it back. crosstalk's own fetch goes to a side ref
// with --refmap= so it never clobbers anything.

import { spawn, spawnSync } from "node:child_process"

export const REF = "refs/crosstalk/threads"
/** Where crosstalk's own fetch lands, so the local ref is never overwritten by it. */
export const SYNC_REF = "refs/crosstalk/sync/threads"
export const REFSPEC = "+refs/crosstalk/*:refs/crosstalk/*"
export const RULES_FILE = "RULES.md"
const ZERO = "0000000000000000000000000000000000000000"

const quietEnv = (extra: Record<string, string> = {}) => ({
  ...process.env,
  GIT_TERMINAL_PROMPT: "0",
  GIT_ASKPASS: process.env.GIT_ASKPASS ?? "",
  // Never ask for a host key or a passphrase: a push that would have to, fails.
  GIT_SSH_COMMAND: process.env.GIT_SSH_COMMAND ?? "ssh -o BatchMode=yes -o ConnectTimeout=10",
  ...extra,
})

function git(root: string, args: string[], input?: string, env?: Record<string, string>): { ok: boolean; out: string; err: string } {
  try {
    const r = spawnSync("git", ["-C", root, ...args], {
      encoding: "utf8",
      input,
      timeout: 10_000,
      env: quietEnv(env),
      maxBuffer: 64 * 1024 * 1024,
    })
    return { ok: r.status === 0, out: (r.stdout ?? "").replace(/\n$/, ""), err: (r.stderr ?? "").trim() }
  } catch (e) {
    return { ok: false, out: "", err: (e as Error).message }
  }
}

export const refCommit = (root: string, ref = REF): string | undefined => {
  const r = git(root, ["rev-parse", "-q", "--verify", `${ref}^{commit}`])
  return r.ok && r.out ? r.out : undefined
}

/** Every file on the ref, by name. Empty when there is no ref yet. */
export function readRef(root: string, ref = REF): { commit?: string; files: Record<string, string> } {
  const commit = refCommit(root, ref)
  if (!commit) return { files: {} }
  const ls = git(root, ["ls-tree", "-z", commit])
  const files: Record<string, string> = {}
  if (!ls.ok) return { commit, files }
  for (const entry of ls.out.split("\0")) {
    const m = /^\d+ blob ([0-9a-f]+)\t(.+)$/.exec(entry)
    if (!m) continue
    const blob = git(root, ["cat-file", "blob", m[1]])
    if (blob.ok) files[m[2]] = blob.out + "\n"
  }
  return { commit, files }
}

export const isAncestor = (root: string, a: string, b: string) =>
  spawnSync("git", ["-C", root, "merge-base", "--is-ancestor", a, b], { env: quietEnv(), timeout: 10_000 }).status === 0

/**
 * Commit exactly these files as the ref's whole tree, on top of the ref and
 * any extra parents (a fetched remote copy being merged in). Compare-and-swap
 * on the ref, so a concurrent writer is never overwritten. Returns the new
 * commit, or undefined when nothing changed or the swap lost.
 */
export function writeRef(
  root: string,
  files: Record<string, string>,
  message: string,
  o: { author: string; extraParents?: string[]; ref?: string } = { author: "crosstalk" },
): string | undefined {
  const ref = o.ref ?? REF
  const base = refCommit(root, ref)
  const lines: string[] = []
  for (const name of Object.keys(files).sort()) {
    if (!/^[A-Za-z0-9._-]+$/.test(name)) continue
    const h = git(root, ["hash-object", "-w", "--stdin"], files[name])
    if (!h.ok) return undefined
    lines.push(`100644 blob ${h.out}\t${name}`)
  }
  const tree = git(root, ["mktree"], lines.length ? lines.join("\n") + "\n" : "")
  if (!tree.ok) return undefined
  const parents = [base, ...(o.extraParents ?? [])].filter((p, i, a): p is string => !!p && a.indexOf(p) === i)
  if (base && !o.extraParents?.length) {
    const cur = git(root, ["rev-parse", `${base}^{tree}`])
    if (cur.ok && cur.out === tree.out) return undefined
  }
  const who = { GIT_AUTHOR_NAME: o.author, GIT_AUTHOR_EMAIL: "crosstalk@localhost", GIT_COMMITTER_NAME: o.author, GIT_COMMITTER_EMAIL: "crosstalk@localhost" }
  const commit = git(root, ["commit-tree", tree.out, ...parents.flatMap((p) => ["-p", p]), "-m", message], undefined, who)
  if (!commit.ok) return undefined
  const upd = git(root, ["update-ref", "-m", "crosstalk: threads", ref, commit.out, base ?? ZERO])
  return upd.ok ? commit.out : undefined
}

/** The remote crosstalk talks to: origin when there is one, else the first. */
export function remoteName(root: string): string | undefined {
  const r = git(root, ["remote"])
  if (!r.ok || !r.out) return undefined
  const all = r.out.split("\n").filter(Boolean)
  return all.includes("origin") ? "origin" : all[0]
}

/** Add the refspec so a plain fetch brings threads too. Returns whether it was added now. */
export function ensureRefspec(root: string, remote = remoteName(root)): boolean {
  if (!remote) return false
  const have = git(root, ["config", "--get-all", `remote.${remote}.fetch`])
  if (have.out.split("\n").includes(REFSPEC)) return false
  return git(root, ["config", "--add", `remote.${remote}.fetch`, REFSPEC]).ok
}

/** The repo's default branch: the remote's HEAD, else a conventional name. */
export function defaultBranch(root: string, remote = remoteName(root)): string | undefined {
  if (remote) {
    const r = git(root, ["symbolic-ref", "-q", "--short", `refs/remotes/${remote}/HEAD`])
    if (r.ok && r.out) return r.out.slice(remote.length + 1)
  }
  return undefined
}

function run(root: string, args: string[], timeoutMs: number): Promise<{ ok: boolean; err: string }> {
  return new Promise((resolve) => {
    let err = ""
    let done = false
    const p = spawn("git", ["-C", root, ...args], { env: quietEnv(), stdio: ["ignore", "ignore", "pipe"] })
    const t = setTimeout(() => {
      if (done) return
      done = true
      p.kill("SIGKILL")
      resolve({ ok: false, err: "timed out" })
    }, timeoutMs)
    p.stderr?.on("data", (d) => (err += d))
    p.on("error", (e) => {
      if (done) return
      done = true
      clearTimeout(t)
      resolve({ ok: false, err: e.message })
    })
    p.on("close", (code) => {
      if (done) return
      done = true
      clearTimeout(t)
      resolve({ ok: code === 0, err: err.trim().slice(0, 300) })
    })
  })
}

/** The remote's threads, into SYNC_REF. Absent on the remote is fine and leaves SYNC_REF alone. */
export async function fetchRemote(root: string, remote = remoteName(root), timeoutMs = 30_000) {
  if (!remote) return { ok: false, err: "no remote" }
  // --refmap= stops the configured refspec from also updating REF itself.
  // --no-write-fetch-head (git 2.29) keeps FETCH_HEAD the user's; older git
  // goes without it rather than without threads.
  const args = (head: boolean) => ["fetch", "-q", "--no-tags", ...(head ? ["--no-write-fetch-head"] : []), "--refmap=", remote, `+${REF}:${SYNC_REF}`]
  let r = await run(root, args(true), timeoutMs)
  if (!r.ok && /unknown option|usage: git fetch/i.test(r.err)) r = await run(root, args(false), timeoutMs)
  return r.ok || /couldn't find remote ref/i.test(r.err) ? { ok: true, err: "" } : r
}

export async function pushRemote(root: string, remote = remoteName(root), timeoutMs = 30_000) {
  if (!remote) return { ok: false, err: "no remote" }
  return run(root, ["push", "-q", "--no-verify", remote, `${REF}:${REF}`], timeoutMs)
}
