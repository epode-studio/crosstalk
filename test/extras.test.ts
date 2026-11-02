// Disk, team install, re-keying, measurements and threads across repos.
//
//   bun test test/extras.test.ts
//
// Real git repositories in a temp folder throughout; the daemon round trip is
// test/extras.sh.

import { afterAll, beforeAll, describe, expect, test } from "bun:test"
import { spawnSync } from "node:child_process"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), "ct-extras-"))
process.env.CROSSTALK_HOME = path.join(TMP, "home")
fs.mkdirSync(process.env.CROSSTALK_HOME, { recursive: true })
afterAll(() => fs.rmSync(TMP, { recursive: true, force: true }))

const M = await import("../src/threads/model.ts")
const F = await import("../src/threads/format.ts")
const K = await import("../src/threads/rekey.ts")
const { unwrapKey } = await import("../src/threads/seal.ts")
const { ThreadService } = await import("../src/threads/service.ts")
const { RuleDocs } = await import("../src/rules/doc.ts")
const { fingerprint, newIdentity } = await import("../src/crypto.ts")
const Disk = await import("../src/disk/scan.ts")
const B = await import("../src/disk/budget.ts")
const Team = await import("../src/install/team.ts")
const Log = await import("../src/metrics/log.ts")
const Stats = await import("../src/metrics/stats.ts")
const T = await import("../src/metrics/transcripts.ts")
const X = await import("../src/threads/crossrepo.ts")
const { git: liveGit } = await import("../src/terminal/repo.ts")

type Identity = ReturnType<typeof newIdentity>
const asPeer = (id: Identity) => ({ label: id.label, edPub: id.ed.pub, xPub: id.x.pub, fingerprint: fingerprint(id.ed.pub), joinedAt: 0 })

const g = (cwd: string, ...args: string[]) => {
  const r = spawnSync("git", ["-C", cwd, "-c", "user.email=t@t", "-c", "user.name=t", ...args], { encoding: "utf8" })
  if (r.status !== 0) throw new Error(`git ${args.join(" ")}: ${r.stderr}`)
  return r.stdout.trim()
}
function repo(dir: string, remote?: string) {
  fs.mkdirSync(dir, { recursive: true })
  g(dir, "init", "-q", "-b", "main")
  if (remote) g(dir, "remote", "add", "origin", remote)
  fs.writeFileSync(path.join(dir, "README"), "hi\n")
  g(dir, "add", ".")
  g(dir, "commit", "-q", "-m", "init")
  return dir
}

// --- re-key on leave ------------------------------------------------------------------

