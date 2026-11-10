// Threads: the file format, sealing, the git ref, finding sessions, merging,
// fading and combining.
//
//   bun test test/threads.test.ts
//
// Two daemons talking over a real relay with real repos is test/threads.sh.
// Here two ThreadServices are wired straight to each other, which covers the
// same rules in milliseconds.

import { afterAll, describe, expect, test } from "bun:test"
import { spawnSync } from "node:child_process"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import * as M from "../src/threads/model.ts"
import * as F from "../src/threads/format.ts"
import * as S from "../src/threads/store.ts"
import * as I from "../src/threads/infer.ts"
import { newKey, sealSection, unwrapKey, wrapKey } from "../src/threads/seal.ts"
import { ThreadService, NEW_THREAD, type LocalSession } from "../src/threads/service.ts"
import { fingerprint, newIdentity } from "../src/crypto.ts"
import type { Identity, Peer } from "../src/config.ts"
import type { Envelope } from "../src/protocol.ts"

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), "ct-threads-"))
afterAll(() => fs.rmSync(TMP, { recursive: true, force: true }))

const asPeer = (id: Identity): Peer => ({ label: id.label, edPub: id.ed.pub, xPub: id.x.pub, fingerprint: fingerprint(id.ed.pub), joinedAt: 0 })

function sample(by = "aaaa", label = "paul"): M.Thread {
  const t = M.create({ name: "auth", repo: "github.com/acme/api", by, label, now: Date.parse("2026-11-01") })
  M.put(t, "files", "src/auth/**", { at: 1 }, by)
  M.put(t, "files", "src/api/tokens.ts", { at: 2 }, by)
  M.put(t, "branches", "token-v2", { at: 1 }, by)
  M.put(t, "people", "bbbb", { label: "marie" }, by)
  M.put(t, "features", "v2-token-format", { name: "v2 token format", risk: "risky", flag: "auth-v2-tokens" }, by)
  M.put(t, "features", "tidy-token-parser", { name: "tidy token parser", risk: "everyday" }, by)
  M.setRecap(t, by, "Moving tokens to v2 format; v1 kept for one release.")
  M.put(t, "questions", "q_1", { text: "keep the v1 endpoint?", blocking: true, who: "paul", at: 3 }, by)
  M.put(t, "notes", "d_1", { kind: "decision", text: "v1 tokens accepted until 0.2", who: "paul", at: Date.parse("2026-11-01") }, by)
  M.put(t, "notes", "f_1", { kind: "fact", text: "staging DB is shared with the demo env --> careful", who: "marie", at: 4 }, by)
  M.put(t, "notes", "t_1", { kind: "task", text: "remove v1 parser after 0.2", who: "paul", at: 5, state: "open" }, by)
  M.put(t, "notes", "r_1", { kind: "rule", text: "always keep one release of overlap", who: "paul", at: 6 }, by)
  return t
}

// --- format ---------------------------------------------------------------------

describe("format", () => {
  test("a public thread round-trips exactly, and reads as the design's markdown", () => {
    const t = sample()
    M.setMeta(t, "aaaa", { public: true })
    const text = F.renderPublic(t)
    expect(text).toContain("status: active")
    expect(text).toContain("people: [paul, marie]")
    expect(text).toContain("## Notes\n")
    expect(text).toContain("- decision · 2026-11-01 · paul · v1 tokens accepted until 0.2")
    expect(text).toContain("- keep the v1 endpoint? (blocking)")
    expect(text).toContain("  - name: v2 token format\n    risk: risky\n    flag: auth-v2-tokens")
    const p = F.parse(text)
    expect(p.kind).toBe("public")
    if (p.kind === "public") expect(M.same(p.thread, t)).toBe(true)
  })

  test("a hand-written public file is read from its markdown", () => {
    const text = `---
crosstalk: thread/v1
id: 0123456789abcdef
name: auth
status: waiting          # active · waiting · done · archived
people: [paul, marie]
files: [src/auth/**, src/api/tokens.ts]
branches: [token-v2]
features:
  - name: v2 token format
    risk: risky
    flag: auth-v2-tokens     # provider, at internal
  - name: tidy token parser  # everyday, shipped on merge
---

## Recap
Moving tokens to v2 format; v1 kept for one release.

## Questions
- keep the v1 endpoint? (blocking)

## Decisions
- 2026-11-01 · paul · v1 tokens accepted until 0.2

## Tasks
- [ ] remove v1 parser after 0.2
`
    const p = F.parse(text)
    expect(p.kind).toBe("public")
    if (p.kind !== "public") return
    const v = M.view(p.thread)
    expect(v.status).toBe("waiting")
    expect(v.people.sort()).toEqual(["marie", "paul"])
    expect(v.files).toEqual(["src/auth/**", "src/api/tokens.ts"])
    // Features are kept by id, so every replica lists them in the same order.
    expect(v.features).toEqual([
      { name: "tidy token parser", risk: "everyday" },
      { name: "v2 token format", risk: "risky", flag: "auth-v2-tokens" },
    ])
    expect(v.questions[0]).toMatchObject({ text: "keep the v1 endpoint?", blocking: true })
    expect(v.notes.find((n) => n.kind === "decision")).toMatchObject({ text: "v1 tokens accepted until 0.2", who: "paul" })
    expect(v.notes.find((n) => n.kind === "task")).toMatchObject({ text: "remove v1 parser after 0.2", state: "open" })
    // Anything crosstalk knows outranks a hand edit: every stamp is zero.
    expect(p.thread.meta.l).toBe(0)
  })
})

// --- sealing -------------------------------------------------------------------

describe("sealing", () => {
  const paul = newIdentity("paul")
  const marie = newIdentity("marie")
  const eve = newIdentity("eve")

  test("each section is sealed, nothing readable is left, and only the thread's people can open it", () => {
    const t = sample(fingerprint(paul.ed.pub))
    const key = newKey()
    const wraps = wrapKey(paul, key, [asPeer(marie)])
    const text = F.renderSealed(t, key, wraps)
    for (const leak of ["auth", "v1 tokens", "marie", "staging", "token-v2", "acme"]) expect(text).not.toContain(leak)
    for (const s of M.SECTIONS) expect(text).toMatch(new RegExp(`^${s}: \\S+$`, "m"))
    const p = F.parse(text)
    expect(p.kind).toBe("sealed")
    if (p.kind !== "sealed") return
    // Marie unwraps with the key she shares with paul; eve shares none.
    const k = unwrapKey(marie, p.wraps, [asPeer(paul)])
    expect(k?.equals(key)).toBe(true)
    expect(unwrapKey(eve, p.wraps, [asPeer(paul)])).toBeNull()
    expect(M.same(p.open(k!), t)).toBe(true)
    expect(p.open(newKey())).toBeNull()
    // Paul's own wrap opens for paul.
    expect(unwrapKey(paul, p.wraps, [])?.equals(key)).toBe(true)
  })

  test("with a caching sealer, an edit to one section changes one line", () => {
    const t = sample()
    // Stands in for the service's sealer: the same content, the same blob.
    const blobs = new Map<string, string>()
    const sealing: F.Sealer = (s, v) => {
      const h = s + M.canonical(v)
      if (!blobs.has(h)) blobs.set(h, `${s}-${blobs.size}`)
      return blobs.get(h)!
    }
    const before = F.renderSealed(t, sealing, []).split("\n")
    M.put(t, "notes", "d_2", { kind: "decision", text: "drop v1 in 0.3", who: "marie", at: 9 }, "bbbb")
    const after = F.renderSealed(t, sealing, []).split("\n")
    const changed = after.filter((l, i) => l !== before[i]).map((l) => l.split(":")[0])
    expect(changed.sort()).toEqual(["clock", "notes"])
  })

  test("a public thread is plain text", () => {
    const t = sample()
    M.setMeta(t, "aaaa", { public: true })
    expect(F.renderPublic(t)).toContain("v1 tokens accepted until 0.2")
    expect(F.fileName(t)).toBe("auth.md")
    M.setMeta(t, "aaaa", { public: false })
    expect(F.fileName(t)).toBe(`${t.id}.md`)
  })
})

