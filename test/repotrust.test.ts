// Trust through repository access: the statement, its signature, GitHub's key
// list, and every trust decision, without a daemon or a relay.
//
//   bun test test/repotrust.test.ts
//
// Signatures are real: ed25519 keys made by ssh-keygen in a temp dir, signed
// and verified with `ssh-keygen -Y`. Two daemons, a bare repo and a relay are
// test/repotrust.sh.

import { describe, expect, test, beforeAll, afterAll } from "bun:test"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { spawnSync, spawn } from "node:child_process"

const HOME = fs.mkdtempSync(path.join(os.tmpdir(), "ct-repotrust-unit-"))
process.env.CROSSTALK_HOME = HOME
process.env.CROSSTALK_KEYS_MIN_MS = "0"

const S = await import("../src/repotrust/statement.ts")
const D = await import("../src/repotrust/decide.ts")
const G = await import("../src/repotrust/github.ts")
const R = await import("../src/repotrust/gitref.ts")
const { newIdentity, fingerprint } = await import("../src/crypto.ts")

const HAVE_SSH = !!S.sshKeygen()
const KEYS = path.join(HOME, "ssh")
fs.mkdirSync(KEYS, { recursive: true })

function sshKey(name: string, passphrase = ""): { priv: string; pub: string } {
  const priv = path.join(KEYS, name)
  spawnSync("ssh-keygen", ["-q", "-t", "ed25519", "-N", passphrase, "-C", `${name}@test`, "-f", priv])
  return { priv, pub: S.normaliseKey(fs.readFileSync(`${priv}.pub`, "utf8"))! }
}

const ana = newIdentity("ana")
const ben = newIdentity("ben")
const T0 = 1_750_000_000_000

describe("the statement", () => {
  test("has one canonical encoding, in a fixed order", () => {
    const s = S.makeStatement({ login: "Ana", machine: "Ana's MacBook", edPub: ana.ed.pub, xPub: ana.x.pub, created: T0 })
    expect(s.login).toBe("ana")
    expect(s.machine).toBe("ana-s-macbook")
    expect(s.fingerprint).toBe(fingerprint(ana.ed.pub))
    const text = S.canonical(s)
    expect(text.startsWith('{"v":1,"kind":"crosstalk-identity","login":"ana","machine":"ana-s-macbook","fingerprint":')).toBe(true)
    expect(text).not.toContain(" ")
    // Built in another order, encoded the same.
    const shuffled = { created: s.created, xPub: s.xPub, edPub: s.edPub, fingerprint: s.fingerprint, machine: s.machine, login: s.login, kind: s.kind, v: s.v }
    expect(S.canonical(shuffled as any)).toBe(text)
    expect(S.parse(text).ok).toBe(true)
  })

  test("anything but the canonical bytes is refused", () => {
    const s = S.makeStatement({ login: "ana", machine: "desk", edPub: ana.ed.pub, xPub: ana.x.pub, created: T0 })
    const text = S.canonical(s)
    expect(S.parse(JSON.stringify(s, null, 1)).ok).toBe(false)
    expect(S.parse(text.replace("}", ',"admin":true}')).ok).toBe(false)
    const reordered = JSON.stringify({ kind: s.kind, v: s.v, login: s.login, machine: s.machine, fingerprint: s.fingerprint, edPub: s.edPub, xPub: s.xPub, created: s.created })
    expect(S.parse(reordered)).toEqual({ ok: false, reason: "not in canonical form" })
  })

  test("a fingerprint that is not the key's, a key of the wrong type, or a bad login is refused", () => {
    const s = S.makeStatement({ login: "ana", machine: "desk", edPub: ana.ed.pub, xPub: ana.x.pub, created: T0 })
    expect(S.problem({ ...s, fingerprint: fingerprint(ben.ed.pub) })).toMatch(/fingerprint/)
    expect(S.problem({ ...s, xPub: ana.ed.pub })).toMatch(/X25519/)
    expect(S.problem({ ...s, edPub: ana.x.pub })).toMatch(/Ed25519/)
    expect(S.problem({ ...s, login: "-ana" })).toMatch(/login/)
    expect(S.problem({ ...s, login: "a--b" })).toMatch(/login/)
    expect(S.problem({ ...s, machine: "../../heads/main" })).toMatch(/machine/)
    expect(S.problem({ ...s, created: Date.now() + 3 * 86400_000 })).toMatch(/future/)
  })
})