describe("re-key on leave", () => {
  const ana = newIdentity("ana")
  const ben = newIdentity("ben")
  const cat = newIdentity("cat")
  const [fa, fb, fc] = [ana, ben, cat].map((i) => fingerprint(i.ed.pub))
  let revoked = new Set<string>()
  const svc = new ThreadService({
    identity: ana,
    peers: () => ({ ben: asPeer(ben), cat: asPeer(cat) }),
    send: () => {},
    log: () => {},
    file: path.join(TMP, "rekey-svc.json"),
    network: false,
    revoked: () => revoked,
  })
  const repoName = "github.com/acme/api"
  const t = svc.open({ name: "auth", repo: repoName })
  svc.mutate(t.id, (th, by, now) => {
    M.put(th, "people", fb, { label: "ben" }, by, now)
    M.put(th, "people", fc, { label: "cat" }, by, now)
    M.put(th, "notes", "d_1", { kind: "decision", text: "before cat left", who: "ana", at: now }, by, now)
  })
  const render = () => (svc as any).render(repoName)[`${t.id}.md`] as string
  const opens = (id: Identity, text: string, oldKey?: Buffer) => {
    const p = F.parse(text)
    if (p.kind !== "sealed") throw new Error("not sealed")
    const k = unwrapKey(id, p.wraps, [asPeer(ana)])
    return { key: k, viaWrap: k ? p.open(k) : null, viaOld: oldKey ? p.open(oldKey) : null, epoch: p.epoch }
  }

  test("everyone in it can open it before", () => {
    const before = render()
    expect(opens(cat, before).viaWrap).not.toBeNull()
    expect(opens(ben, before).viaWrap).not.toBeNull()
    expect(svc.keyEpoch(t.id)).toBe(0)
  })

  test("a removed person cannot open sections sealed after removal; the rest can", () => {
    const catsKey = opens(cat, render()).key!
    const r = svc.removePerson(t.id, fc)
    expect(r).toMatchObject({ ok: true, rekeyed: true })
    svc.mutate(t.id, (th, by, now) => M.put(th, "notes", "d_2", { kind: "decision", text: "after cat left", who: "ana", at: now }, by, now))
    const after = render()
    const c = opens(cat, after, catsKey)
    expect(c.key).toBeNull()
    expect(c.viaOld).toBeNull()
    expect(c.epoch).toBe(1)
    const b = opens(ben, after)
    expect(M.view(b.viaWrap!).notes.filter((n) => n.kind === "decision").map((d) => d.text)).toEqual(["before cat left", "after cat left"])
    expect(K.isRemoved(b.viaWrap!, fc)).toBe(true)
  })

  test("a frame from someone taken out is ignored, and nobody's presence puts them back", () => {
    const stale = svc.thread(t.id)!
    const theirs = JSON.parse(JSON.stringify(stale))
    theirs.people[fc] = { label: "cat", l: 9999, by: fc, id: fc }
    svc.accept("cat", { v: 1, id: "x", ts: 0, from: "cat", fromSession: "-", to: "ana", kind: "thread", intent: "fyi", text: "", threadSync: { thread: theirs } } as any)
    expect(M.people(svc.thread(t.id)!)).not.toContain(fc)
  })

  test("a stale old key never wins over the new one", () => {
    expect(K.wins({ key: "b", epoch: 1 }, { key: "a", epoch: 0 })).toBe(false)
    expect(K.wins({ key: "b", epoch: 1 }, { key: "a", epoch: 1 })).toBe(true)
    expect(K.wins({ key: "a", epoch: 1 }, { key: "z", epoch: 2 })).toBe(true)
    const keyNow = (svc as any).st.keys[t.id]
    svc.accept("ben", { v: 1, id: "y", ts: 0, from: "ben", fromSession: "-", to: "ana", kind: "thread", intent: "fyi", text: "", threadSync: { thread: svc.thread(t.id), key: Buffer.alloc(32).toString("base64") } } as any)
    expect((svc as any).st.keys[t.id]).toBe(keyNow)
  })

  test("revoking someone's key through repo trust re-keys too", () => {
    revoked = new Set([fb])
    svc.mutate(t.id, (th, by, now) => M.setRecap(th, by, "touch", now))
    expect(svc.keyEpoch(t.id)).toBe(2)
    expect(opens(ben, render()).key).toBeNull()
    revoked = new Set()
  })

  test("leaving yourself: you are out, the others re-key when they hear it", () => {
    const bens = new ThreadService({ identity: ben, peers: () => ({ ana: asPeer(ana) }), send: () => {}, log: () => {}, file: path.join(TMP, "rekey-ben.json"), network: false, revoked: () => new Set() })
    const t2 = bens.open({ name: "billing", repo: repoName })
    bens.mutate(t2.id, (th, by, now) => M.put(th, "people", fa, { label: "ana" }, by, now))
    svc.accept("ben", { v: 1, id: "z", ts: 0, from: "ben", fromSession: "-", to: "ana", kind: "thread", intent: "fyi", text: "", threadSync: { thread: bens.thread(t2.id), key: (bens as any).st.keys[t2.id] } } as any)
    expect(svc.thread(t2.id)).toBeDefined()
    const sent: any[] = []
    ;(svc as any).d.send = (to: string, env: any) => sent.push({ to, env })
    ;(svc as any).capable.add("ben")
    expect(svc.removePerson(t2.id, fa).ok).toBe(true)
    const frame = sent.find((s) => s.to === "ben")?.env
    expect(frame).toBeDefined()
    const before = bens.keyEpoch(t2.id)
    bens.accept("ana", frame)
    expect(M.people(bens.thread(t2.id)!)).toEqual([fingerprint(ben.ed.pub)])
    expect(bens.keyEpoch(t2.id)).toBe(before + 1)
  })

  test("RULES.md gets a new key when someone is in none of the repo's threads", () => {
    const docs = new RuleDocs({ identity: ana, peers: () => ({ ben: asPeer(ben), cat: asPeer(cat) }), file: path.join(TMP, "rules-docs.json") })
    docs.add(repoName, { key: "question text=x", then: "yes", text: "always yes to x", who: "ana" })
    expect(docs.ensureKey(repoName, [fa, fb, fc])).toBe(false)
    const first = docs.render(repoName, [asPeer(ben), asPeer(cat)])!
    const catsKey = unwrapKey(cat, (F.parse(first) as any).wraps, [asPeer(ana)])!
    expect(catsKey).not.toBeNull()
    expect(docs.ensureKey(repoName, [fa, fb])).toBe(true)
    const next = docs.render(repoName, [asPeer(ben)])!
    const p = F.parse(next) as any
    expect(p.epoch).toBe(1)
    expect(unwrapKey(cat, p.wraps, [asPeer(ana)])).toBeNull()
    expect(p.open(catsKey)).toBeNull()
    expect(p.open(unwrapKey(ben, p.wraps, [asPeer(ana)])!)).not.toBeNull()
    expect(docs.frame(repoName)?.epoch).toBe(1)
  })
})