// --- merging -----------------------------------------------------------------------

describe("clocks and merge", () => {
  test("merge is commutative, associative and idempotent", () => {
    const base = sample("aaaa")
    const a = structuredClone(base)
    const b = structuredClone(base)
    const c = structuredClone(base)
    M.put(a, "notes", "d_a", { kind: "decision", text: "from a", who: "paul", at: 10 }, "aaaa")
    M.put(b, "notes", "d_b", { kind: "decision", text: "from b", who: "marie", at: 11 }, "bbbb")
    M.setMeta(c, "cccc", { status: "waiting" })
    const ab = M.merge(a, b)
    expect(M.same(ab, M.merge(b, a))).toBe(true)
    expect(M.same(M.merge(ab, c), M.merge(a, M.merge(b, c)))).toBe(true)
    expect(M.same(M.merge(ab, ab), ab)).toBe(true)
    // Concurrent appends to one section both survive.
    expect(M.ids(ab, "notes")).toEqual(expect.arrayContaining(["d_1", "d_a", "d_b"]))
  })

  test("a scalar section goes to the higher clock, ties to the higher author", () => {
    const base = sample("aaaa")
    const a = structuredClone(base)
    const b = structuredClone(base)
    M.setMeta(a, "aaaa", { status: "done" })
    M.setMeta(b, "bbbb", { status: "waiting" })
    // Same Lamport value: bbbb > aaaa.
    expect(M.merge(a, b).meta.value.status).toBe("waiting")
    expect(M.merge(b, a).meta.value.status).toBe("waiting")
    // A later edit on a outranks b whatever the authors.
    M.setMeta(a, "aaaa", { status: "active" })
    M.setMeta(a, "aaaa", { status: "done" })
    expect(M.merge(a, b).meta.value.status).toBe("done")
  })

  test("a removal wins over the stale add it replaced", () => {
    const a = sample("aaaa")
    const b = structuredClone(a)
    M.remove(a, "notes", "t_1", "aaaa")
    expect(M.notes(M.merge(a, b), "task")).toEqual([])
    expect(M.notes(M.merge(b, a), "task")).toEqual([])
  })

  test("a repeated observation is not an edit", () => {
    const t = sample()
    const l = t.lamport
    expect(M.put(t, "files", "src/auth/**", { at: 1 }, "aaaa")).toBe(false)
    expect(t.lamport).toBe(l)
  })

  test("only status, features, decisions, questions and rules earn a commit", () => {
    const t = sample()
    const d = M.committedDigest(t)
    M.put(t, "files", "src/x.ts", { at: 1 }, "aaaa")
    M.put(t, "notes", "f_9", { kind: "fact", text: "x", who: "paul", at: 1 }, "aaaa")
    expect(M.committedDigest(t)).toBe(d)
    M.put(t, "notes", "d_9", { kind: "decision", text: "y", who: "paul", at: 1 }, "aaaa")
    expect(M.committedDigest(t)).not.toBe(d)
  })

  test("a malformed thread from a peer is refused", () => {
    expect(M.parseThread({ v: 1, id: "nothex!" })).toBeNull()
    expect(M.parseThread({ ...sample(), meta: { l: 1, by: "x", value: { name: "a", status: "bogus" } } })).toBeNull()
    expect(M.parseThread(JSON.parse(JSON.stringify(sample())))).not.toBeNull()
  })
})

// --- the git ref ------------------------------------------------------------------------

const git = (cwd: string, ...args: string[]) => {
  const r = spawnSync("git", ["-C", cwd, "-c", "user.email=t@t", "-c", "user.name=t", ...args], { encoding: "utf8" })
  return r.stdout.trim()
}

describe("store", () => {
  const bare = path.join(TMP, "remote.git")
  const a = path.join(TMP, "a")
  const b = path.join(TMP, "b")
  spawnSync("git", ["init", "-q", "--bare", "-b", "main", bare])
  spawnSync("git", ["clone", "-q", bare, a])
  git(a, "commit", "-q", "--allow-empty", "-m", "init")
  git(a, "push", "-q", "origin", "main")
  spawnSync("git", ["clone", "-q", bare, b])

  test("writing the ref leaves the working tree, the index and HEAD alone", () => {
    fs.writeFileSync(path.join(a, "work.txt"), "unstaged\n")
    fs.writeFileSync(path.join(a, "staged.txt"), "staged\n")
    git(a, "add", "staged.txt")
    const before = { status: git(a, "status", "--porcelain"), index: git(a, "ls-files", "-s"), head: git(a, "rev-parse", "HEAD"), branch: git(a, "symbolic-ref", "HEAD") }
    const c = S.writeRef(a, { "x.md": "one\n", "y.md": "two\n" }, "first", { author: "crosstalk (test)" })
    expect(c).toBeTruthy()
    expect(S.readRef(a).files).toEqual({ "x.md": "one\n", "y.md": "two\n" })
    const after = { status: git(a, "status", "--porcelain"), index: git(a, "ls-files", "-s"), head: git(a, "rev-parse", "HEAD"), branch: git(a, "symbolic-ref", "HEAD") }
    expect(after).toEqual(before)
    expect(fs.existsSync(path.join(a, "x.md"))).toBe(false)
    // Nothing changed, no commit.
    expect(S.writeRef(a, { "x.md": "one\n", "y.md": "two\n" }, "again", { author: "t" })).toBeUndefined()
    // A second commit sits on the first.
    const c2 = S.writeRef(a, { "x.md": "one\n" }, "second", { author: "t" })
    expect(git(a, "rev-parse", `${c2}^`)).toBe(c!)
    expect(Object.keys(S.readRef(a).files)).toEqual(["x.md"])
  })

  test("the refspec is added once, and a push and fetch carry the ref", async () => {
    expect(S.ensureRefspec(a)).toBe(true)
    expect(S.ensureRefspec(a)).toBe(false)
    expect(git(a, "config", "--get-all", "remote.origin.fetch").split("\n")).toContain(S.REFSPEC)
    expect((await S.pushRemote(a)).ok).toBe(true)
    expect(git(bare, "rev-parse", S.REF)).toBe(S.refCommit(a)!)
    expect((await S.fetchRemote(b)).ok).toBe(true)
    // crosstalk's own fetch lands beside the ref, never on it.
    expect(S.refCommit(b)).toBeUndefined()
    expect(S.readRef(b, S.SYNC_REF).files).toEqual({ "x.md": "one\n" })
    expect(S.defaultBranch(b)).toBe("main")
  })

  test("a fetch from a remote with no threads yet is not an error", async () => {
    const empty = path.join(TMP, "empty.git")
    spawnSync("git", ["init", "-q", "--bare", empty])
    const c = path.join(TMP, "c")
    spawnSync("git", ["clone", "-q", empty, c])
    expect((await S.fetchRemote(c)).ok).toBe(true)
  })
})

