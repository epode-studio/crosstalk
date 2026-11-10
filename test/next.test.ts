// The main session, answers becoming rules, agents warning each other, and
// first use per repo.
//
//   bun test test/next.test.ts
//
// Two daemons over a real relay, with real repos, is test/next.sh. Here every
// module is driven directly, with fake clocks and stub thread services.

import { afterAll, beforeEach, describe, expect, test } from "bun:test"
import { spawnSync } from "node:child_process"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), "ct-next-"))
process.env.CROSSTALK_HOME = path.join(TMP, "home")
process.env.CROSSTALK_REPOTRUST_ANY_REMOTE = "1"
delete process.env.CROSSTALK_REPOTRUST_AUTO
delete process.env.CROSSTALK_NO_REPOTRUST
afterAll(() => fs.rmSync(TMP, { recursive: true, force: true }))

const K = await import("../src/rules/key.ts")
const H = await import("../src/rules/history.ts")
const D = await import("../src/rules/doc.ts")
const Main = await import("../src/main.ts")
const O = await import("../src/warn/outline.ts")
const G = await import("../src/warn/gate.ts")
const C = await import("../src/warn/conflict.ts")
const W = await import("../src/warn/service.ts")
const E = await import("../src/warn/edit.ts")
const FU = await import("../src/repotrust/firstuse.ts")
const { fingerprint, newIdentity } = await import("../src/crypto.ts")
const M = await import("../src/threads/model.ts")
import type { Peer, Identity } from "../src/config.ts"
import type { UiItem } from "../src/uistate.ts"
import type { Envelope } from "../src/protocol.ts"

const asPeer = (id: Identity): Peer => ({ label: id.label, edPub: id.ed.pub, xPub: id.x.pub, fingerprint: fingerprint(id.ed.pub), joinedAt: 0 })
const g = (cwd: string, ...args: string[]) => spawnSync("git", ["-C", cwd, "-c", "user.email=t@t", "-c", "user.name=t", ...args], { encoding: "utf8" })

// --- rule keys ---------------------------------------------------------------------

describe("rule keys", () => {
  test("a key is the kind and topic, never the thread or session", () => {
    expect(K.ruleKey({ kind: "route", sender: "Marie", repo: "github.com/acme/x" })).toBe("route sender=marie repo=github.com/acme/x")
    const a = K.ruleKey({ kind: "question", text: "Use the v2 token format for new endpoints?" })
    const b = K.ruleKey({ kind: "question", text: "use the V3 token format, for new endpoints" })
    expect(a).toBe(b)
    expect(a).toBe("question text=use the v# token format for new endpoints")
    expect(K.ruleKey({ kind: "thread", repo: "r", among: ["billing", "auth"] })).toBe(K.ruleKey({ kind: "thread", repo: "r", among: ["auth", "billing"] }))
    expect(K.ruleKey({ kind: "ask", sender: "ben", text: "Can I merge?" })).not.toBe(K.ruleKey({ kind: "ask", sender: "marie", text: "Can I merge?" }))
  })

  test("answers compare without case, spaces or a full stop", () => {
    expect(K.normaliseAnswer(" Yes. ")).toBe(K.normaliseAnswer("yes"))
  })

  test("never answered by a rule: key changes, risky features, deletions", () => {
    expect(K.neverAuto({ kind: "team", sender: "ben" })).toBeTruthy()
    expect(K.neverAuto({ kind: "question", text: "delete the old migrations?" })).toBeTruthy()
    expect(K.neverAuto({ kind: "question", text: "ok to drop the v1 table?" })).toBeTruthy()
    expect(K.neverAuto({ kind: "question", text: "ship it?" }, "rm -rf build")).toBeTruthy()
    expect(K.neverAuto({ kind: "question", text: "turn the auth-v2 flag on in production?" })).toBeTruthy()
    expect(K.neverAuto({ kind: "question", text: "use v2 tokens?", risky: true })).toBeTruthy()
    expect(K.neverAuto({ kind: "question", text: "use the v2 token format for new endpoints?" })).toBeNull()
  })
})