// --- disk --------------------------------------------------------------------------

describe("disk", () => {
  const claude = path.join(TMP, "claude")
  const main = path.join(TMP, "proj")
  const wt = (n: string) => path.join(main, ".claude", "worktrees", n)
  const projects = path.join(claude, "projects", "-proj")
  const old = Date.now() - 40 * Disk.DAY

  beforeAll(() => {
    repo(main)
    fs.writeFileSync(path.join(main, ".gitignore"), ".claude/\n")
    g(main, "add", ".")
    g(main, "commit", "-q", "-m", "ignore")
    // done: its work is merged. wip: not merged. busy: merged, but a session is in it. dirty: merged, with a change.
    for (const n of ["done", "wip", "busy", "dirty"]) g(main, "worktree", "add", "-q", "-b", n, wt(n))
    fs.writeFileSync(path.join(wt("done"), "a.txt"), "a\n")
    g(wt("done"), "add", ".")
    g(wt("done"), "commit", "-q", "-m", "done work")
    g(main, "merge", "-q", "--ff-only", "done")
    fs.writeFileSync(path.join(wt("wip"), "b.txt"), "b\n")
    g(wt("wip"), "add", ".")
    g(wt("wip"), "commit", "-q", "-m", "wip")
    fs.writeFileSync(path.join(wt("dirty"), "c.txt"), "c\n")
    // gone: its branch was deleted after it merged.
    g(main, "worktree", "add", "-q", "--detach", wt("gone"))
    // A worktree outside Claude Code's folder is never a candidate.
    g(main, "worktree", "add", "-q", "-b", "elsewhere", path.join(TMP, "elsewhere"))

    fs.mkdirSync(projects, { recursive: true })
    const line = (cwd: string) => JSON.stringify({ type: "user", cwd, message: { role: "user", content: "hi" } }) + "\n"
    fs.writeFileSync(path.join(projects, "live.jsonl"), line(main))
    fs.writeFileSync(path.join(projects, "old-gone.jsonl"), line(path.join(TMP, "deleted-folder")))
    fs.mkdirSync(path.join(projects, "old-gone", "subagents"), { recursive: true })
    fs.writeFileSync(path.join(projects, "old-gone", "subagents", "x.jsonl"), "x".repeat(5000))
    fs.writeFileSync(path.join(projects, "new-gone.jsonl"), line(path.join(TMP, "deleted-folder-2")))
    fs.writeFileSync(path.join(projects, "old-here.jsonl"), line(main))
    for (const f of ["old-gone.jsonl", "old-here.jsonl"]) fs.utimesSync(path.join(projects, f), old / 1000, old / 1000)
  })

  const env = (): import("../src/disk/scan.ts").Env => ({
    claudeDir: claude,
    now: Date.now(),
    git: liveGit,
    liveCwds: [path.join(wt("busy"), "src")],
    repos: [],
    sizeKb: Disk.duKb,
    threadOf: (_r, b) => (b === "done" ? "auth-tokens" : undefined),
  })

  test("finds the stale worktree and the old transcript, and nothing else", async () => {
    const r = await Disk.scan(env())
    const got = r.reclaim.map((i) => `${i.kind}:${path.basename(i.path)}`).sort()
    expect(got).toEqual(["transcript:old-gone.jsonl", "worktree:done", "worktree:gone"])
    expect(r.reclaim.find((i) => i.path.endsWith("done"))!.group).toBe("auth-tokens")
    expect(r.kept.map((k) => `${path.basename(k.path)}: ${k.why}`).sort()).toEqual([
      "busy: a session is working in it",
      "dirty: it has changes",
      "wip: its work is not merged",
    ])
    expect(r.usedKb).toBeGreaterThanOrEqual(r.reclaimKb)
    expect(r.groups).toBe(3)
  })

  test("asks once over budget, deletes nothing until Free it, then offers a standing rule the second time", async () => {
    process.env.CROSSTALK_DISK_BUDGET_GB = "0.000001"
    const asked: { id: string; question: string; options: string[] }[] = []
    const b = new B.Budget({ scan: () => Disk.scan(env()), free: (c, f) => Disk.free(c, f), ask: (o) => asked.push(o), settle: () => {}, digest: () => {} })
    await b.check()
    expect(asked.length).toBe(1)
    expect(asked[0].question).toMatch(/^Worktrees and old sessions are using .+; free .+ from 3 finished threads\?$/)
    expect(asked[0].options).toEqual([B.FREE, B.SHOW, B.NOT_NOW])
    // Asked again within the day: no second question.
    await b.check()
    expect(asked.length).toBe(1)
    expect(fs.existsSync(wt("done"))).toBe(true)
    const shown = await b.answer(asked[0].id, B.SHOW)
    expect(shown.text).toContain("auth-tokens")
    expect(fs.existsSync(wt("done"))).toBe(true)
    expect(fs.existsSync(path.join(projects, "old-gone.jsonl"))).toBe(true)

    const freed = await b.answer(asked[1].id, B.FREE)
    expect(freed.text).toMatch(/freed .+ \(3 items\)/)
    expect(fs.existsSync(wt("done"))).toBe(false)
    expect(fs.existsSync(wt("gone"))).toBe(false)
    expect(fs.existsSync(path.join(projects, "old-gone.jsonl"))).toBe(false)
    expect(fs.existsSync(path.join(projects, "old-gone"))).toBe(false)
    expect(g(main, "branch", "--list", "done")).toBe("")
    for (const n of ["wip", "busy", "dirty"]) expect(fs.existsSync(wt(n))).toBe(true)
    expect(fs.existsSync(path.join(projects, "new-gone.jsonl"))).toBe(true)
    expect(fs.existsSync(path.join(projects, "old-here.jsonl"))).toBe(true)
    expect(asked.some((a) => a.id.startsWith("disk-rule:"))).toBe(false)

    // The second yes offers the standing rule.
    g(main, "worktree", "add", "-q", "--detach", wt("again"))
    B.save({ ...B.load(), askedAt: 0, questionId: undefined })
    await b.check()
    const q = asked[asked.length - 1]
    await b.answer(q.id, B.FREE)
    expect(fs.existsSync(wt("again"))).toBe(false)
    const rule = asked[asked.length - 1]
    expect(rule.id.startsWith("disk-rule:")).toBe(true)
    expect(rule.options).toEqual([B.ALWAYS, B.NOT_NOW])
    await b.answer(rule.id, B.ALWAYS)
    expect(B.load().rule).toBe(true)

    // With the rule, a check over budget frees by itself and says so.
    g(main, "worktree", "add", "-q", "--detach", wt("third"))
    const notes: string[] = []
    const b2 = new B.Budget({ scan: () => Disk.scan(env()), free: (c, f) => Disk.free(c, f), ask: (o) => asked.push(o), settle: () => {}, digest: (_id, t) => notes.push(t) })
    B.save({ ...B.load(), askedAt: 0, questionId: undefined })
    await b2.check()
    expect(fs.existsSync(wt("third"))).toBe(false)
    expect(notes[0]).toContain("by your standing rule")
    delete process.env.CROSSTALK_DISK_BUDGET_GB
  })

  test("free removes only what a fresh look still finds finished", async () => {
    const r = await Disk.scan(env())
    const fake = [{ kind: "worktree" as const, path: wt("wip"), kb: 1, group: "x", why: "pretend", repo: main }]
    const out = Disk.free(fake, r)
    expect(out[0].ok).toBe(false)
    expect(fs.existsSync(wt("wip"))).toBe(true)
  })
})