// --- finding sessions ---------------------------------------------------------------

const lite = (o: Partial<I.ThreadLite> & { id: string; name: string }): I.ThreadLite => ({
  repo: "r",
  live: true,
  branches: [],
  files: [],
  createdAt: 0,
  ...o,
})

describe("inference", () => {
  test("names come from the branch, without the boilerplate", () => {
    expect(I.nameFromBranch("feature/auth-tokens")).toBe("auth-tokens")
    expect(I.nameFromBranch("paul/feat-auth")).toBe("auth")
    expect(I.nameFromBranch("token-v2")).toBe("token-v2")
    expect(I.nameFromBranch("claude/laughing-goldberg-dw38w3")).toBe("laughing-goldberg-dw38w3")
  })

  test("same repo and branch: the same thread", () => {
    const p = I.place({ repo: "r", branch: "token-v2", paths: [] }, [lite({ id: "a", name: "token-v2", branches: ["token-v2"] })])
    expect(p).toEqual({ kind: "join", threads: [{ id: "a", why: "same branch token-v2" }] })
  })

  test("a new branch starts a thread named from it", () => {
    const p = I.place({ repo: "r", branch: "feature/billing", paths: [] }, [lite({ id: "a", name: "token-v2", branches: ["token-v2"] })])
    expect(p).toMatchObject({ kind: "create", name: "billing", branch: "feature/billing" })
  })

  test("another repo's thread is never joined", () => {
    const p = I.place({ repo: "other", branch: "token-v2", paths: [] }, [lite({ id: "a", name: "token-v2", branches: ["token-v2"] })])
    expect(p.kind).toBe("create")
  })

  test("on the default branch the files decide", () => {
    const ts = [lite({ id: "a", name: "auth", files: ["src/auth/**"] }), lite({ id: "b", name: "billing", files: ["src/billing/x.ts"] })]
    expect(I.place({ repo: "r", branch: "main", onDefault: true, paths: ["src/auth/token.ts"] }, ts)).toMatchObject({ kind: "join", threads: [{ id: "a" }] })
    expect(I.place({ repo: "r", branch: "main", onDefault: true, paths: [] }, ts).kind).toBe("none")
    expect(I.place({ repo: "r", branch: "main", onDefault: true, paths: ["README.md"] }, ts).kind).toBe("none")
    // Root files and lockfiles say nothing about the work: they never pull a session into a thread.
    expect(I.place({ repo: "r", branch: "main", onDefault: true, paths: ["package.json", "bun.lock"] }, [{ ...ts[0]!, files: ["package.json", "src/auth/**"] }]).kind).toBe("none")
  })

  test("a cluster of new files starts a thread named from its folder", () => {
    const p = I.place({ repo: "r", branch: "main", onDefault: true, paths: ["src/upload/a.ts", "src/upload/b.ts", "src/upload/c.ts"] }, [])
    expect(p).toMatchObject({ kind: "create", name: "upload", files: ["src/upload/**"] })
  })

  test("touching two threads equally is a question, never a guess", () => {
    const ts = [lite({ id: "a", name: "auth", files: ["src/auth/**"] }), lite({ id: "b", name: "billing", files: ["src/billing/**"] })]
    const p = I.place({ repo: "r", branch: "main", onDefault: true, paths: ["src/auth/x.ts", "src/billing/y.ts"] }, ts)
    expect(p).toMatchObject({ kind: "ask", candidates: ["a", "b"] })
  })

  test("two threads converge on a shared branch or on enough shared files", () => {
    expect(I.converge(lite({ id: "a", name: "a", branches: ["x"] }), lite({ id: "b", name: "b", branches: ["x"] }))).toBe("both on branch x")
    expect(I.converge(lite({ id: "a", name: "a", files: ["s/1.ts", "s/2.ts"] }), lite({ id: "b", name: "b", files: ["s/1.ts", "s/2.ts", "s/3.ts"] }))).toContain("both touch")
    // One shared file is a coincidence.
    expect(I.converge(lite({ id: "a", name: "a", files: ["package.json", "a.ts"] }), lite({ id: "b", name: "b", files: ["package.json", "b.ts"] }))).toBeNull()
    expect(I.converge(lite({ id: "a", name: "a", branches: ["x"] }), lite({ id: "b", name: "b", branches: ["x"], repo: "other" }))).toBeNull()
  })

  test("every replica picks the same survivor", () => {
    const a = { id: "b1", createdAt: 5 }
    const b = { id: "a1", createdAt: 5 }
    expect(I.survivor(a, b)[0].id).toBe("a1")
    expect(I.survivor(b, a)[0].id).toBe("a1")
    expect(I.survivor({ id: "z", createdAt: 1 }, b)[0].id).toBe("z")
  })
})

// --- two services wired together -----------------------------------------------------------

type Wire = { svc: ThreadService; id: Identity; sent: { to: string; env: Envelope }[]; clock: { t: number } }

function pair(): [Wire, Wire] {
  const ids = [newIdentity("ana"), newIdentity("ben")]
  const clock = { t: Date.parse("2026-11-01T10:00:00Z") }
  const wires: Wire[] = []
  for (const [i, id] of ids.entries()) {
    const other = ids[1 - i]
    const sent: Wire["sent"] = []
    const svc = new ThreadService({
      identity: id,
      peers: () => ({ [other.label]: asPeer(other) }),
      send: (to, env) => void sent.push({ to, env }),
      log: () => {},
      file: path.join(TMP, `svc-${id.label}-${Math.random()}.json`),
      network: false,
      now: () => clock.t,
    })
    wires.push({ svc, id, sent, clock })
  }
  return wires as [Wire, Wire]
}

/** Deliver everything in flight, both ways, until nothing more is sent. */
function settle(a: Wire, b: Wire) {
  for (let i = 0; i < 20; i++) {
    const out = [...a.sent.splice(0).map((m) => [b, a, m] as const), ...b.sent.splice(0).map((m) => [a, b, m] as const)]
    if (!out.length) return
    for (const [to, from, m] of out) to.svc.accept(from.id.label, m.env)
  }
}

const presence = (w: Wire, s: LocalSession) => ({
  name: s.name,
  cwd: s.cwd,
  status: "idle",
  lastSeen: 0,
  footprint: { repo: s.repo, branch: s.branch, paths: s.paths },
  threads: w.svc.idsFor(s.sessionId),
})

const sess = (sessionId: string, branch: string, paths: string[] = []): LocalSession => ({ sessionId, name: sessionId, cwd: "/x", repo: "github.com/acme/api", branch, paths })