describe("GitHub key lists and allowed signers", () => {
  const ed = "ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIHk2vJq0Y6m8Wq3x6c3bQZ2bJ4j9cU5mO8i6w3sQe1d2"
  test("keys are reduced to type and blob, junk dropped, duplicates once", () => {
    const body = `${ed} comment here\n\nnot a key\nssh-rsa !!!\n${ed}\nssh-rsa AAAAC3NzaC1lZDI1NTE5AAAAIHk2vJq0Y6m8Wq3x6c3bQZ2bJ4j9cU5mO8i6w3sQe1d2\n`
    // The last line claims rsa over an ed25519 blob, which is not that key.
    expect(S.parseKeys(body)).toEqual([ed])
  })
  test("allowed signers: the login, our namespace only, each key", () => {
    expect(S.allowedSigners("marie", [ed, `${ed} dup`, "garbage"])).toBe(`marie namespaces="crosstalk-identity" ${ed}\nmarie namespaces="crosstalk-identity" ${ed}\n`)
    expect(() => S.allowedSigners('marie" evil', [ed])).toThrow()
  })
})

describe.skipIf(!HAVE_SSH)("signing and verifying with ssh-keygen", () => {
  const k1 = HAVE_SSH ? sshKey("ana1") : ({} as any)
  const k2 = HAVE_SSH ? sshKey("ana2") : ({} as any)
  const kb = HAVE_SSH ? sshKey("ben1") : ({} as any)
  const st = S.makeStatement({ login: "ana", machine: "desk", edPub: ana.ed.pub, xPub: ana.x.pub, created: T0 })
  let sig = ""

  beforeAll(async () => {
    const r = await S.sign(st, { path: k1.priv, publicKey: k1.pub, agent: false })
    if (!r.ok) throw new Error(r.reason)
    sig = r.sig
  })

  test("round trip: signed with a key on the account, verified against the account", async () => {
    expect(sig).toContain("BEGIN SSH SIGNATURE")
    expect(S.signerOf(sig)).toBe(k1.pub)
    const v = await S.verify({ login: "ana", machine: "desk", text: S.canonical(st), sig, keys: [k2.pub, k1.pub] })
    expect(v.ok).toBe(true)
    if (v.ok) {
      expect(v.signer).toBe(k1.pub)
      expect(v.statement.fingerprint).toBe(fingerprint(ana.ed.pub))
    }
  })

  test("a key removed from the account no longer verifies", async () => {
    const v = await S.verify({ login: "ana", machine: "desk", text: S.canonical(st), sig, keys: [k2.pub] })
    expect(v).toEqual({ ok: false, reason: "the signature is not from a key on their GitHub account" })
    const none = await S.verify({ login: "ana", machine: "desk", text: S.canonical(st), sig, keys: [] })
    expect(none.ok).toBe(false)
  })

  test("found under someone else's login, it does not verify", async () => {
    // ben pushes ana's statement under his own name: the login inside does not match.
    const v = await S.verify({ login: "ben", machine: "desk", text: S.canonical(st), sig, keys: [k1.pub] })
    expect(v.ok).toBe(false)
    // ben signs a statement claiming to be ana with his own key: not on ana's account.
    const forged = await S.sign(st, { path: kb.priv, publicKey: kb.pub, agent: false })
    expect(forged.ok).toBe(true)
    if (forged.ok) {
      const f = await S.verify({ login: "ana", machine: "desk", text: S.canonical(st), sig: forged.sig, keys: [k1.pub] })
      expect(f.ok).toBe(false)
    }
  })

  test("a changed fingerprint, key, machine or byte breaks the signature", async () => {
    const swapped = S.canonical({ ...st, edPub: ben.ed.pub, fingerprint: fingerprint(ben.ed.pub) })
    expect((await S.verify({ login: "ana", machine: "desk", text: swapped, sig, keys: [k1.pub] })).ok).toBe(false)
    const wrongFp = S.canonical({ ...st, fingerprint: fingerprint(ben.ed.pub) })
    const w = await S.verify({ login: "ana", machine: "desk", text: wrongFp, sig, keys: [k1.pub] })
    expect(w.ok).toBe(false)
    expect((await S.verify({ login: "ana", machine: "laptop", text: S.canonical(st), sig, keys: [k1.pub] })).ok).toBe(false)
    expect((await S.verify({ login: "ana", machine: "desk", text: S.canonical({ ...st, created: T0 + 1 }), sig, keys: [k1.pub] })).ok).toBe(false)
  })

  test("a signature made in another namespace (a git commit signature, say) is refused", async () => {
    const r = spawnSync("ssh-keygen", ["-Y", "sign", "-n", "git", "-f", k1.priv], { input: S.canonical(st), encoding: "utf8" })
    const v = await S.verify({ login: "ana", machine: "desk", text: S.canonical(st), sig: r.stdout, keys: [k1.pub] })
    expect(v.ok).toBe(false)
  })

  test("the key to sign with: one on the account that opens without a passphrase", async () => {
    const locked = sshKey("locked", "hunter22")
    const saved = { key: process.env.CROSSTALK_SSH_KEY, sock: process.env.SSH_AUTH_SOCK }
    delete process.env.SSH_AUTH_SOCK
    try {
      process.env.CROSSTALK_SSH_KEY = k1.priv
      expect((await G.signingKey([k1.pub], path.join(HOME, "scratch"))).key?.path).toBe(k1.priv)
      expect((await G.signingKey([k2.pub], path.join(HOME, "scratch"))).key).toBeNull()
      process.env.CROSSTALK_SSH_KEY = locked.priv
      const r = await G.signingKey([locked.pub], path.join(HOME, "scratch"))
      expect(r.key).toBeNull()
      expect(r.why).toMatch(/passphrase/)
    } finally {
      if (saved.key) process.env.CROSSTALK_SSH_KEY = saved.key
      else delete process.env.CROSSTALK_SSH_KEY
      if (saved.sock) process.env.SSH_AUTH_SOCK = saved.sock
    }
  })

  test("ssh-agent: a passphrase key in the agent signs, and is never read", async () => {
    const agentBin = spawnSync("sh", ["-c", "command -v ssh-agent"], { encoding: "utf8" }).stdout.trim()
    if (!agentBin) return
    const locked = sshKey("agented", "hunter22")
    const sock = path.join(HOME, "agent.sock")
    const agent = spawn(agentBin, ["-D", "-a", sock], { stdio: "ignore" })
    try {
      for (let i = 0; i < 50 && !fs.existsSync(sock); i++) await Bun.sleep(50)
      // Add it the way a person would, with the passphrase given to ssh-add.
      const askpass = path.join(HOME, "askpass.sh")
      fs.writeFileSync(askpass, "#!/bin/sh\necho hunter22\n", { mode: 0o700 })
      const add = spawnSync("ssh-add", [locked.priv], {
        env: { ...process.env, SSH_AUTH_SOCK: sock, SSH_ASKPASS: askpass, SSH_ASKPASS_REQUIRE: "force", DISPLAY: ":0" },
        encoding: "utf8",
      })
      expect(add.status).toBe(0)
      const saved = process.env.SSH_AUTH_SOCK
      process.env.SSH_AUTH_SOCK = sock
      try {
        const k = await G.signingKey([locked.pub], path.join(HOME, "scratch"))
        expect(k.key?.agent).toBe(true)
        const r = await S.sign(st, k.key!)
        expect(r.ok).toBe(true)
        if (r.ok) expect((await S.verify({ login: "ana", machine: "desk", text: S.canonical(st), sig: r.sig, keys: [locked.pub] })).ok).toBe(true)
      } finally {
        if (saved) process.env.SSH_AUTH_SOCK = saved
        else delete process.env.SSH_AUTH_SOCK
      }
    } finally {
      agent.kill()
    }
  })
})