// --- offers ------------------------------------------------------------------------

describe("offer on the second identical answer", () => {
  const q = { kind: "question" as const, text: "use the v2 token format for new endpoints?" }
  test("first answer: nothing; second identical: an offer; third: no second offer", () => {
    const h = H.emptyHistory()
    expect(H.recordAnswer(h, q, "yes", { repo: "r", now: 1 })).toBeNull()
    const o = H.recordAnswer(h, q, "Yes.", { repo: "r", sessionId: "s1", now: 2 })
    expect(o).not.toBeNull()
    expect(o!.key).toBe(K.ruleKey(q))
    expect(o!.state).toBe("open")
    expect(H.offerQuestion(o!)).toContain("Always do this")
    expect(H.recordAnswer(h, q, "yes", { repo: "r", now: 3 })).toBeNull()
    expect(H.lastOpen(h, "s1")?.id).toBe(o!.id)
  })
  test("different answers make no offer", () => {
    const h = H.emptyHistory()
    H.recordAnswer(h, q, "yes", { repo: "r" })
    expect(H.recordAnswer(h, q, "no", { repo: "r" })).toBeNull()
  })
  test("questions a rule may never answer are never offered", () => {
    const h = H.emptyHistory()
    const del = { kind: "question" as const, text: "delete the staging data?" }
    H.recordAnswer(h, del, "yes", { repo: "r" })
    expect(H.recordAnswer(h, del, "yes", { repo: "r" })).toBeNull()
    const team = { kind: "team" as const, sender: "ben" }
    H.recordAnswer(h, team, "Trust it", { repo: "r" })
    expect(H.recordAnswer(h, team, "Trust it", { repo: "r" })).toBeNull()
  })
  test("digest lines go to their session, or to whoever asks first", () => {
    const h = H.emptyHistory()
    H.addDigest(h, "*", { id: "a", text: "A" })
    H.addDigest(h, "*", { id: "a", text: "A" })
    H.addDigest(h, "s2", { id: "b", text: "B" })
    expect(H.takeDigest(h, "s2").map((n) => n.id)).toEqual(["b", "a"])
    expect(H.takeDigest(h, "s2")).toEqual([])
  })
})

// --- the rules document ------------------------------------------------------------

describe("RULES.md", () => {
  const ana = { ...newIdentity("ana") }
  const ben = { ...newIdentity("ben") }
  const mk = (id: Identity, peers: Identity[]) =>
    new D.RuleDocs({ identity: id, peers: () => Object.fromEntries(peers.map((p) => [p.label, asPeer(p)])), file: path.join(TMP, `${id.label}-rules.json`) })
  test("sealed to the repo's people, read back by them, merged, and undone with a tombstone", () => {
    const a = mk(ana, [ben])
    const b = mk(ben, [ana])
    const key = K.ruleKey({ kind: "question", text: "use v2 tokens?" })
    const r = a.add("github.com/acme/x", { key, then: "yes", text: `"use v2 tokens?": "yes"`, who: "ana" })
    expect(a.match("github.com/acme/x", key)?.then).toBe("yes")
    const text = a.render("github.com/acme/x", [asPeer(ben)])!
    expect(text).toContain("sealed: true")
    expect(text).not.toContain("v2 tokens")
    const ch = b.read("github.com/acme/x", text)
    expect(ch.added.map((x) => x.id)).toEqual([r.id])
    expect(b.match("github.com/acme/x", key)?.then).toBe("yes")
    // A stranger with no wrap reads nothing.
    const eve = mk(newIdentity("eve"), [ana])
    expect(eve.read("github.com/acme/x", text).added).toEqual([])
    // Undo travels as a tombstone and wins over the stale copy.
    const rm = b.remove(undefined, "v2 tokens")
    expect(rm.ok).toBe(true)
    const back = a.merge("github.com/acme/x", b.frame("github.com/acme/x")!.doc)
    expect(back.removed.map((x) => x.id)).toEqual([r.id])
    expect(a.match("github.com/acme/x", key)).toBeUndefined()
    expect(a.writer("github.com/acme/x", r.id)).toBe(fingerprint(ben.ed.pub))
  })
  test("the same rule made twice at once is one rule", () => {
    const a = mk(ana, [ben])
    const b = mk(ben, [ana])
    const key = K.ruleKey({ kind: "route", sender: "marie", repo: "r2" })
    a.add("r2", { key, then: "auth", text: "x", who: "ana" })
    b.add("r2", { key, then: "auth", text: "x", who: "ben" })
    a.merge("r2", b.frame("r2")!.doc, b.frame("r2")!.key)
    b.merge("r2", a.frame("r2")!.doc, a.frame("r2")!.key)
    expect(a.rules("r2").length).toBe(1)
    expect(a.frame("r2")!.key).toBe(b.frame("r2")!.key)
  })
})