// --- teammates install nothing -------------------------------------------------------

describe("team install", () => {
  test("merging keeps every other setting, and never replaces what is set", () => {
    const existing = {
      permissions: { allow: ["Bash(bun test:*)"] },
      enabledPlugins: { "formatter@acme": true },
      extraKnownMarketplaces: { acme: { source: { source: "github", repo: "acme/plugins" } } },
      hooks: { Stop: [] },
    }
    const m = Team.mergeSettings(existing)
    expect(m.changed).toBe(true)
    expect(m.settings).toEqual({
      permissions: { allow: ["Bash(bun test:*)"] },
      enabledPlugins: { "formatter@acme": true, "crosstalk@epode": true },
      extraKnownMarketplaces: { acme: { source: { source: "github", repo: "acme/plugins" } }, epode: { source: { source: "github", repo: "epode-studio/crosstalk" } } },
      hooks: { Stop: [] },
    })
    expect(existing.enabledPlugins).toEqual({ "formatter@acme": true })
    const off = Team.mergeSettings({ enabledPlugins: { "crosstalk@epode": false } })
    expect(off.settings.enabledPlugins["crosstalk@epode"]).toBe(false)
    expect(off.kept.join()).toContain("left as it is")
    expect(Team.mergeSettings(m.settings).changed).toBe(false)
  })

  test("yes writes it unstaged, and a broken file is not touched", () => {
    const root = repo(path.join(TMP, "team-a"), "git@github.com:acme/api.git")
    fs.mkdirSync(path.join(root, ".claude"))
    fs.writeFileSync(path.join(root, ".claude", "settings.json"), JSON.stringify({ model: "opus" }))
    g(root, "add", ".")
    g(root, "commit", "-q", "-m", "settings")
    expect(Team.shouldOffer({ slug: "acme/api", root, inUse: true, connected: true })).toBe(true)
    expect(Team.shouldOffer({ slug: "acme/api", root, inUse: true, connected: false })).toBe(false)
    Team.markAsked("acme/api", root)
    expect(Team.shouldOffer({ slug: "acme/api", root, inUse: true, connected: true })).toBe(false)
    const r = Team.answer("acme/api", true)
    expect(r.ok).toBe(true)
    expect(r.text).toContain("unstaged")
    const s = JSON.parse(fs.readFileSync(path.join(root, ".claude", "settings.json"), "utf8"))
    expect(s.model).toBe("opus")
    expect(s.enabledPlugins["crosstalk@epode"]).toBe(true)
    expect(g(root, "status", "--porcelain")).toBe("M .claude/settings.json")
    expect(g(root, "diff", "--cached", "--name-only")).toBe("")
    expect(Team.enabled(root)).toBe(true)

    const broken = repo(path.join(TMP, "team-b"))
    fs.mkdirSync(path.join(broken, ".claude"))
    fs.writeFileSync(path.join(broken, ".claude", "settings.json"), "{ nope")
    expect(Team.apply(broken).ok).toBe(false)
    expect(fs.readFileSync(path.join(broken, ".claude", "settings.json"), "utf8")).toBe("{ nope")
  })

  test("with .crosstalk/ship naming a push mode it is committed on the default branch", () => {
    const root = repo(path.join(TMP, "team-c"))
    fs.mkdirSync(path.join(root, ".crosstalk"))
    fs.writeFileSync(path.join(root, ".crosstalk", "ship"), "push: local\n")
    g(root, "add", ".")
    g(root, "commit", "-q", "-m", "ship")
    const r = Team.apply(root)
    expect(r).toMatchObject({ ok: true, committed: true })
    expect(JSON.parse(g(root, "show", "main:.claude/settings.json")).enabledPlugins["crosstalk@epode"]).toBe(true)
    expect(g(root, "status", "--porcelain")).toBe("")
  })
})