describe("service", () => {
  test("two people's sessions on one branch end up in one thread, and each is told who can read it", () => {
    const [ana, ben] = pair()
    const sa = sess("a-feat", "token-v2", ["src/auth/token.ts"])
    const sb = sess("b-feat", "token-v2", ["src/auth/parse.ts"])
    ana.svc.observe(sa)
    ana.clock.t += 1000
    ben.svc.observe(sb)
    expect(ana.svc.idsFor("a-feat")).toHaveLength(1)
    expect(ana.svc.idsFor("a-feat")[0]).not.toBe(ben.svc.idsFor("b-feat")[0])
    // Each sees the other's session in presence.
    ana.svc.peerPresence("ben", [presence(ben, sb)])
    ben.svc.peerPresence("ana", [presence(ana, sa)])
    settle(ana, ben)
    const [ta] = ana.svc.idsFor("a-feat")
    expect(ben.svc.idsFor("b-feat")).toEqual([ta])
    const t = ana.svc.thread(ta)!
    expect(M.view(t).people.sort()).toEqual(["ana", "ben"])
    expect(M.view(t).sessions.sort()).toEqual(["ana/a-feat @ token-v2", "ben/b-feat @ token-v2"])
    // The thread ana started first survives.
    expect(t.meta.value.createdBy).toBe(fingerprint(ana.id.ed.pub))
    expect(ana.svc.forSession("a-feat", "a-feat", true).notes.join("\n")).toContain("ben joined token-v2 (same branch token-v2) and can now read it")
    expect(ben.svc.forSession("b-feat", "b-feat", true).notes.join("\n")).toContain("combined into token-v2")
    expect(ana.svc.title("a-feat", "api")).toBe("token-v2 · api")
    // Talking is per thread.
    expect(ana.svc.recipients("a-feat")).toEqual({ threads: [ta], labels: ["ben"] })
    expect(ana.svc.sessionsIn([ta])).toEqual(["a-feat"])
    // A thread's teammates (who hears its PR merge or fail): ben here; nobody in a thread only ana has.
    expect(ana.svc.teammates([ta])).toEqual(["ben"])
    ana.svc.observe(sess("a-solo", "billing-retry", ["src/billing/retry.ts"]))
    expect(ana.svc.idsFor("a-solo")).toHaveLength(1)
    expect(ana.svc.idsFor("a-solo")[0]).not.toBe(ta)
    expect(ana.svc.teammates(ana.svc.idsFor("a-solo"))).toEqual([])
    expect(ana.svc.teammates(["no-such-thread"])).toEqual([])
  })

  test("a decision made on one side is there on the other at once", () => {
    const [ana, ben] = pair()
    const sa = sess("a", "token-v2")
    const sb = sess("b", "token-v2")
    ana.svc.observe(sa)
    ben.svc.observe(sb)
    ana.svc.peerPresence("ben", [presence(ben, sb)])
    ben.svc.peerPresence("ana", [presence(ana, sa)])
    settle(ana, ben)
    expect(ana.svc.decide("a", { text: "v1 accepted until 0.2" }).ok).toBe(true)
    settle(ana, ben)
    const t = ben.svc.thread(ben.svc.idsFor("b")[0])!
    expect(M.view(t).notes.filter((n) => n.kind === "decision").map((d) => d.text)).toEqual(["v1 accepted until 0.2"])
  })

  test("a different branch is a second thread, and converging files combine them", () => {
    const [ana, ben] = pair()
    const sa = sess("a", "billing", ["src/billing/a.ts", "src/billing/b.ts"])
    ana.svc.observe(sa)
    ana.clock.t += 1000
    const sb = sess("b", "billing-v2", ["src/other.ts"])
    ben.svc.observe(sb)
    ana.svc.peerPresence("ben", [presence(ben, sb)])
    ben.svc.peerPresence("ana", [presence(ana, sa)])
    settle(ana, ben)
    expect(ana.svc.idsFor("a")[0]).not.toBe(ben.svc.idsFor("b")[0])
    expect(ben.svc.list().map((t) => t.name)).toEqual(["billing-v2"])
    // ben's session starts on the same files.
    const sb2 = { ...sb, paths: ["src/billing/a.ts", "src/billing/b.ts"] }
    ben.svc.observe(sb2)
    ana.svc.peerPresence("ben", [presence(ben, sb2)])
    ben.svc.peerPresence("ana", [presence(ana, sa)])
    settle(ana, ben)
    expect(ben.svc.idsFor("b")).toEqual(ana.svc.idsFor("a"))
    const note = ben.svc.forSession("b", "b", true).notes.join("\n")
    expect(note).toContain("billing-v2 and billing combined into billing")
    expect(ana.svc.forSession("a", "a", true).notes.join("\n")).toContain("ben joined billing (same files")
  })

  test("a thread frame from someone not in it, or that does not name us, is ignored", () => {
    const [ana, ben] = pair()
    const t = M.create({ name: "x", repo: "r", by: "ffff", label: "eve" })
    ana.svc.accept("ben", { v: 1, id: "1", ts: 0, from: "ben", fromSession: "-", to: "ana", kind: "thread", intent: "fyi", text: "", threadSync: { thread: t } })
    expect(ana.svc.list()).toEqual([])
    M.put(t, "people", fingerprint(ben.id.ed.pub), { label: "ben" }, "ffff")
    ana.svc.accept("ben", { v: 1, id: "2", ts: 0, from: "ben", fromSession: "-", to: "ana", kind: "thread", intent: "fyi", text: "", threadSync: { thread: t } })
    expect(ana.svc.list()).toEqual([])
    ana.svc.accept("stranger", { v: 1, id: "3", ts: 0, from: "x", fromSession: "-", to: "ana", kind: "thread", intent: "fyi", text: "", threadSync: { thread: t } })
    expect(ana.svc.list()).toEqual([])
  })

  test("on main, a session's thread follows its latest work: one at a time, never all it ever touched", () => {
    const [ana] = pair()
    ana.svc.observe(sess("m", "main", ["src/auth/a.ts", "src/auth/b.ts", "src/auth/c.ts"]))
    expect(ana.svc.namesFor("m")).toEqual(["auth"])
    // It moves on to billing: billing, and auth no longer.
    const later = ["src/billing/a.ts", "src/billing/b.ts", "src/billing/c.ts", "src/billing/d.ts", "src/billing/e.ts", "src/billing/f.ts", "src/billing/g.ts", "src/billing/h.ts", "src/billing/i.ts", "src/billing/j.ts"]
    ana.svc.observe(sess("m", "main", [...later, "src/auth/a.ts", "src/auth/b.ts", "src/auth/c.ts"]))
    expect(ana.svc.namesFor("m")).toEqual(["billing"])
    // auth never took billing's files on the way, so a session working on billing is not pulled into auth.
    ana.svc.observe(sess("n", "main", ["src/billing/x.ts"]))
    expect(ana.svc.namesFor("n")).toEqual(["billing"])
  })

  test("a session in another project, or in no repository, is in none of this repository's threads", () => {
    const [ana] = pair()
    ana.svc.observe(sess("p", "main", ["src/auth/a.ts", "src/auth/b.ts", "src/auth/c.ts"]))
    expect(ana.svc.namesFor("p")).toEqual(["auth"])
    ana.svc.observe({ ...sess("p", "main", ["eval/run.py"]), repo: "github.com/other/evals" })
    expect(ana.svc.namesFor("p")).toEqual([])
    ana.svc.observe(sess("q", "main", ["src/auth/a.ts", "src/auth/b.ts", "src/auth/c.ts"]))
    ana.svc.observe({ ...sess("q", "main", []), repo: undefined })
    expect(ana.svc.namesFor("q")).toEqual([])
    expect(ana.svc.repoOfSession("p")).toBe("github.com/other/evals")
  })

  test("the title is one thread and the session's own name, never built on the last title", () => {
    const [ana] = pair()
    ana.svc.observe(sess("t", "main", ["src/auth/a.ts", "src/auth/b.ts", "src/auth/c.ts"]))
    expect(ana.svc.title("t", "api-2")).toBe("auth · api-2")
    expect(ana.svc.title("t", "🟣 auth · 🟣 auth · ⏳ api-2")).toBe("auth · api-2")
  })

  test("ambiguity is one question, and the answer sticks", () => {
    const [ana] = pair()
    ana.svc.observe({ ...sess("s1", "main", ["src/auth/a.ts", "src/auth/b.ts", "src/auth/c.ts"]) })
    ana.svc.observe({ ...sess("s2", "main", ["src/billing/a.ts", "src/billing/b.ts", "src/billing/c.ts"]) })
    expect(ana.svc.list().map((t) => t.name).sort()).toEqual(["auth", "billing"])
    ana.svc.observe(sess("s3", "main", ["src/auth/x.ts", "src/billing/y.ts"]))
    const q = ana.svc.question("s3")
    expect(q?.options).toEqual(["auth", "billing", NEW_THREAD, "No thread"])
    expect(ana.svc.idsFor("s3")).toEqual([])
    expect(ana.svc.answer("s3", "billing")).toMatchObject({ ok: true, threads: ["billing"] })
    expect(ana.svc.question("s3")).toBeUndefined()
    ana.svc.observe(sess("s3", "main", ["src/auth/x.ts", "src/billing/y.ts", "src/auth/z.ts"]))
    expect(ana.svc.namesFor("s3")).toEqual(["billing"])
  })

  test("a placement said in advance (a new agent's worktree) survives footprint inference", () => {
    const [ana] = pair()
    ana.svc.observe(sess("asker", "token-v2", ["src/auth/token.ts"]))
    ana.svc.observe(sess("bill", "billing", ["src/billing/a.ts", "src/billing/b.ts", "src/billing/c.ts"]))
    const [auth] = ana.svc.idsFor("asker")
    const name = ana.svc.thread(auth)!.meta.value.name
    expect(ana.svc.expect({ cwd: "/wt/auth-1", thread: name, why: "started from asker" })).toEqual({ ok: true, thread: name })
    // Saying it again changes nothing.
    expect(ana.svc.expect({ cwd: "/wt/auth-1", thread: auth })).toEqual({ ok: true, thread: name })
    // Its own branch and files would put it elsewhere: billing's files, a branch no thread has.
    const agent: LocalSession = { sessionId: "agent", name: "auth-1", cwd: "/wt/auth-1/src", repo: "github.com/acme/api", branch: "crosstalk/auth-1", paths: ["src/billing/a.ts", "src/billing/b.ts"] }
    ana.svc.observe(agent)
    expect(ana.svc.idsFor("agent")).toEqual([auth])
    expect(ana.svc.question("agent")).toBeUndefined()
    expect(ana.svc.forSession("agent", "auth-1", false).threads[0]).toMatchObject({ name, why: "started from asker" })
    // Its branch joined the thread, so the pin holds every time it is placed again.
    expect(M.ids(ana.svc.thread(auth)!, "branches")).toContain("crosstalk/auth-1")
    for (let i = 0; i < 3; i++) {
      ana.clock.t += 60_000
      ana.svc.observe({ ...agent, paths: [...agent.paths, `src/billing/n${i}.ts`] })
    }
    expect(ana.svc.idsFor("agent")).toEqual([auth])
    // Messages for the thread reach it, and the title shows the thread.
    expect(ana.svc.sessionsIn([auth]).sort()).toEqual(["agent", "asker"])
    expect(ana.svc.title("agent", "auth-1")).toBe(`${name} · auth-1`)
    // A fresh session in the same worktree (a disposed one's successor) starts there too.
    ana.svc.observe({ ...agent, sessionId: "agent-2" })
    expect(ana.svc.idsFor("agent-2")).toEqual([auth])
    // By session id, too; and an unknown thread is refused.
    ana.svc.expect({ sessionId: "other", thread: name })
    ana.svc.observe({ ...agent, sessionId: "other", cwd: "/elsewhere" })
    expect(ana.svc.idsFor("other")).toEqual([auth])
    expect(ana.svc.expect({ cwd: "/x", thread: "nope" }).ok).toBe(false)
  })

  test("leaving a thread sticks: matching never puts the session back, choosing it does", () => {
    const [ana] = pair()
    ana.svc.observe(sess("asker", "token-v2", ["src/auth/token.ts"]))
    const [auth] = ana.svc.idsFor("asker")
    const name = ana.svc.thread(auth)!.meta.value.name
    ana.svc.expect({ cwd: "/wt/auth-1", thread: name })
    const agent: LocalSession = { sessionId: "agent", name: "auth-1", cwd: "/wt/auth-1", repo: "github.com/acme/api", branch: "crosstalk/auth-1", paths: ["src/auth/token.ts"] }
    ana.svc.observe(agent)
    expect(ana.svc.idsFor("agent")).toEqual([auth])
    expect(ana.svc.leave("agent", name)).toMatchObject({ ok: true })
    expect(ana.svc.idsFor("agent")).not.toContain(auth)
    // Its branch belongs to the thread and its files match it, and it still stays out.
    for (let i = 0; i < 3; i++) {
      ana.clock.t += 60_000
      ana.svc.observe({ ...agent, paths: [...agent.paths, `src/auth/n${i}.ts`] })
    }
    expect(ana.svc.idsFor("agent")).not.toContain(auth)
    // Choosing it by hand brings it back.
    expect(ana.svc.answer("agent", name)).toMatchObject({ ok: true })
    expect(ana.svc.idsFor("agent")).toContain(auth)
  })

  test("a session already registered when its placement is said is placed at once", () => {
    const [ana] = pair()
    ana.svc.observe(sess("asker", "token-v2", ["src/auth/token.ts"]))
    const [auth] = ana.svc.idsFor("asker")
    ana.svc.observe({ sessionId: "early", name: "auth-2", cwd: "/wt/auth-2", repo: "github.com/acme/api", branch: "crosstalk/auth-2", paths: [] })
    expect(ana.svc.idsFor("early")).not.toContain(auth)
    ana.svc.expect({ cwd: "/wt/auth-2", thread: auth })
    expect(ana.svc.idsFor("early")).toEqual([auth])
  })

  test("a quiet thread nobody is in fades to its decisions, and comes back with new activity", () => {
    const [ana] = pair()
    ana.svc.observe(sess("s", "old-work"))
    const [id] = ana.svc.idsFor("s")
    ana.svc.decide("s", { text: "keep it simple" })
    ana.svc.fact("s", { text: "a passing fact" })
    ana.svc.forget("s")
    ana.clock.t += 13 * 86_400_000
    ana.svc.fade()
    expect(ana.svc.thread(id)!.meta.value.status).toBe("active")
    ana.clock.t += 2 * 86_400_000
    ana.svc.fade()
    const t = ana.svc.thread(id)!
    expect(t.meta.value.status).toBe("archived")
    expect(M.view(t).notes.filter((n) => n.kind === "decision").map((d) => d.text)).toEqual(["keep it simple"])
    expect(M.view(t).notes.filter((n) => n.kind === "fact")).toEqual([])
    ana.svc.observe(sess("s2", "old-work"))
    expect(ana.svc.idsFor("s2")).toEqual([id])
    expect(ana.svc.thread(id)!.meta.value.status).toBe("active")
  })
})