// --- main session ---------------------------------------------------------------------

describe("main session", () => {
  const item = (id: string, kind: UiItem["kind"], sessionId: string, at = 1): UiItem => ({ id, kind, sessionId, state: "pending", createdAt: at, updatedAt: at })
  const open = [
    item("msg:1", "message", "work", 1),
    item("route:1", "route", "work", 2),
    item("team:1", "team", "work", 3),
    item("gather:work", "gather", "work", 4),
    item("gather:main", "gather", "main", 5),
    item("thread:1", "thread", "work", 6),
    item("msg:2", "ask", "main", 7),
  ]
  test("no main: every session sees its own items", () => {
    expect(Main.itemsFor(open, "work").map((i) => i.id)).toEqual(["msg:1", "route:1", "team:1", "gather:work", "thread:1"])
  })
  test("main open: a working session keeps only its own thread's items", () => {
    expect(Main.itemsFor(open, "work", "main").map((i) => i.id)).toEqual(["msg:1", "thread:1"])
  })
  test("main gets every cross-cutting item, one gather offer", () => {
    expect(Main.itemsFor(open, "main", "main").map((i) => i.id)).toEqual(["route:1", "team:1", "gather:main", "msg:2"])
  })
  test("questions from other threads and unmatched messages go to main; own-thread ones stay", () => {
    expect(Main.redirect({ how: "footprint 3", kind: "ask", intent: "question", target: "work", mainId: "main" })).toBe("main")
    expect(Main.redirect({ how: "footprint 3", kind: "message", intent: "question", target: "work", mainId: "main" })).toBe("main")
    expect(Main.redirect({ how: "footprint 3", kind: "message", intent: "fyi", target: "work", mainId: "main" })).toBe("work")
    expect(Main.redirect({ how: "thread", kind: "ask", intent: "question", target: "work", mainId: "main" })).toBe("work")
    expect(Main.redirect({ how: "no footprint", kind: "message", intent: "fyi", target: undefined, mainId: "main" })).toBe("main")
    expect(Main.redirect({ how: "footprint 3", kind: "ask", intent: "question", target: "work" })).toBe("work")
    expect(Main.crossNote("combine:abc")).toBe(true)
    expect(Main.crossNote("summary:x")).toBe(false)
  })
  test("one main per machine: the last one wins and says who was main before", () => {
    expect(Main.setMain(true, { sessionId: "a", name: "a" }).changed).toBe(true)
    const r = Main.setMain(true, { sessionId: "b", name: "b" })
    expect(r.previous?.sessionId).toBe("a")
    expect(Main.currentMain()?.sessionId).toBe("b")
    expect(Main.mainElsewhere("a")).toBe(true)
    expect(Main.setMain(false, { sessionId: "a", name: "a" }).changed).toBe(false)
    expect(Main.setMain(false, { sessionId: "b", name: "b" }).changed).toBe(true)
    expect(Main.currentMain()).toBeNull()
  })
})

