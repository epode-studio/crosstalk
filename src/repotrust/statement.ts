// The statement that binds one machine's crosstalk identity to a GitHub person.
//
//   {"v":1,"kind":"crosstalk-identity","login":"marie","machine":"laptop",
//    "fingerprint":"…","edPub":"…","xPub":"…","created":1767225600000}
//
// Each machine keeps its own crosstalk identity, as it always has. What is new
// is that the person signs a statement naming it, with the SSH key they already
// push with, so anyone who can read GitHub's list of that person's keys can
// check that this crosstalk key belongs to them. Signing and checking are done
// by `ssh-keygen -Y sign` / `-Y verify`, under a namespace of our own so that a
// signature made for git commits, or for anything else, can never be passed off
// as one of these, nor one of these as a commit signature.
//
// crosstalk never reads a private key. It hands ssh-keygen a path (or a public
// key whose private half is in ssh-agent) and ssh-keygen does the rest.

import crypto from "node:crypto"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { execFile } from "node:child_process"
import { fingerprint } from "../crypto.ts"

export const NAMESPACE = "crosstalk-identity"
export const KIND = "crosstalk-identity"

export type Statement = {
  v: 1
  kind: typeof KIND
  /** GitHub login, lowercased. */
  login: string
  /** This machine's name, as it appears in the ref. */
  machine: string
  /** fingerprint(edPub), repeated so a reader can see it without decoding keys. */
  fingerprint: string
  /** crosstalk Ed25519 public key, SPKI DER base64. */
  edPub: string
  /** crosstalk X25519 public key, SPKI DER base64. */
  xPub: string
  /** When it was signed, ms since the epoch. A newer statement replaces an older one. */
  created: number
}

/** GitHub's own rule: alphanumerics and single hyphens, at most 39, no leading hyphen. */
export const isLogin = (s: unknown): s is string =>
  typeof s === "string" && /^[a-z0-9](?:[a-z0-9]|-(?=[a-z0-9])){0,38}$/.test(s)

/** What may appear as one ref path component for a machine. */
export const isMachine = (s: unknown): s is string => typeof s === "string" && /^[a-z0-9](?:[a-z0-9-]{0,62})$/.test(s)

export const cleanMachine = (s: string) =>
  s.trim().toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 63) || "machine"

/**
 * The one byte sequence that gets signed. Keys in a fixed order, no
 * whitespace, nothing else. A reader re-encodes what it parsed and compares,
 * so a statement carrying an extra field, a reordering or a second spelling of
 * the same value does not verify: there is exactly one encoding of each
 * statement, and that is the one the signature covers.
 */
export function canonical(s: Statement): string {
  return JSON.stringify({
    v: s.v,
    kind: s.kind,
    login: s.login,
    machine: s.machine,
    fingerprint: s.fingerprint,
    edPub: s.edPub,
    xPub: s.xPub,
    created: s.created,
  })
}

const isKey = (b64: string, type: "ed25519" | "x25519") => {
  try {
    return crypto.createPublicKey({ key: Buffer.from(b64, "base64"), type: "spki", format: "der" }).asymmetricKeyType === type
  } catch {
    return false
  }
}

export function makeStatement(o: { login: string; machine: string; edPub: string; xPub: string; created?: number }): Statement {
  const s: Statement = {
    v: 1,
    kind: KIND,
    login: o.login.toLowerCase(),
    machine: cleanMachine(o.machine),
    fingerprint: fingerprint(o.edPub),
    edPub: o.edPub,
    xPub: o.xPub,
    created: o.created ?? Date.now(),
  }
  const bad = problem(s)
  if (bad) throw new Error(`cannot make that statement: ${bad}`)
  return s
}

/** Why a parsed statement is not well formed, or null. Says nothing about who signed it. */
export function problem(s: Statement, now = Date.now()): string | null {
  if (s.v !== 1 || s.kind !== KIND) return "not a crosstalk identity statement"
  if (!isLogin(s.login)) return "the login is not a GitHub login"
  if (!isMachine(s.machine)) return "the machine name is not usable"
  if (typeof s.edPub !== "string" || !isKey(s.edPub, "ed25519")) return "the identity key is not an Ed25519 key"
  if (typeof s.xPub !== "string" || !isKey(s.xPub, "x25519")) return "the encryption key is not an X25519 key"
  if (s.fingerprint !== fingerprint(s.edPub)) return "the fingerprint does not match the key"
  if (!Number.isSafeInteger(s.created) || s.created <= 0) return "no signing date"
  if (s.created > now + 24 * 60 * 60 * 1000) return "signed in the future"
  return null
}