describe("service and the ref", () => {
  test("mail: a message for someone off the relay goes through a thread both are in, and is delivered once on their sync", async () => {
    const bare = path.join(TMP, "mail-remote.git")
    const ra = path.join(TMP, "mail-a")
    const rb = path.join(TMP, "mail-b")
    spawnSync("git", ["init", "-q", "--bare", "-b", "main", bare])
    spawnSync("git", ["clone", "-q", bare, ra])
    git(ra, "commit", "-q", "--allow-empty", "-m", "init")
    git(ra, "push", "-q", "origin", "main")
    spawnSync("git", ["clone", "-q", bare, rb])
    const repo = bare.toLowerCase().replace(/\.git$/, "")
    const [ana, ben] = pair()
    for (const w of [ana, ben]) (w.svc as any).d.network = true
    const got: [string, any][] = []
    ;(ben.svc as any).d.onMail = (from: string, env: any) => got.push([from, env])
    const sa: LocalSession = { sessionId: "a", name: "a", cwd: ra, root: ra, repo, branch: "token-v2", paths: ["src/t.ts"] }
    const sb: LocalSession = { sessionId: "b", name: "b", cwd: rb, root: rb, repo, branch: "token-v2", paths: [] }
    ana.svc.observe(sa)
    ben.svc.observe(sb)
    ana.svc.peerPresence("ben", [presence(ben, sb)])
    ben.svc.peerPresence("ana", [presence(ana, sa)])
    settle(ana, ben)
    const via = ana.svc.mail({ label: "ben", fingerprint: ben.svc.me }, { id: "env-1", kind: "message", text: "the briefing" } as any)
    expect(via).toBe("token-v2")
    expect(ana.svc.mail({ label: "jo", fingerprint: "nobody" }, { id: "x" } as any)).toBe(null) // no shared thread
    await ana.svc.sync(repo, true)
    await ben.svc.sync(repo, false)
    expect(got).toEqual([[ana.svc.label, { id: "env-1", kind: "message", text: "the briefing" }]])
    await ben.svc.sync(repo, false)
    expect(got).toHaveLength(1) // once
    // Not a question anyone is asked.
    const t = ben.svc.find(undefined, "token-v2")!
    expect(M.live(t, "questions").filter((q) => !q.answer)).toEqual([])
  })

  test("a sealed thread is committed, pushed, and read back from a fetch by a fresh replica", async () => {
    const bare = path.join(TMP, "svc-remote.git")
    const ra = path.join(TMP, "svc-a")
    const rb = path.join(TMP, "svc-b")
    spawnSync("git", ["init", "-q", "--bare", "-b", "main", bare])
    spawnSync("git", ["clone", "-q", bare, ra])
    git(ra, "commit", "-q", "--allow-empty", "-m", "init")
    git(ra, "push", "-q", "origin", "main")
    spawnSync("git", ["clone", "-q", bare, rb])
    const repo = bare.toLowerCase().replace(/\.git$/, "")

    const [ana, ben] = pair()
    for (const w of [ana, ben]) (w.svc as any).d.network = true
    const sa: LocalSession = { sessionId: "a", name: "a", cwd: ra, root: ra, repo, branch: "token-v2", paths: ["src/t.ts"] }
    const sb: LocalSession = { sessionId: "b", name: "b", cwd: rb, root: rb, repo, branch: "token-v2", paths: [] }
    ana.svc.observe(sa)
    ben.svc.observe(sb)
    ana.svc.peerPresence("ben", [presence(ben, sb)])
    ben.svc.peerPresence("ana", [presence(ana, sa)])
    settle(ana, ben)
    ana.svc.decide("a", { text: "sealed decision text" })
    settle(ana, ben)
    const before = git(ra, "status", "--porcelain")
    await ana.svc.sync(repo, true)
    expect(git(ra, "status", "--porcelain")).toBe(before)
    expect(git(ra, "config", "--get-all", "remote.origin.fetch")).toContain(S.REFSPEC)
    const files = Object.values(S.readRef(bare).files)
    // The survivor and the one combined into it, both sealed.
    expect(files.length).toBe(2)
    for (const f of files) {
      expect(f).toContain("sealed: true")
      expect(f).not.toContain("sealed decision text")
    }

    // A replica that knows nothing yet: ben on a new machine, same identity.
    const fresh = new ThreadService({
      identity: ben.id,
      peers: () => ({ ana: asPeer(ana.id) }),
      send: () => {},
      log: () => {},
      file: path.join(TMP, "svc-fresh.json"),
      network: true,
    })
    fresh.observe({ ...sb, sessionId: "b2", branch: "elsewhere" })
    await fresh.syncAll()
    const t = fresh.find(undefined, "token-v2")!
    expect(M.view(t).notes.filter((n) => n.kind === "decision").map((d) => d.text)).toEqual(["sealed decision text"])
  })

  test("a public thread is plain on the ref and summarised in THREADS.md, left unstaged", async () => {
    const bare = path.join(TMP, "pub-remote.git")
    const ra = path.join(TMP, "pub-a")
    spawnSync("git", ["init", "-q", "--bare", "-b", "main", bare])
    spawnSync("git", ["clone", "-q", bare, ra])
    git(ra, "commit", "-q", "--allow-empty", "-m", "init")
    git(ra, "push", "-q", "origin", "main")
    const repo = bare.toLowerCase().replace(/\.git$/, "")
    const [ana] = pair()
    ana.svc.observe({ sessionId: "a", name: "a", cwd: ra, root: ra, repo, branch: "docs-site", paths: [] })
    await ana.svc.sync(repo, true)
    expect(fs.existsSync(path.join(ra, "THREADS.md"))).toBe(false)
    ana.svc.edit("a", { public: true })
    ana.svc.edit("a", { status: "waiting" })
    await ana.svc.sync(repo, true)
    expect(S.readRef(ra).files["docs-site.md"]).toContain("status: waiting")
    expect(fs.readFileSync(path.join(ra, "THREADS.md"), "utf8")).toContain("**docs-site** · waiting · ana")
    expect(git(ra, "status", "--porcelain")).toBe("?? THREADS.md")
    expect(ana.svc.forSession("a", "a", true).notes.join("\n")).toContain("left unstaged")
  })
})