// --- outline ---------------------------------------------------------------------------

describe("symbol outline", () => {
  const before = [
    `import x from "y"`,
    ``,
    `export function parse(s: string) {`,
    `  return s.trim()`,
    `}`,
    ``,
    `export const LIMIT = 3`,
    ``,
    `export default async function main() {`,
    `  return 1`,
    `}`,
    `class Store {`,
    `  get() {}`,
    `}`,
  ].join("\n")
  test("top-level TS symbols with their lines", () => {
    const o = O.outline(before, "ts")
    expect(o.map((s) => s.name)).toEqual(["parse", "LIMIT", "main", "Store"])
    expect(o[0]).toEqual({ name: "parse", start: 3, end: 6 })
  })
  test("which symbols changed between two versions", () => {
    const after = before.replace("s.trim()", "s.trim().toLowerCase()").replace("class Store {", "class Store {\n  size = 0")
    expect(O.changedSymbols("src/a.ts", before, after).sort()).toEqual(["Store", "parse"])
    expect(O.changedSymbols("src/a.ts", before, before)).toEqual([])
    expect(O.changedSymbols("src/a.ts", null, "export const A = 1\n")).toEqual(["A"])
    expect(O.changedSymbols("README.md", "a", "b")).toEqual([O.WHOLE])
  })
  test("an edit's new text lands in its symbol", () => {
    const after = before.replace("  return 1", "  return 2")
    expect(O.symbolsOfEdit("src/a.ts", after, "  return 2")).toEqual(["main"])
    expect(O.symbolsOfEdit("src/a.ts", after, "nowhere")).toBeNull()
  })
  test("python: def, class and assignments", () => {
    const py = "import os\n\ndef parse(s):\n    return s\n\nclass Store:\n    pass\n\nLIMIT = 3\nasync def run():\n    pass\n"
    expect(O.outline(py, "py").map((s) => s.name)).toEqual(["parse", "Store", "LIMIT", "run"])
    expect(O.changedSymbols("a.py", py, py.replace("return s", "return s.strip()"))).toEqual(["parse"])
  })
  test("matching: the same symbol, or the whole file against anything", () => {
    expect(O.overlapping(["parse", "LIMIT"], ["parse"])).toEqual(["parse"])
    expect(O.overlapping(["main"], ["parse"])).toEqual([])
    expect(O.overlapping([O.WHOLE], ["parse"])).toEqual(["parse"])
    expect(O.overlapping([O.WHOLE], [O.WHOLE])).toEqual([O.WHOLE])
  })
  test("the hook's report: symbols, unmerged symbols and the diff, from git", () => {
    const repo = path.join(TMP, "edit-repo")
    fs.mkdirSync(path.join(repo, "src"), { recursive: true })
    g(repo, "init", "-q", "-b", "main")
    fs.writeFileSync(path.join(repo, "src/a.ts"), before)
    g(repo, "add", ".")
    g(repo, "commit", "-q", "-m", "init")
    fs.writeFileSync(path.join(repo, "src/a.ts"), before.replace("  return 1", "  return 2").replace("s.trim()", "s"))
    const rep = E.editReport({ cwd: repo, tool: "Edit", input: { file_path: "src/a.ts", old_string: "  return 1", new_string: "  return 2" } })!
    expect(rep.file).toBe("src/a.ts")
    expect(rep.symbols).toEqual(["main"])
    expect(rep.pending.sort()).toEqual(["main", "parse"])
    expect(rep.diff).toContain("+  return 2")
    expect(E.editReport({ cwd: repo, tool: "Read", input: { file_path: "src/a.ts" } })).toBeNull()
  })
})

// --- rate limit ------------------------------------------------------------------------