describe("trust decisions", () => {
  const K1 = "ssh-ed25519 K1"
  const K2 = "ssh-ed25519 K2"
  const ana2 = newIdentity("ana")
  const st = (id: typeof ana, machine: string, created = T0, login = "ana") =>
    ({ v: 1, kind: "crosstalk-identity", login, machine, fingerprint: fingerprint(id.ed.pub), edPub: id.ed.pub, xPub: id.x.pub, created }) as any
  const seen = (id: typeof ana, machine: string, signer = K1, created = T0, login = "ana"): any => ({ login, machine, statement: st(id, machine, created, login), signer })
  const fresh = (...keys: string[]) => ({ ana: { keys, fresh: true } })

  const first = D.decide({ pins: {}, members: {}, seen: [seen(ana, "desk")], keys: fresh(K1), fetchOk: true })

  test("first sight: every verified statement is trusted, and pinned", () => {
    expect(first.firstSight).toEqual(["ana"])
    expect(Object.keys(first.members)).toEqual(["ana/desk"])
    expect(first.pins.ana.keys).toEqual([K1])
    expect(first.pins.ana.machines.desk.fingerprint).toBe(fingerprint(ana.ed.pub))
    expect(first.questions).toEqual([])
  })

  test("the same again is the same, with nothing asked", () => {
    const again = D.decide({ pins: first.pins, members: first.members, seen: [seen(ana, "desk")], keys: fresh(K1), fetchOk: true })
    expect(again.members).toEqual(first.members)
    expect(again.questions.length + again.revoked.length).toBe(0)
  })

  test("a new crosstalk key on the same machine is a question, and the old one stays trusted meanwhile", () => {
    const out = D.decide({ pins: first.pins, members: first.members, seen: [seen(ana2, "desk", K1, T0 + 10)], keys: fresh(K1), fetchOk: true })
    expect(out.questions.map((q) => q.kind)).toEqual(["changed"])
    expect(out.questions[0].was).toBe(fingerprint(ana.ed.pub))
    expect(out.members["ana/desk"].fingerprint).toBe(fingerprint(ana.ed.pub))
    // Yes: the new one replaces it.
    const yes = D.answer(out.pins, out.questions[0], true)
    expect(yes.ana.machines.desk.fingerprint).toBe(fingerprint(ana2.ed.pub))
    const after = D.decide({ pins: yes, members: out.members, seen: [seen(ana2, "desk", K1, T0 + 10)], keys: fresh(K1), fetchOk: true })
    expect(after.questions).toEqual([])
    expect(after.members["ana/desk"].fingerprint).toBe(fingerprint(ana2.ed.pub))
    // No: never asked again, the old one still trusted.
    const no = D.answer(out.pins, out.questions[0], false)
    const later = D.decide({ pins: no, members: out.members, seen: [seen(ana2, "desk", K1, T0 + 10)], keys: fresh(K1), fetchOk: true })
    expect(later.questions).toEqual([])
    expect(later.members["ana/desk"].fingerprint).toBe(fingerprint(ana.ed.pub))
  })

  test("a new machine vouched for by a pinned key is the same person: trusted", () => {
    const out = D.decide({ pins: first.pins, members: first.members, seen: [seen(ana, "desk"), seen(ana2, "laptop")], keys: fresh(K1), fetchOk: true })
    expect(Object.keys(out.members).sort()).toEqual(["ana/desk", "ana/laptop"])
    expect(out.questions).toEqual([])
  })

  test("a new machine vouched for by a key new on GitHub is a question", () => {
    const out = D.decide({ pins: first.pins, members: first.members, seen: [seen(ana, "desk"), seen(ana2, "laptop", K2)], keys: fresh(K1, K2), fetchOk: true })
    expect(out.questions.map((q) => `${q.kind} ${q.machine}`)).toEqual(["new-key laptop"])
    expect(out.members["ana/laptop"]).toBeUndefined()
    // A key that was added but signs nothing is not pinned by being seen.
    expect(out.pins.ana.keys).toEqual([K1])
  })

  test("a pinned key removed from GitHub revokes what it signed", () => {
    // GitHub now lists only K2; nothing ana/desk claims verifies, so it is not seen.
    const out = D.decide({ pins: first.pins, members: first.members, seen: [], keys: fresh(K2), fetchOk: true })
    expect(out.revoked.map((r) => r.machine)).toEqual(["desk"])
    expect(out.revoked[0].why).toMatch(/removed from their GitHub/)
    expect(out.members).toEqual({})
    expect(out.pins.ana.keys).toEqual([])
    // And the same fingerprint coming back later is a question, not a quiet return.
    const back = D.decide({ pins: out.pins, members: {}, seen: [seen(ana, "desk", K2, T0 + 5)], keys: fresh(K2), fetchOk: true })
    expect(back.questions.map((q) => q.kind)).toEqual(["returned"])
  })

  test("a statement removed from the ref is revoked; not while offline", () => {
    const gone = D.decide({ pins: first.pins, members: first.members, seen: [], keys: fresh(K1), fetchOk: true })
    expect(gone.revoked.map((r) => r.why)).toEqual(["its statement was removed from the repository"])
    expect(gone.members).toEqual({})
    const offline = D.decide({ pins: first.pins, members: first.members, seen: [], keys: { ana: { keys: [K1], fresh: false } }, fetchOk: false })
    expect(offline.revoked).toEqual([])
    expect(Object.keys(offline.members)).toEqual(["ana/desk"])
    const unknown = D.decide({ pins: first.pins, members: first.members, seen: [], keys: {}, fetchOk: true })
    expect(Object.keys(unknown.members)).toEqual(["ana/desk"])
  })

  test("a cached key list cannot revoke a key", () => {
    const out = D.decide({ pins: first.pins, members: first.members, seen: [seen(ana, "desk")], keys: { ana: { keys: [K2], fresh: false } }, fetchOk: true })
    expect(out.pins.ana.keys).toEqual([K1])
    expect(out.revoked).toEqual([])
  })

  test("an older statement than the one trusted is ignored, not a question", () => {
    const newer = D.decide({ pins: {}, members: {}, seen: [seen(ana, "desk", K1, T0 + 100)], keys: fresh(K1), fetchOk: true })
    const rolled = D.decide({ pins: newer.pins, members: newer.members, seen: [seen(ana2, "desk", K1, T0)], keys: fresh(K1), fetchOk: true })
    expect(rolled.questions).toEqual([])
    expect(rolled.ignored[0].why).toMatch(/older/)
  })

  test("one person's pins do not leak into another's", () => {
    const out = D.decide({
      pins: first.pins,
      members: first.members,
      seen: [seen(ana, "desk"), seen(ben, "desk", K1, T0, "ben")],
      keys: { ana: { keys: [K1], fresh: true }, ben: { keys: [K1], fresh: true } },
      fetchOk: true,
    })
    expect(out.firstSight).toEqual(["ben"])
    expect(Object.keys(out.members).sort()).toEqual(["ana/desk", "ben/desk"])
  })
})