/** Parse exactly the canonical encoding, or say why not. */
export function parse(text: string): { ok: true; statement: Statement } | { ok: false; reason: string } {
  let s: Statement
  try {
    s = JSON.parse(text)
  } catch {
    return { ok: false, reason: "not JSON" }
  }
  if (!s || typeof s !== "object") return { ok: false, reason: "not an object" }
  const bad = problem(s)
  if (bad) return { ok: false, reason: bad }
  if (canonical(s) !== text) return { ok: false, reason: "not in canonical form" }
  return { ok: true, statement: s }
}

// --- SSH keys and signatures --------------------------------------------------

const KEY_TYPES =
  /^(ssh-ed25519|ssh-rsa|ecdsa-sha2-nistp256|ecdsa-sha2-nistp384|ecdsa-sha2-nistp521|sk-ssh-ed25519@openssh\.com|sk-ecdsa-sha2-nistp256@openssh\.com)$/

/**
 * One public key as "type base64", comment dropped, or null. This is the form
 * keys are compared and pinned in: GitHub serves exactly that, and an
 * authorized_keys line or a .pub file reduces to it.
 */
export function normaliseKey(line: string): string | null {
  const parts = line.trim().split(/\s+/)
  if (parts.length < 2) return null
  const [type, b64] = parts
  if (!KEY_TYPES.test(type) || !/^[A-Za-z0-9+/]+={0,2}$/.test(b64)) return null
  // The blob names its own type; a line that says otherwise is not that key.
  try {
    const blob = Buffer.from(b64, "base64")
    const n = blob.readUInt32BE(0)
    if (blob.subarray(4, 4 + n).toString("latin1") !== type) return null
  } catch {
    return null
  }
  return `${type} ${b64}`
}

/** Every usable key in a body like github.com/<login>.keys, deduplicated, in order. */
export function parseKeys(body: string): string[] {
  const out: string[] = []
  for (const l of body.split(/\r?\n/)) {
    const k = normaliseKey(l)
    if (k && !out.includes(k)) out.push(k)
  }
  return out
}

/**
 * The allowed-signers file for one person: each of their keys, allowed to sign
 * only in our namespace, under their login as the principal.
 */
export function allowedSigners(login: string, keys: string[]): string {
  if (!isLogin(login)) throw new Error("not a GitHub login")
  return keys
    .map(normaliseKey)
    .filter((k): k is string => !!k)
    .map((k) => `${login} namespaces="${NAMESPACE}" ${k}\n`)
    .join("")
}

/**
 * The public key a signature says made it, as "type base64". This is read out
 * of the signature itself (the SSHSIG blob carries the signer's public key) and
 * is only meaningful after ssh-keygen has verified the signature against the
 * allowed signers, which is what ties it to a key on the person's account.
 */
export function signerOf(armored: string): string | null {
  const m = armored.match(/-----BEGIN SSH SIGNATURE-----([\s\S]*?)-----END SSH SIGNATURE-----/)
  if (!m) return null
  try {
    const raw = Buffer.from(m[1].replace(/\s+/g, ""), "base64")
    if (raw.subarray(0, 6).toString("latin1") !== "SSHSIG") return null
    let at = 6 + 4 // magic, then a uint32 version
    const n = raw.readUInt32BE(at)
    const blob = raw.subarray(at + 4, at + 4 + n)
    if (blob.length !== n) return null
    const tn = blob.readUInt32BE(0)
    const type = blob.subarray(4, 4 + tn).toString("latin1")
    return normaliseKey(`${type} ${blob.toString("base64")}`)
  } catch {
    return null
  }
}

/** Where ssh-keygen is, or null. Everything here degrades to "use the four words" without it. */
export function sshKeygen(): string | null {
  const bin = process.env.CROSSTALK_SSH_KEYGEN ?? "ssh-keygen"
  if (bin.includes("/")) return fs.existsSync(bin) ? bin : null
  for (const dir of (process.env.PATH ?? "").split(path.delimiter)) {
    const p = path.join(dir, bin)
    try {
      fs.accessSync(p, fs.constants.X_OK)
      return p
    } catch {}
  }
  return null
}

/**
 * An environment ssh tools cannot stop and ask a person anything in. The daemon
 * has nobody at a terminal; a key that needs a passphrase and is not in the
 * agent is simply not usable from here.
 */
export function quietEnv(): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env, SSH_ASKPASS_REQUIRE: "never", GIT_TERMINAL_PROMPT: "0", GCM_INTERACTIVE: "never" }
  delete env.SSH_ASKPASS
  delete env.DISPLAY
  return env
}