describe("rate limit", () => {
  test("first at once, the rest of the window coalesced into one, per key", () => {
    let now = 0
    const timers: { at: number; fn: () => void }[] = []
    const clock = { now: () => now, after: (ms: number, fn: () => void) => timers.push({ at: now + ms, fn }) }
    const sent: [string, number[]][] = []
    const gate = new G.Gate<number>(1000, (k, xs) => sent.push([k, xs]), clock)
    expect(gate.offer("f|t", 1)).toBe("sent")
    now = 100
    expect(gate.offer("f|t", 2)).toBe("queued")
    now = 200
    expect(gate.offer("f|t", 3)).toBe("queued")
    expect(gate.offer("g|t", 9)).toBe("sent")
    expect(sent).toEqual([["f|t", [1]], ["g|t", [9]]])
    now = 1000
    timers.splice(0).forEach((t) => t.fn())
    expect(sent[2]).toEqual(["f|t", [2, 3]])
    now = 1500
    expect(gate.offer("f|t", 4)).toBe("queued")
    now = 2600
    expect(gate.offer("f|t", 5)).toBe("queued")
    timers.splice(0).forEach((t) => t.fn())
    expect(sent[3]).toEqual(["f|t", [4, 5]])
  })
})

// --- conflicts --------------------------------------------------------------------------

describe("conflict agreement", () => {
  const a = { thread: "ta", name: "auth", label: "ana" }
  const b = { thread: "tb", name: "billing", label: "ben" }
  test("the same id from either side; agreeing names the same owner", () => {
    const c = C.newConflict({ repo: "r", file: "f.ts", symbol: "parse", a, b })
    expect(c.id).toBe(C.newConflict({ repo: "r", file: "f.ts", symbol: "parse", a: b, b: a }).id)
    expect(C.ownerOf(c, "ta", "mine")).toBe("ta")
    expect(C.ownerOf(c, "ta", "theirs")).toBe("tb")
    expect(C.ownerOf(c, "tb", "auth")).toBe("ta")
    expect(C.propose(c, "ta", { owner: "ta", text: "", at: 1, by: "ana" })).toBe("waiting")
    expect(C.propose(c, "tb", { owner: "ta", text: "", at: 2, by: "ben" })).toBe("agreed")
    expect(c.owner).toBe("ta")
  })
  test("disagreement for N rounds is one question to the people", () => {
    process.env.CROSSTALK_CONFLICT_ROUNDS = "2"
    const c = C.newConflict({ repo: "r", file: "f.ts", symbol: "parse", a, b })
    C.propose(c, "ta", { owner: "ta", text: "1", at: 1, by: "ana" })
    expect(C.propose(c, "tb", { owner: "tb", text: "1", at: 2, by: "ben" })).toBe("disagree")
    expect(C.propose(c, "ta", { owner: "ta", text: "2", at: 3, by: "ana" })).toBe("ask")
    expect(c.state).toBe("asked")
    expect(C.propose(c, "tb", { owner: "tb", text: "2", at: 4, by: "ben" })).toBe("disagree")
    expect(C.decide(c, "tb")).toBe(true)
    expect(C.decide(c, "tb")).toBe(false)
  })
})