describe("GitHub key fetch and cache", () => {
  let server: ReturnType<typeof Bun.serve>
  let hits: string[] = []
  let body = "ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIHk2vJq0Y6m8Wq3x6c3bQZ2bJ4j9cU5mO8i6w3sQe1d2 a\n"
  beforeAll(() => {
    server = Bun.serve({
      port: 0,
      fetch(req) {
        const u = new URL(req.url)
        hits.push(`${u.pathname} ${req.headers.get("if-none-match") ?? "-"}`)
        if (u.pathname === "/ghost.keys") return new Response("Not Found", { status: 404 })
        const etag = `"${Bun.hash(body)}"`
        if (req.headers.get("if-none-match") === etag) return new Response(null, { status: 304, headers: { etag } })
        return new Response(body, { headers: { etag } })
      },
    })
    process.env.CROSSTALK_GITHUB_URL = `http://127.0.0.1:${server.port}`
  })
  afterAll(() => {
    server.stop(true)
    delete process.env.CROSSTALK_GITHUB_URL
  })

  test("fetches, caches with the ETag, and asks with it next time", async () => {
    const a = await G.keysFor("marie", { force: true })
    expect(a.fresh).toBe(true)
    expect(a.set?.keys.length).toBe(1)
    const b = await G.keysFor("marie", { force: true })
    expect(b.fresh).toBe(true)
    expect(hits.at(-1)).toMatch(/^\/marie\.keys "/)
    body = ""
    const c = await G.keysFor("marie", { force: true })
    expect(c.set?.keys).toEqual([])
  })

  test("a login GitHub does not know has no keys", async () => {
    const r = await G.keysFor("ghost", { force: true })
    expect(r.fresh).toBe(true)
    expect(r.set?.missing).toBe(true)
  })

  test("offline: the cache answers, marked not fresh", async () => {
    body = "ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIHk2vJq0Y6m8Wq3x6c3bQZ2bJ4j9cU5mO8i6w3sQe1d2 a\n"
    await G.keysFor("pat", { force: true })
    process.env.CROSSTALK_GITHUB_URL = "http://127.0.0.1:1"
    const r = await G.keysFor("pat", { force: true })
    expect(r.fresh).toBe(false)
    expect(r.set?.keys.length).toBe(1)
    expect(r.error).toMatch(/could not reach/)
    process.env.CROSSTALK_GITHUB_URL = `http://127.0.0.1:${server.port}`
  })

  test("only real logins are ever put in a URL", async () => {
    const r = await G.keysFor("../../evil")
    expect(r.set).toBeNull()
  })
})

describe("GitHub remotes", () => {
  test("every spelling of a GitHub remote names the same repo", () => {
    for (const u of [
      "git@github.com:Acme/API.git",
      "ssh://git@github.com/acme/api",
      "https://github.com/acme/api.git",
      "https://user@github.com/acme/api/",
    ])
      expect(R.githubSlug(u)).toBe("acme/api")
    expect(R.githubSlug("git@gitlab.com:acme/api.git")).toBeNull()
    expect(R.githubSlug("https://github.com.evil.example/acme/api")).toBeNull()
  })
})