export function run(
  file: string,
  args: string[],
  o: { input?: string; cwd?: string; env?: NodeJS.ProcessEnv; timeoutMs?: number } = {},
): Promise<{ code: number; stdout: string; stderr: string }> {
  return new Promise((resolve) => {
    const child = execFile(
      file,
      args,
      { cwd: o.cwd, env: o.env ?? quietEnv(), timeout: o.timeoutMs ?? 15_000, maxBuffer: 4 << 20, encoding: "utf8" },
      (err, stdout, stderr) => {
        const code = err ? (typeof (err as any).code === "number" ? (err as any).code : 1) : 0
        resolve({ code, stdout: String(stdout ?? ""), stderr: String(stderr ?? "") })
      },
    )
    // Without this, a child waiting on stdin would wait for the timeout.
    child.stdin?.end(o.input ?? "")
  })
}

const tmpDir = () => fs.mkdtempSync(path.join(os.tmpdir(), "crosstalk-sig-"))

/** A key ssh-keygen can sign with: a private key file, or a public key whose private half is in the agent. */
export type SigningKey = { path: string; publicKey: string; agent: boolean }

/** Sign the canonical statement. Returns the armored signature, or an error a person can act on. */
export async function sign(s: Statement, key: SigningKey): Promise<{ ok: true; sig: string } | { ok: false; reason: string }> {
  const bin = sshKeygen()
  if (!bin) return { ok: false, reason: "ssh-keygen is not installed" }
  const r = await run(bin, ["-Y", "sign", "-n", NAMESPACE, "-f", key.path], { input: canonical(s) })
  if (r.code !== 0 || !r.stdout.includes("BEGIN SSH SIGNATURE"))
    return { ok: false, reason: `ssh-keygen could not sign: ${r.stderr.trim().split("\n").pop() || `exit ${r.code}`}` }
  return { ok: true, sig: r.stdout }
}

export type Verified = { ok: true; statement: Statement; signer: string } | { ok: false; reason: string }

/**
 * Check one statement as found under refs/crosstalk/keys/<login>/<machine>
 * against the keys GitHub lists for <login>.
 *
 * Everything that can be checked without a signature is checked first: the
 * encoding, that the statement names the same login and machine as the ref it
 * was found under, that the fingerprint is the key's. Then ssh-keygen checks
 * the signature, in our namespace, with only that person's keys allowed.
 */
export async function verify(o: {
  login: string
  machine: string
  text: string
  sig: string
  keys: string[]
  now?: number
}): Promise<Verified> {
  const p = parse(o.text)
  if (!p.ok) return p
  const s = p.statement
  if (s.login !== o.login) return { ok: false, reason: `signed for ${s.login}, found under ${o.login}` }
  if (s.machine !== o.machine) return { ok: false, reason: `names machine ${s.machine}, found under ${o.machine}` }
  const bad = problem(s, o.now)
  if (bad) return { ok: false, reason: bad }
  const signers = allowedSigners(o.login, o.keys)
  if (!signers) return { ok: false, reason: `${o.login} lists no SSH keys on GitHub` }
  const signer = signerOf(o.sig)
  if (!signer) return { ok: false, reason: "not an SSH signature" }
  const bin = sshKeygen()
  if (!bin) return { ok: false, reason: "ssh-keygen is not installed" }
  const dir = tmpDir()
  try {
    const allowed = path.join(dir, "allowed_signers")
    const sigFile = path.join(dir, "statement.sig")
    fs.writeFileSync(allowed, signers, { mode: 0o600 })
    fs.writeFileSync(sigFile, o.sig, { mode: 0o600 })
    const r = await run(bin, ["-Y", "verify", "-f", allowed, "-I", o.login, "-n", NAMESPACE, "-s", sigFile], {
      input: o.text,
    })
    if (r.code !== 0) return { ok: false, reason: "the signature is not from a key on their GitHub account" }
    // ssh-keygen accepted it, so the signer is one of the allowed keys; check
    // anyway, since it is what gets pinned.
    if (!o.keys.map(normaliseKey).includes(signer)) return { ok: false, reason: "signed by a key that is not on their account" }
    return { ok: true, statement: s, signer }
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
}

/** Short form of a key for showing a person: type and the last few characters. */
export const keyHint = (k: string) => {
  const [type, b64] = k.split(" ")
  const fp = crypto.createHash("sha256").update(Buffer.from(b64 ?? "", "base64")).digest("base64").replace(/=+$/, "")
  return `${type?.replace(/^ssh-/, "")} SHA256:${fp.slice(0, 12)}…`
}