describe("heads-up and conflict between two machines", () => {
  // Two WarnServices, each with a stub of the thread service, wired to each other.
  type Stub = { threads: Record<string, M.Thread>; placed: Record<string, string[]> }
  function stub(me: string, s: Stub) {
    return {
      list: () => Object.values(s.threads).map((t) => ({ id: t.id })),
      thread: (id: string) => s.threads[id],
      idsFor: (sid: string) => s.placed[sid] ?? [],
      sessionsIn: (ids: string[]) => Object.keys(s.placed).filter((sid) => s.placed[sid].some((t) => ids.includes(t))),
      resolve: (id: string) => id,
      decide: (_sid: string | undefined, o: { text: string; thread?: string }) => {
        const t = s.threads[o.thread!]
        if (t) M.put(t, "notes", M.newItemId("d"), { kind: "decision", text: o.text, who: me, at: 1 }, me)
        return { ok: true }
      },
    } as any
  }
  test("an edit to a file in the other thread's footprint is a heads-up there; the same function edited on both sides is a conflict for both", () => {
    const anaId = newIdentity("ana")
    const benId = newIdentity("ben")
    const repo = "github.com/acme/x"
    const ta = M.create({ id: "aaaaaaaa00000001", name: "auth", repo, by: "a", label: "ana" })
    const tb = M.create({ id: "bbbbbbbb00000001", name: "billing", repo, by: "b", label: "ben" })
    const sa: Stub = { threads: { [ta.id]: ta }, placed: { "a-auth": [ta.id] } }
    const sb: Stub = { threads: { [tb.id]: tb }, placed: { "b-bill": [tb.id] } }
    const got: Record<string, { sid: string; kind: string; text: string; slices: number }[]> = { ana: [], ben: [] }
    const asked: string[] = []
    let A: InstanceType<typeof W.WarnService>
    let B: InstanceType<typeof W.WarnService>
    const deliverTo = (who: "ana" | "ben") => (sid: string, m: any) => got[who].push({ sid, kind: m.kind, text: m.text, slices: m.slices.length })
    const presenceOfBen = new Map([["ben", { at: 1, sessions: [{ name: "b-bill", cwd: "/", status: "idle", lastSeen: 1, footprint: { repo, branch: "billing", paths: ["src/billing/x.ts", "src/shared/util.ts"] }, threads: [tb.id] }] }]])
    A = new W.WarnService({
      me: fingerprint(anaId.ed.pub),
      label: "ana",
      threads: stub("ana", sa),
      peers: () => ({ ben: asPeer(benId) }),
      presence: () => presenceOfBen as any,
      send: (_l, env: Envelope) => (env.kind === "heads-up" ? B.acceptHeadsUp("ana", env) : B.acceptConflict("ana", env)),
      deliver: deliverTo("ana"),
      ask: (sids) => asked.push(...sids),
      log: () => {},
      file: path.join(TMP, "warn-a.json"),
      rateMs: 60_000,
    })
    B = new W.WarnService({
      me: fingerprint(benId.ed.pub),
      label: "ben",
      threads: stub("ben", sb),
      peers: () => ({ ana: asPeer(anaId) }),
      presence: () => new Map(),
      send: (_l, env: Envelope) => (env.kind === "heads-up" ? A.acceptHeadsUp("ben", env) : A.acceptConflict("ben", env)),
      deliver: deliverTo("ben"),
      ask: (sids) => asked.push(...sids),
      log: () => {},
      file: path.join(TMP, "warn-b.json"),
      rateMs: 60_000,
    })
    const r1 = A.edited({ sessionId: "a-auth", name: "a-auth", repo, edit: { file: "src/shared/util.ts", symbols: ["parse"], pending: ["parse"], diff: "+x" } })
    expect(r1.warned).toEqual(["b-bill"])
    expect(got.ben.map((m) => [m.sid, m.kind, m.slices])).toEqual([["b-bill", "heads-up", 1]])
    expect(got.ben[0].text).toContain("src/shared/util.ts (parse)")
    // A second edit within the window is coalesced, not sent now.
    A.edited({ sessionId: "a-auth", name: "a-auth", repo, edit: { file: "src/shared/util.ts", symbols: ["parse"], pending: ["parse"], diff: "+y" } })
    expect(got.ben.length).toBe(1)
    // Ben edits the same function: both get a conflict naming the other.
    const r2 = B.edited({ sessionId: "b-bill", name: "b-bill", repo, edit: { file: "src/shared/util.ts", symbols: ["parse"], pending: ["parse"], diff: "+z" } })
    expect(r2.conflicts.length).toBe(1)
    expect(got.ben.filter((m) => m.kind === "conflict").length).toBe(1)
    expect(got.ana.filter((m) => m.kind === "conflict").length).toBe(1)
    expect(got.ana.find((m) => m.kind === "conflict")!.text).toContain("billing")
    expect(got.ben.find((m) => m.kind === "conflict")!.text).toContain("auth")
    expect(got.ana.find((m) => m.kind === "heads-up")?.sid).toBe("a-auth")
    // They agree: auth changes it; both threads record the decision.
    const id = r2.conflicts[0]
    expect(A.propose("a-auth", { id, owner: "mine", text: "auth owns parsing" }).outcome).toBe("waiting")
    expect(B.propose("b-bill", { id, owner: "theirs" }).outcome).toBe("agreed")
    expect(A.conflict(id).state).toBe("agreed")
    expect(M.notes(ta, "decision").some((d) => /auth changes it/.test(d.text))).toBe(true)
    expect(M.notes(tb, "decision").some((d) => /auth changes it/.test(d.text))).toBe(true)
    expect(asked).toEqual([])
  })
})