// --- measurement ------------------------------------------------------------------

describe("metrics", () => {
  const now = Date.parse("2026-11-04T12:00:00Z")
  const H = 3_600_000

  test("recorded locally, read back", () => {
    Log.record({ k: "auto", at: now, id: "a", what: "x" })
    expect(Log.read().some((e) => e.k === "auto" && e.id === "a")).toBe(true)
    expect(Log.file().startsWith(process.env.CROSSTALK_HOME!)).toBe(true)
  })

  test("tokens to the first edit, each API message once", () => {
    const lines = [
      { type: "user", message: { content: "do it" } },
      { type: "assistant", message: { id: "m1", usage: { input_tokens: 100, cache_read_input_tokens: 1000, output_tokens: 10 }, content: [{ type: "text" }] } },
      { type: "assistant", message: { id: "m1", usage: { input_tokens: 100, cache_read_input_tokens: 1000, output_tokens: 10 }, content: [{ type: "tool_use", name: "Read" }] } },
      { type: "assistant", message: { id: "m2", usage: { input_tokens: 50, cache_creation_input_tokens: 200, output_tokens: 20 }, content: [{ type: "tool_use", name: "Edit" }] } },
      { type: "assistant", message: { id: "m3", usage: { input_tokens: 9999 }, content: [] } },
    ]
    expect(T.firstEdit(lines.map((l) => JSON.stringify(l)).join("\n"))).toEqual({ tokens: 1380, fresh: 380, turns: 2 })
    expect(T.firstEdit(JSON.stringify(lines[1]))).toBeNull()
  })

  test("computed from fixture events and threads", () => {
    const t = M.create({ name: "auth", repo: "r", by: "a", label: "ana", now: now - 5 * H })
    M.put(t, "features", "f", { name: "f", risk: "everyday", ship: { merged: { sha: "x", at: now - H, files: [], shas: [], how: "direct" } } }, "a")
    const open = M.create({ name: "billing", repo: "r", by: "a", label: "ana", now: now - H })
    const events: import("../src/metrics/log.ts").Event[] = [
      { k: "asked", at: now - 4 * H, id: "q1", kind: "ship", thread: "auth" },
      { k: "answered", at: now - 4 * H, id: "q1", kind: "ship", openMs: 3 * 60_000, thread: "auth" },
      { k: "answered", at: now - 3 * H, id: "q2", kind: "ship", openMs: 10 * H, thread: "auth" },
      { k: "asked", at: now - 3 * H, id: "q2", kind: "ship", thread: "auth" },
      { k: "auto", at: now - 2 * H, id: "q3", what: "a route" },
      { k: "auto", at: now - 2 * H, id: "q4", what: "a route" },
      { k: "prompt", at: now - 4 * H, sid: "s1", chars: 400, threads: ["auth"] },
      { k: "prompt", at: now - 30 * 24 * H, sid: "s1", chars: 400, threads: ["auth"] },
      { k: "session", at: now - 5 * H, sid: "s1", brief: true },
      { k: "session", at: now - 5 * H, sid: "s2", brief: false },
      { k: "session", at: now - 5 * H, sid: "s3", brief: false },
    ]
    const tok: Record<string, { tokens: number; fresh: number; turns: number }> = { s1: { tokens: 40_000, fresh: 4000, turns: 3 }, s2: { tokens: 90_000, fresh: 9000, turns: 8 }, s3: { tokens: 110_000, fresh: 11_000, turns: 9 } }
    const s = Stats.compute({ events, threads: [t, open], now, weeks: 2, firstEdit: (sid) => tok[sid] ?? null })
    const auth = s.threads.find((x) => x.name === "auth")!
    expect(auth.ideaToMergeMs).toBe(4 * H)
    // 3 min open + 15 min (capped) + 400 chars of typing at 200 a minute.
    expect(auth.humanMin).toBe(20)
    expect(s.threads.find((x) => x.name === "billing")!.mergedAt).toBeUndefined()
    expect(s.merged).toBe(1)
    const w = s.weeks[s.weeks.length - 1]
    expect(w).toMatchObject({ week: "2026-11-02", asked: 2, answered: 2, auto: 2, merged: 1 })
    expect(s.tokens.withBrief).toEqual({ n: 1, median: 40_000, medianFresh: 4000 })
    expect(s.tokens.without).toEqual({ n: 2, median: 100_000, medianFresh: 10_000 })
    expect(Stats.tokenLine(s)).toBe("Tokens to the first edit: 40k with a thread brief (median, n=1), 100k without (n=2); new to the model, without cache reads: 4k vs 10k.")
    expect(Stats.weeklyLine(s)).toContain("1 thread merged (median 4 h from first edit)")
    expect(Stats.weeklyLine(s)).toContain("(2 of 4 answered by standing rules)")
    expect(Stats.render(s)).toContain("never sent anywhere")
  })
})

