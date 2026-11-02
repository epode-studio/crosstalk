// What GitHub says about a person: their login, and the SSH keys on their
// account. Fetched only by the daemon, rate limited, through whatever proxy the
// environment configures, and cached so that everything keeps working offline.
//
// CROSSTALK_GITHUB_URL points this at something other than https://github.com,
// which is how the tests serve keys from a stub on localhost.

import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { ROOT } from "../config.ts"
import { isLogin, normaliseKey, parseKeys, quietEnv, run, sshKeygen, type SigningKey } from "./statement.ts"

export const githubBase = () => (process.env.CROSSTALK_GITHUB_URL ?? "https://github.com").replace(/\/+$/, "")

const dir = () => path.join(ROOT, "repotrust", "keys")

export type KeySet = {
  login: string
  keys: string[]
  etag?: string
  /** When GitHub last answered, with a list or a 304. */
  fetchedAt: number
  /** When we last tried, answered or not. */
  triedAt: number
  /** GitHub said this login does not exist. */
  missing?: boolean
}

/** How long a fetched key list is fresh enough not to ask again. */
const freshMs = () => Number(process.env.CROSSTALK_KEYS_MIN_MS ?? 10 * 60 * 1000)

// A ceiling on fetches across all logins, so a repo with many collaborators, or
// a bug, cannot turn the daemon into something hammering GitHub.
const BUCKET = { max: 30, perMs: 10 * 60 * 1000 }
const recent: number[] = []
function allowFetch(now: number) {
  while (recent.length && now - recent[0] > BUCKET.perMs) recent.shift()
  if (recent.length >= BUCKET.max) return false
  recent.push(now)
  return true
}

export function cached(login: string): KeySet | null {
  try {
    const k = JSON.parse(fs.readFileSync(path.join(dir(), `${login}.json`), "utf8")) as KeySet
    return k && k.login === login && Array.isArray(k.keys) ? { ...k, keys: k.keys.map(normaliseKey).filter((x): x is string => !!x) } : null
  } catch {
    return null
  }
}

function store(k: KeySet) {
  fs.mkdirSync(dir(), { recursive: true, mode: 0o700 })
  const f = path.join(dir(), `${k.login}.json`)
  fs.writeFileSync(`${f}.tmp`, JSON.stringify(k, null, 2), { mode: 0o600 })
  fs.renameSync(`${f}.tmp`, f)
}

/**
 * The keys on a person's account, as of the last time GitHub answered.
 *
 * `fresh` is true when this call (or one within the freshness window) heard
 * from GitHub; false means it is the cache, or nothing. Only a fresh answer is
 * evidence that a key was removed, so only a fresh answer may revoke anything.
 */
export async function keysFor(login: string, o: { force?: boolean; now?: number } = {}): Promise<{ set: KeySet | null; fresh: boolean; error?: string }> {
  if (!isLogin(login)) return { set: null, fresh: false, error: "not a GitHub login" }
  const now = o.now ?? Date.now()
  const prev = cached(login)
  if (prev && !o.force && now - prev.fetchedAt < freshMs()) return { set: prev, fresh: true }
  if (prev && now - prev.triedAt < Math.min(freshMs(), 60_000) && !o.force) return { set: prev, fresh: false, error: "asked too recently" }
  if (!allowFetch(now)) return { set: prev, fresh: false, error: "rate limited" }
  const tried: KeySet = prev ? { ...prev, triedAt: now } : { login, keys: [], fetchedAt: 0, triedAt: now }
  try {
    const res = await fetch(`${githubBase()}/${login}.keys`, {
      headers: { ...(prev?.etag ? { "if-none-match": prev.etag } : {}), "user-agent": "crosstalk" },
      signal: AbortSignal.timeout(10_000),
      redirect: "follow",
    })
    if (res.status === 304 && prev) {
      const k = { ...prev, fetchedAt: now, triedAt: now }
      store(k)
      return { set: k, fresh: true }
    }
    if (res.status === 404) {
      const k: KeySet = { login, keys: [], fetchedAt: now, triedAt: now, missing: true }
      store(k)
      return { set: k, fresh: true }
    }
    if (!res.ok) {
      store(tried)
      return { set: prev, fresh: false, error: `GitHub answered ${res.status}` }
    }
    const body = await res.text()
    if (body.length > 256 * 1024) throw new Error("key list too large")
    const k: KeySet = { login, keys: parseKeys(body), etag: res.headers.get("etag") ?? undefined, fetchedAt: now, triedAt: now }
    store(k)
    return { set: k, fresh: true }
  } catch (e) {
    store(tried)
    return { set: prev, fresh: false, error: `could not reach GitHub: ${(e as Error).message}` }
  }
}