// --- first use ---------------------------------------------------------------------------

describe("first use, per repo", () => {
  const repo = (name: string) => {
    const bare = path.join(TMP, `${name}.git`)
    const dir = path.join(TMP, name)
    spawnSync("git", ["init", "-q", "--bare", bare])
    spawnSync("git", ["clone", "-q", bare, dir])
    return dir
  }
  beforeEach(() => fs.rmSync(path.join(process.env.CROSSTALK_HOME!, "repotrust"), { recursive: true, force: true }))
  test("asked once per repo, nothing allowed before a yes, a no is for good", async () => {
    const one = repo("one")
    const two = repo("two")
    expect(FU.allowed("local/one")).toBe(false)
    const o1 = await FU.offer(one, "s1")
    expect(o1?.slug).toBe("local/one")
    expect(o1?.question).toContain("shares your GitHub name and a public key")
    expect(await FU.offer(one, "s2")).toBeNull()
    expect(FU.allowed("local/one")).toBe(false)
    expect((await FU.offer(two, "s2"))?.slug).toBe("local/two")
    await FU.record("local/two", false)
    expect(FU.consent("local/two")).toBe("no")
    expect(await FU.offer(two, "s3")).toBeNull()
    expect(FU.openAsks()).toEqual(["local/one"])
  })
  test("yes makes an identity when there is none", async () => {
    const id = path.join(process.env.CROSSTALK_HOME!, "identity.json")
    fs.rmSync(id, { force: true })
    process.env.CROSSTALK_GITHUB_LOGIN = "ana"
    const r = await FU.record("local/one", true)
    expect(r.created).toBe("ana")
    expect(fs.existsSync(id)).toBe(true)
    expect(FU.allowed("local/one")).toBe(true)
    process.env.CROSSTALK_NO_REPOTRUST = "1"
    expect(FU.allowed("local/one")).toBe(false)
    delete process.env.CROSSTALK_NO_REPOTRUST
  })
  test("not a GitHub repo, or turned off: nothing to ask", async () => {
    const plain = path.join(TMP, "plain")
    fs.mkdirSync(plain)
    spawnSync("git", ["init", "-q", plain])
    expect(await FU.offer(plain, "s")).toBeNull()
    process.env.CROSSTALK_NO_REPOTRUST = "1"
    expect(await FU.offer(repo("three"), "s")).toBeNull()
    delete process.env.CROSSTALK_NO_REPOTRUST
  })
  test("the mod gets a picker, a session without it a systemMessage", async () => {
    const four = repo("four")
    const five = repo("five")
    const withMod = await FU.surface(four, "m1", true)
    expect(withMod.item?.kind).toBe("connect")
    expect(withMod.item?.options).toEqual([FU.CONNECT, FU.NOT_HERE])
    expect(withMod.systemMessage).toBeUndefined()
    const without = await FU.surface(five, "m2", false)
    expect(without.systemMessage).toContain("Let teammates in local/five reach you through crosstalk?")
    expect(without.item).toBeUndefined()
  })
})