// --- threads across repos ---------------------------------------------------------------

describe("threads across repos", () => {
  test("dependencies from every manifest, and paths followed to their remote", () => {
    const lib = repo(path.join(TMP, "x-lib"), "git@github.com:acme/lib.git")
    const app = repo(path.join(TMP, "x-app"), "https://github.com/acme/app.git")
    fs.writeFileSync(
      path.join(app, "package.json"),
      JSON.stringify({ dependencies: { lib: "github:acme/lib#v2", ui: "git+https://github.com/acme/ui.git", short: "acme/short", left: "^1.0.0", local: "file:../x-lib" } }),
    )
    fs.writeFileSync(path.join(app, "go.mod"), "module github.com/acme/app\n\nrequire (\n\tgithub.com/acme/gokit/v2 v2.1.0\n\tgolang.org/x/net v0.1.0\n)\n")
    fs.writeFileSync(path.join(app, "Cargo.toml"), '[dependencies]\nrs = { git = "https://gitlab.com/acme/rs" }\n')
    fs.writeFileSync(path.join(app, "pyproject.toml"), 'dependencies = ["py @ git+https://github.com/acme/py.git@main"]\n')
    fs.mkdirSync(path.join(app, ".crosstalk"))
    fs.writeFileSync(path.join(app, ".crosstalk", "depends"), "# listed by hand\ngithub.com/acme/listed\n")
    const deps = X.dependencies(app).map((d) => d.repo).sort()
    expect(deps).toEqual(["github.com/acme/gokit", "github.com/acme/lib", "github.com/acme/listed", "github.com/acme/py", "github.com/acme/short", "github.com/acme/ui", "gitlab.com/acme/rs"])
    expect(X.dependencies(lib)).toEqual([])
  })

  test("the public surface: exports, their sources, and .crosstalk/surface", () => {
    const lib = path.join(TMP, "x-lib")
    fs.writeFileSync(path.join(lib, "package.json"), JSON.stringify({ main: "dist/index.js", exports: { ".": "./dist/index.js", "./client": { import: "./dist/client.mjs" } } }))
    fs.mkdirSync(path.join(lib, ".crosstalk"), { recursive: true })
    fs.writeFileSync(path.join(lib, ".crosstalk", "surface"), "proto/**\napi.md\n")
    const s = X.surface(lib)
    for (const f of ["dist/index.js", "src/index.ts", "src/client.ts", "proto/v1/a.proto", "api.md"]) expect([f, s(f)]).toEqual([f, true])
    for (const f of ["src/internal/x.ts", "test/a.ts", "README"]) expect([f, s(f)]).toEqual([f, false])
  })

  test("a dependent repo's thread gets a heads-up when the library's surface changes", () => {
    const lib = path.join(TMP, "x-lib")
    const app = path.join(TMP, "x-app")
    const libT = M.create({ name: "lib-v2", repo: "github.com/acme/lib", by: "me", label: "ana" })
    const appT = M.create({ name: "app-auth", repo: "github.com/acme/app", by: "me", label: "ana" })
    M.put(appT, "people", "ben-fp", { label: "ben" }, "me")
    const otherT = M.create({ name: "unrelated", repo: "github.com/acme/other", by: "me", label: "ana" })
    const relayed: any[] = []
    const x = new X.CrossRepo({
      me: "me",
      label: "ana",
      threads: {
        all: () => [libT, appT, otherT],
        idsFor: (sid) => (sid === "lib-session" ? [libT.id] : []),
        thread: (id) => [libT, appT, otherT].find((t) => t.id === id),
        sessionsIn: (ids) => (ids.includes(appT.id) ? ["app-session"] : []),
        roots: () => ({ "github.com/acme/lib": lib, "github.com/acme/app": app }),
      },
      peers: () => ({ ben: { label: "ben", fingerprint: "ben-fp" } }),
      relay: (o) => relayed.push(o),
      log: () => {},
      rateMs: 60_000,
    })
    expect(x.edited({ sessionId: "lib-session", name: "lib", repo: "github.com/acme/lib", root: lib, file: "README", diff: "x" })).toEqual([])
    expect(x.edited({ sessionId: "lib-session", name: "lib", repo: "github.com/acme/lib", root: lib, file: "src/index.ts", diff: "-old\n+new" })).toEqual(["app-auth"])
    expect(relayed.length).toBe(1)
    expect(relayed[0]).toMatchObject({ thread: appT.id, local: ["app-session"], labels: ["ben"], diff: { content: "-old\n+new" } })
    expect(relayed[0].text).toContain("part of acme/lib's public surface, which acme/app depends on (package.json lib)")
    // Coalesced: the next edit within the window waits.
    x.edited({ sessionId: "lib-session", name: "lib", repo: "github.com/acme/lib", root: lib, file: "src/index.ts", diff: "again" })
    expect(relayed.length).toBe(1)
  })
})