// --- notes: version 1's separate sections, migrated on read -----------------------

/** A thread as version 1 kept it: recap a value of its own, decisions, facts, tasks and rules four lists, no notes. */
function toV1(t: M.Thread): any {
  const o: any = JSON.parse(JSON.stringify(t))
  o.v = 1
  const r = o.notes[M.RECAP_ID]
  o.recap = r ? { l: r.l, by: r.by, value: r.text } : { l: 1, by: t.meta.by, value: "" }
  for (const [list, kind] of Object.entries(M.LEGACY_LISTS)) {
    o[list] = {}
    for (const [id, n] of Object.entries(o.notes as Record<string, any>))
      if (n.kind === kind) {
        const { kind: _k, ...rest } = n
        o[list][id] = rest
      }
  }
  delete o.notes
  return o
}

/** renderSealed as version 1 wrote it: a line for the recap and for each of the four lists. */
function sealedV1(t: M.Thread, key: Buffer, wraps: ReturnType<typeof wrapKey>): string {
  const o = toV1(t)
  const lines = ["---", F.HEADER, `id: ${t.id}`, "sealed: true", "keys:", ...wraps.map((w) => `  - ${w.to} ${w.from} ${w.k}`), "---"]
  for (const s of ["meta", "recap", "people", "sessions", "files", "branches", "features", "questions", "decisions", "facts", "tasks", "rules", "links"])
    lines.push(`${s}: ${sealSection(key, t.id, s, o[s] ?? {})}`)
  lines.push(`clock: ${sealSection(key, t.id, "clock", { lamport: t.lamport, touchedAt: t.touchedAt })}`)
  return lines.join("\n") + "\n"
}