// --- who you are on GitHub ------------------------------------------------------

let loginMemo: { login: string | null; at: number } | null = null

/**
 * Your GitHub login, from the first of: CROSSTALK_GITHUB_LOGIN, git config
 * crosstalk.login, git config github.user, or `gh api user` when gh is
 * installed and signed in. Null when none says, in which case crosstalk falls
 * back to the four words and says so.
 */
export async function ownLogin(cwd?: string): Promise<string | null> {
  const env = process.env.CROSSTALK_GITHUB_LOGIN?.trim().toLowerCase()
  if (env) return isLogin(env) ? env : null
  if (loginMemo && Date.now() - loginMemo.at < 60 * 60 * 1000) return loginMemo.login
  let found: string | null = null
  for (const keyName of ["crosstalk.login", "github.user"]) {
    const r = await run("git", ["config", "--get", keyName], { cwd, timeoutMs: 3000 })
    const v = r.stdout.trim().toLowerCase()
    if (r.code === 0 && isLogin(v)) {
      found = v
      break
    }
  }
  if (!found) {
    const r = await run("gh", ["api", "user", "--jq", ".login"], { cwd, timeoutMs: 8000 })
    const v = r.stdout.trim().toLowerCase()
    if (r.code === 0 && isLogin(v)) found = v
  }
  loginMemo = { login: found, at: Date.now() }
  return found
}

/**
 * The people who can push to a repo, according to GitHub, when gh is signed in
 * and allowed to ask. Null when it cannot say, which is the usual case and is
 * fine: statements only land on the ref by push, so push access is already
 * what decides who is a collaborator. This is a second opinion, not the gate.
 */
export async function collaborators(slug: string, cwd?: string): Promise<Set<string> | null> {
  if (process.env.CROSSTALK_GITHUB_URL || !/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(slug)) return null
  const r = await run("gh", ["api", "--paginate", `repos/${slug}/collaborators?per_page=100`, "--jq", ".[] | select(.permissions.push) | .login"], {
    cwd,
    timeoutMs: 15_000,
  })
  if (r.code !== 0) return null
  return new Set(r.stdout.split("\n").map((l) => l.trim().toLowerCase()).filter(isLogin))
}

// --- the key to sign with -------------------------------------------------------

/**
 * A key that is on your GitHub account and that ssh-keygen can sign with
 * without asking anyone for anything: one held by ssh-agent first, then a key
 * file that has no passphrase. Never reads a private key: only .pub files and
 * `ssh-add -L`, and `ssh-keygen -y` to ask whether a key file opens without a
 * passphrase.
 */
export async function signingKey(accountKeys: string[], scratch: string): Promise<{ key: SigningKey | null; why?: string }> {
  const bin = sshKeygen()
  if (!bin) return { key: null, why: "ssh-keygen is not installed" }
  if (!accountKeys.length) return { key: null, why: "your GitHub account lists no SSH keys" }
  const onAccount = new Set(accountKeys)

  if (process.env.SSH_AUTH_SOCK) {
    const r = await run("ssh-add", ["-L"], { timeoutMs: 5000 })
    if (r.code === 0)
      for (const line of r.stdout.split("\n")) {
        const k = normaliseKey(line)
        if (!k || !onAccount.has(k)) continue
        fs.mkdirSync(scratch, { recursive: true, mode: 0o700 })
        const pub = path.join(scratch, "agent-key.pub")
        fs.writeFileSync(pub, k + "\n", { mode: 0o600 })
        return { key: { path: pub, publicKey: k, agent: true } }
      }
  }

  const candidates = [
    process.env.CROSSTALK_SSH_KEY,
    ...["id_ed25519", "id_ecdsa", "id_rsa", "id_ed25519_sk", "id_ecdsa_sk"].map((n) => path.join(os.homedir(), ".ssh", n)),
  ].filter((p): p is string => !!p)
  let sawOne = false
  for (const priv of candidates) {
    let k: string | null = null
    try {
      k = normaliseKey(fs.readFileSync(`${priv}.pub`, "utf8"))
    } catch {
      continue
    }
    if (!k || !fs.existsSync(priv)) continue
    if (!onAccount.has(k)) continue
    sawOne = true
    // Opens without a passphrase? ssh-keygen reads it; we only see the exit code.
    const probe = await run(bin, ["-y", "-P", "", "-f", priv], { timeoutMs: 5000 })
    if (probe.code === 0) return { key: { path: priv, publicKey: k, agent: false } }
  }
  return {
    key: null,
    why: sawOne
      ? "your SSH key needs a passphrase and is not in ssh-agent (ssh-add it)"
      : "none of your SSH keys here is on your GitHub account",
  }
}

export { quietEnv }