/** A recap from version 1 carries no time: compare notes by kind and text. */
const kinds = (t: M.Thread) => M.notes(t).map((n) => `${n.kind}:${n.text}`).sort()

describe("notes migration", () => {
  test("a version 1 thread from a peer or the state file opens as notes, ids and stamps kept", () => {
    const t = sample()
    const old = toV1(t)
    expect(old.notes).toBeUndefined()
    expect(old.decisions.d_1.text).toBe("v1 tokens accepted until 0.2")
    expect(M.isLegacy(old)).toBe(true)
    const back = M.parseThread(old)!
    expect(back.v).toBe(2)
    expect(M.isLegacy(back)).toBe(false)
    expect(kinds(back)).toEqual(kinds(t))
    expect(M.recap(back)).toBe("Moving tokens to v2 format; v1 kept for one release.")
    expect(M.noteOf(back, "t_1", "task")).toMatchObject({ state: "open", l: t.notes.t_1!.l })
    expect(M.noteOf(back, "d_1", "decision")).toEqual(t.notes.d_1 as any)
    expect((back as any).decisions).toBeUndefined()
  })

  test("an old public file, with ## Decisions, ## Facts, ## Tasks and ## Rules and no state, opens and is written back as ## Notes", () => {
    const text = `---
crosstalk: thread/v1
id: 0123456789abcdee
name: auth
status: active
people: [paul]
---

## Recap
Moving tokens to v2.

## Decisions
- 2026-11-01 · paul · v1 tokens accepted until 0.2

## Facts
- staging DB is shared

## Tasks
- [x] write the note
- [ ] remove v1 parser

## Rules
- always keep one release of overlap
`
    const p = F.parse(text)
    expect(p.kind).toBe("public")
    if (p.kind !== "public") return
    expect(M.recap(p.thread)).toBe("Moving tokens to v2.")
    expect(kinds(p.thread)).toEqual([
      "decision:v1 tokens accepted until 0.2",
      "fact:staging DB is shared",
      "recap:Moving tokens to v2.",
      "rule:always keep one release of overlap",
      "task:remove v1 parser",
      "task:write the note",
    ])
    const out = F.renderPublic(p.thread)
    expect(out).not.toMatch(/^## (Decisions|Facts|Tasks|Rules)$/m)
    expect(out).toContain("## Notes\n")
    expect(out).toContain("- decision · 2026-11-01 · paul · v1 tokens accepted until 0.2")
    expect(out).toContain("- [x] write the note")
    // And the new file reads back the same.
    const again = F.parse(out)
    expect(again.kind === "public" && M.same(again.thread, p.thread)).toBe(true)
  })

  test("an old public file with its exact state in version 1's shape opens as notes", () => {
    const t = sample()
    M.setMeta(t, "aaaa", { public: true })
    const text = F.renderPublic(t).replace(/<!-- crosstalk:state\n[\s\S]*?\n-->/, () => `<!-- crosstalk:state\n${M.canonical(toV1(t)).replace(/-->/g, "--\\u003e")}\n-->`)
    expect(text).toContain('"decisions":{')
    const p = F.parse(text)
    expect(p.kind).toBe("public")
    if (p.kind === "public") {
      expect(kinds(p.thread)).toEqual(kinds(t))
      expect(Object.keys(p.thread.notes).sort()).toEqual(Object.keys(t.notes).sort())
    }
  })

  test("a hand-written ## Notes section reads each line's kind", () => {
    const p = F.parse(`---\ncrosstalk: thread/v1\nid: 0123456789abcded\nname: x\nstatus: active\n---\n\n## Notes\n- decision · 2026-11-02 · ana · ship it\n- fact · the DB is shared\n- [ ] tidy up\n- rule · no Friday deploys\n- something said plainly\n`)
    expect(p.kind).toBe("public")
    if (p.kind === "public")
      expect(kinds(p.thread)).toEqual(["decision:ship it", "fact:something said plainly", "fact:the DB is shared", "rule:no Friday deploys", "task:tidy up"])
  })

  test("an old sealed file opens with the same key, and is sealed back with one notes line", () => {
    const paul = newIdentity("paul")
    const marie = newIdentity("marie")
    const t = sample(fingerprint(paul.ed.pub))
    const key = newKey()
    const wraps = wrapKey(paul, key, [asPeer(marie)])
    const text = sealedV1(t, key, wraps)
    expect(text).toMatch(/^decisions: \S+$/m)
    expect(text).not.toMatch(/^notes: /m)
    const p = F.parse(text)
    expect(p.kind).toBe("sealed")
    if (p.kind !== "sealed") return
    const opened = p.open(unwrapKey(marie, p.wraps, [asPeer(paul)])!)!
    expect(opened).not.toBeNull()
    expect(kinds(opened)).toEqual(kinds(t))
    expect(Object.keys(opened.notes).sort()).toEqual(Object.keys(t.notes).sort())
    const out = F.renderSealed(opened, key, wraps)
    expect(out).toMatch(/^notes: \S+$/m)
    for (const s of M.LEGACY_SECTIONS) expect(out).not.toMatch(new RegExp(`^${s}: `, "m"))
    const p2 = F.parse(out)
    expect(p2.kind === "sealed" && M.same(p2.open(key)!, opened)).toBe(true)
  })

  test("mixed versions merge item by item: whichever replica edited a note last wins, both sides' notes survive", () => {
    const base = sample("aaaa")
    // A replica that has updated: a new decision, and the task claimed.
    const fresh = structuredClone(base)
    M.note(fresh, { kind: "decision", text: "from the new replica", who: "paul", at: 20 }, "aaaa", 20, "d_new")
    const task = M.noteOf(fresh, "t_1", "task")!
    const { l: _l, by: _b, id: _i, gone: _g, ...data } = task
    M.put(fresh, "notes", "t_1", { ...data, state: "claimed", claimedBy: "paul" }, "aaaa")
    // One that has not: it adds a fact and rewrites the recap, in version 1's shape.
    const stale = toV1(base)
    stale.lamport += 10
    stale.facts.f_old = { text: "from the old replica", who: "marie", at: 21, l: stale.lamport, by: "bbbb", id: "f_old" }
    stale.recap = { l: stale.lamport + 1, by: "bbbb", value: "recap from the old replica" }
    stale.lamport += 1
    const old = M.parseThread(stale)!
    const ab = M.merge(fresh, old)
    expect(M.same(ab, M.merge(old, fresh))).toBe(true)
    expect(kinds(ab)).toEqual(expect.arrayContaining(["decision:from the new replica", "fact:from the old replica", "recap:recap from the old replica"]))
    expect(M.noteOf(ab, "t_1", "task")?.state).toBe("claimed")
    // The merged thread is in the new shape.
    expect(Object.keys(M.parseThread(JSON.parse(JSON.stringify(ab)))!)).not.toContain("decisions")
  })

  test("a service reading an old sealed thread off the ref writes it back as notes on its next commit", async () => {
    const bare = path.join(TMP, "mig-remote.git")
    const ra = path.join(TMP, "mig-a")
    spawnSync("git", ["init", "-q", "--bare", "-b", "main", bare])
    spawnSync("git", ["clone", "-q", bare, ra])
    git(ra, "commit", "-q", "--allow-empty", "-m", "init")
    git(ra, "push", "-q", "origin", "main")
    const repo = bare.toLowerCase().replace(/\.git$/, "")
    const [ana] = pair()
    ;(ana.svc as any).d.network = true
    const sa: LocalSession = { sessionId: "a", name: "a", cwd: ra, root: ra, repo, branch: "token-v2", paths: ["src/t.ts"] }
    ana.svc.observe(sa)
    ana.svc.decide("a", { text: "decided before the update" })
    ana.svc.task("a", { op: "add", text: "a task from before" })
    await ana.svc.sync(repo, true)
    // Put the ref back to how version 1 wrote that thread.
    const [name, file] = Object.entries(S.readRef(ra).files)[0]!
    const p = F.parse(file)
    if (p.kind !== "sealed") throw new Error("not sealed")
    const key = unwrapKey(ana.id, p.wraps, [])!
    const t = p.open(key)!
    S.writeRef(ra, { [name]: sealedV1(t, key, p.wraps) }, "an old crosstalk")
    expect(S.readRef(ra).files[name]).toMatch(/^decisions: /m)
    // A fresh replica of ana (new state file) reads it, and the next commit writes notes.
    const again = new ThreadService({ identity: ana.id, peers: () => ({}), send: () => {}, log: () => {}, file: path.join(TMP, "mig-fresh.json"), network: true })
    again.observe(sa)
    await again.syncAll()
    const read = again.find(undefined, "token-v2")!
    expect(kinds(read)).toEqual(["decision:decided before the update", "task:a task from before"])
    await again.sync(repo, true)
    const now = S.readRef(ra).files[name]!
    expect(now).toMatch(/^notes: \S+$/m)
    for (const s of M.LEGACY_SECTIONS) expect(now).not.toMatch(new RegExp(`^${s}: `, "m"))
  })
})

// --- History: links and ended notes, one search ------------------------------------

describe("history", () => {
  test("links the thread had and notes that ended are searched together, newest first", async () => {
    const TH = await import("../src/threads/history.ts")
    const L = await import("../src/urls/history/links.ts")
    const t = sample("aaaa")
    L.record(t, "aaaa", { url: "https://github.com/acme/api/pull/9", kind: "pr", label: "auth · PR #9", seen: 1_000, first: 1_000 }, 1_000)
    // A task done and a fact corrected: both end, and both are kept.
    const k = M.noteOf(t, "t_1", "task")!
    const { l: _l, by: _b, id: _i, gone: _g, ...data } = k
    M.put(t, "notes", "t_1", { ...data, state: "done", doneBy: "paul", at: 2_000 }, "aaaa")
    M.put(t, "notes", "f_1", { ...M.noteOf(t, "f_1", "fact")!, supersededBy: "f_2", at: 3_000 } as any, "aaaa")
    M.remove(t, "notes", "f_1", "aaaa")
    const all = TH.history(t)
    expect(all.map((e) => `${e.from}:${e.kind}:${e.why ?? ""}`)).toEqual(["note:fact:corrected", "note:task:done", "link:pr:"])
    expect(TH.searchHistory(t, { query: "staging" }).map((e) => e.label)).toEqual(["staging DB is shared with the demo env --> careful"])
    expect(TH.searchHistory(t, { query: "pull request" }).map((e) => e.label)).toEqual(["auth · PR #9"])
    expect(TH.searchHistory(t, { kind: "note" }).length).toBe(2)
    expect(TH.searchHistory(t, { after: 2_500 }).map((e) => e.kind)).toEqual(["fact"])
    // Live notes are not history: they are Notes.
    expect(TH.history(t).some((e) => e.label === "v1 tokens accepted until 0.2")).toBe(false)
  })
})

// --- Notes: one API for a thread's and for those kept with people joined with words ----

describe("notes", () => {
  test("facts and open tasks kept outside threads list as notes, marked with whom they are kept", async () => {
    const N = await import("../src/notes.ts")
    const facts = { beta: [{ id: "f_1", text: "uploads chunk at 4KB", by: "jo", at: 5, tags: [], confirmed: [{ by: "ana", at: 6 }] }, { id: "f_0", text: "old", by: "jo", at: 1, tags: [], confirmed: [], supersededBy: "f_1" }] }
    const tasks = { beta: [{ id: "t_1", text: "wire the retry", by: "jo", at: 7, state: "claimed" as const, claimedBy: "ana", tags: [] }, { id: "t_2", text: "done one", by: "jo", at: 2, state: "done" as const, tags: [] }] }
    expect(N.groupNotes(["beta"], { facts, tasks })).toEqual([
      { id: "f_1", kind: "fact", text: "uploads chunk at 4KB", who: "jo", at: 5, confirmed: ["ana"], with: "beta" },
      { id: "t_1", kind: "task", text: "wire the retry", who: "jo", at: 7, state: "claimed", claimedBy: "ana", with: "beta" },
    ])
    expect(N.groupNotes(["beta"], { facts, tasks, kinds: ["task"] }).map((n) => n.id)).toEqual(["t_1"])
    expect(N.threadNotes(sample()).map((n) => `${n.thread}:${n.kind}`)).toEqual(["auth:fact", "auth:task", "auth:rule", "auth:decision"])
  })

  test("a thread's fact is confirmed and corrected in the thread; the corrected one ends in History", async () => {
    const TH = await import("../src/threads/history.ts")
    const [ana] = pair()
    ana.svc.observe(sess("a", "notes-branch"))
    const f = ana.svc.fact("a", { text: "staging is shared" })
    if (!f.ok) throw new Error(f.error)
    expect(ana.svc.confirmFact("a", { id: f.id }).ok).toBe(true)
    const t = ana.svc.find("a")!
    expect(M.noteOf(t, f.id, "fact")?.confirmed?.map((c) => c.by)).toEqual(["ana"])
    const c = ana.svc.correctFact("a", { id: f.id, text: "staging has its own DB now", reason: "moved" })
    if (!c.ok) throw new Error(c.error)
    expect(M.notes(t, "fact").map((n) => n.text)).toEqual(["staging has its own DB now"])
    expect(TH.history(t).find((e) => e.label === "staging is shared")).toMatchObject({ kind: "fact", why: "corrected" })
    expect(ana.svc.confirmFact("a", { id: "f_nope" }).ok).toBe(false)
  })
})
