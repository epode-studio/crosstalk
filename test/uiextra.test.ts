// The UI that needs nothing remembered (src/ui-extra/): pickers within
// $.ui.ask's four options, @ shortcuts, the thread pane, bots, muting, the
// editor, the digest and standup, PR text, the doctor at SessionStart, and
// the words of an invite.
//
//   bun test test/uiextra.test.ts
//
// Over a real relay and daemons: test/uiextra.sh. The mod itself: test/mod.sh.

import { describe, expect, test } from "bun:test"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"

const HOME = fs.mkdtempSync(path.join(os.tmpdir(), "ct-uiextra-unit-"))
process.env.CROSSTALK_HOME = HOME
const pure = await import("../src/ui-extra/pure.ts")
const M = await import("../src/threads/model.ts")
const ui = await import("../src/uistate.ts")
const { paneModel } = await import("../src/ui-extra/pane.ts")
const bots = await import("../src/ui-extra/bots.ts")
const mute = await import("../src/ui-extra/mute.ts")
const open = await import("../src/ui-extra/open.ts")
const D = await import("../src/ui-extra/digest.ts")
const { prBody } = await import("../src/ui-extra/prbody.ts")
const doctor = await import("../src/ui-extra/doctor.ts")
const people = await import("../src/ui-extra/people.ts")
const config = await import("../src/config.ts")
const crypto = await import("../src/crypto.ts")
const spawn = await import("../src/spawn.ts")
const restore = await import("../src/restore.ts")
const gather = await import("../src/gather.ts")

const T0 = Date.parse("2026-11-02T12:00:00Z")
const PAUL = "aaaa-aaaa-aaaa-aaaa"
const MARIE = "bbbb-bbbb-bbbb-bbbb"

/** The auth thread of the design doc, with a merged risky feature and its evidence. */
function authThread(o: { public?: boolean } = {}) {
  const t = M.create({ id: "0123456789abcdef", name: "auth", repo: "github.com/acme/api", by: PAUL, label: "paul", now: T0 - 3 * 86400_000, public: o.public })
  M.put(t, "people", MARIE, { label: "marie" }, PAUL, T0)
  M.setRecap(t, PAUL, "Moving tokens to v2 format; v1 kept for one release.", T0)
  M.put(t, "notes", "d1", { kind: "decision", text: "v1 tokens accepted until 0.2", who: "paul", at: T0 - 3600_000 }, PAUL, T0)
  M.put(t, "questions", "q1", { text: "keep the v1 endpoint?", blocking: true, who: "marie", at: T0 - 7200_000 }, MARIE, T0)
  M.put(t, "questions", "q2", { text: "rename the cookie?", who: "marie", at: T0 - 1800_000, answer: "yes, xt_session", answeredBy: "paul" }, PAUL, T0)
  M.put(
    t,
    "features",
    "v2-token-format",
    {
      name: "v2 token format",
      risk: "risky",
      flag: "auth-v2-tokens",
      ship: {
        state: "merged",
        stage: "internal",
        why: "touches src/auth/**",
        merged: { sha: "abc", at: T0 - 600_000, files: ["src/auth/token.ts"], shas: ["abc"], how: "pr", pr: "https://github.com/acme/api/pull/7" },
        evidence: [{ summary: "Old tokens still log in; new ones carry the tenant", tests: ["token.test.ts: v1 and v2 both verify"], stage: "merge", who: "paul", at: T0 - 900_000 }],
        signoff: [{ by: "r", kind: "adversarial", client: "codex", round: 1, at: T0 - 800_000 }],
      },
    },
    PAUL,
    T0,
  )
  M.put(t, "features", "tidy", { name: "tidy token parser", risk: "everyday" }, MARIE, T0)
  M.put(t, "notes", "k1", { kind: "task", text: "Find and fix the cause of the incident \"login 500s\" (sentry)", who: "crosstalk", at: T0 - 300_000, state: "open" }, PAUL, T0)
  M.put(t, "notes", "k2", { kind: "task", text: "write the migration note", who: "marie", at: T0 - 200_000, state: "done", doneBy: "marie" }, MARIE, T0)
  return t
}

const st = (threads: ReturnType<typeof authThread>[]) => ({ threads: Object.fromEntries(threads.map((t) => [t.id, t])), placed: {}, roots: {} })

describe("pickers stay within four options", () => {
  test("a card: Hand to agent / Reply / Open thread / More…", () => {
    expect(pure.cardOptions("message")).toEqual(["Hand to agent", "Reply", "Open thread", "More…"])
    expect(pure.cardOptions("ask")).toEqual(["Answer", "Hand to agent", "Open thread", "More…"])
    for (const k of ["message", "ask"]) expect(pure.cardOptions(k).length).toBeLessThanOrEqual(pure.MAX_OPTIONS)
  })
  test("More… opens Mute / Later", () => {
    expect([...pure.MORE_OPTIONS]).toEqual(["Mute", "Later"])
  })
})

describe("@ shortcuts", () => {
  test("parsed", () => {
    expect(pure.parseAt("@main")).toEqual({ kind: "main", on: true })
    expect(pure.parseAt("@main off")).toEqual({ kind: "main", on: false })
    expect(pure.parseAt("@restore")).toEqual({ kind: "restore", want: "yes" })
    expect(pure.parseAt("@restore windows")).toEqual({ kind: "restore", want: "windows" })
    expect(pure.parseAt("@Auth keep v1 for now")).toEqual({ kind: "name", name: "auth", text: "keep v1 for now" })
    expect(pure.parseAt("@auth")).toBeNull()
    expect(pure.parseAt("@src/auth.ts explain")).toBeNull()
    expect(pure.parseAt("hello @auth")).toBeNull()
  })
  test("taken only for a name crosstalk knows", () => {
    expect(pure.takesAt(pure.parseAt("@auth y"), ["auth"])).toBe(true)
    expect(pure.takesAt(pure.parseAt("@README.md explain this"), ["auth"])).toBe(false)
    expect(pure.takesAt(pure.parseAt("@main"), [])).toBe(true)
  })
  test("a short answer picks an option", () => {
    const o = ["Merge it", "Not yet"]
    expect(pure.matchOption("y", o)).toBe("Merge it")
    expect(pure.matchOption("n", o)).toBe("Not yet")
    expect(pure.matchOption("merge", o)).toBe("Merge it")
    expect(pure.matchOption("NOT YET", o)).toBe("Not yet")
    expect(pure.matchOption("maybe", o)).toBeUndefined()
  })
})

describe("the thread pane", () => {
  test("status, people, waiting, notes, recent, features with risk and flag stage", () => {
    const items: Record<string, any> = {
      "msg:1": { id: "msg:1", kind: "message", sessionId: "s", state: "handed", createdAt: T0, updatedAt: T0, from: "marie", thread: "auth", text: "token format changed to v2", ts: T0 - 120_000 },
      "msg:2": { id: "msg:2", kind: "ask", sessionId: "s", state: "pending", createdAt: T0, updatedAt: T0, from: "jo", thread: "auth", text: "can billing read v2 yet?", ts: T0 - 60_000 },
      "msg:3": { id: "msg:3", kind: "message", sessionId: "s", state: "pending", createdAt: T0, updatedAt: T0, from: "jo", thread: "billing", text: "elsewhere", ts: T0 },
    }
    const p = paneModel(authThread(), items)
    expect(p.thread).toBe("auth")
    expect(p.status).toBe("active")
    expect(p.people).toEqual(["paul", "marie"])
    expect(p.waiting[0]).toBe("keep the v1 endpoint? (blocking)")
    expect(p.waiting).toContain("jo asks: can billing read v2 yet?")
    expect(p.notes?.find((n) => n.kind === "decision")?.text).toBe("v1 tokens accepted until 0.2")
    expect(p.recent.map((r) => r.from)).toEqual(["jo", "marie"])
    expect(p.recent.some((r) => r.text === "elsewhere")).toBe(false)
    const f = p.features.find((x) => x.name === "v2 token format")!
    expect(pure.featureLine(f)).toBe("v2 token format · risky · flag auth-v2-tokens at internal · merged")
    expect(pure.paneLines(p, T0).join("\n")).toContain(" decision · v1 tokens accepted until 0.2 (paul, 1h)")
  })
})

describe("bots", () => {
  const botFp = "cccc-cccc-cccc-cccc"
  config.savePeers({
    robo: { label: "robo", edPub: "x", xPub: "y", fingerprint: botFp, joinedAt: 1, isMachine: true },
    marie: { label: "marie", edPub: "x", xPub: "y", fingerprint: MARIE, joinedAt: 1 },
  })
  test("an agent is a bot, a person is not", () => {
    expect(bots.isBot("robo")).toBe(true)
    expect(bots.isBot("robo/api")).toBe(true)
    expect(bots.isBot("marie")).toBe(false)
    expect(bots.refuseBot(undefined, "x")).toBeNull()
    expect(bots.refuseBot("marie", "x")).toBeNull()
    expect(bots.refuseBot("robo", "start an agent")).toContain("robo is an agent")
  })
  test("never starts, resumes or restarts a session for a bot", () => {
    const s = spawn.spawnAgents({ task: "fix it", cwd: HOME, peer: "robo" })
    expect(s.ok).toBe(false)
    expect(s.text).toContain("robo is an agent")
    const r = restore.restore({ self: "s1", userAction: false, peer: "robo" })
    expect(r.ok).toBe(false)
    expect(r.text).toContain("never resume a session")
    const g = gather.start({ self: "s1", peer: "robo" })
    expect(g.ok).toBe(false)
    expect(g.text).toContain("robo is an agent")
  })
  test("a bot's answers in a thread are not taken; its questions are", () => {
    const known = authThread()
    const inc = structuredClone(known)
    M.put(inc, "questions", "q1", { ...known.questions.q1, answer: "drop v1 now", answeredBy: "robo" }, botFp, T0 + 1)
    M.put(inc, "questions", "q9", { text: "should I page someone?", who: "robo", at: T0, answer: "yes", answeredBy: "robo" }, botFp, T0 + 1)
    const safe = bots.botSafe("robo", inc, { [known.id]: known })!
    const merged = M.merge(known, safe)
    expect(merged.questions.q1.answer).toBeUndefined()
    expect(merged.questions.q9.text).toBe("should I page someone?")
    expect(merged.questions.q9.answer).toBeUndefined()
    // A person's frame is merged as it came.
    expect(bots.botSafe("marie", inc, { [known.id]: known })).toBe(inc)
  })
  test("never raised above notify", async () => {
    const r = await people.trustTool({ who: "robo", level: "ask" })
    expect(r.ok).toBe(false)
    expect(r.text).toContain("never above")
    expect((await people.trustTool({ who: "robo", level: "notify" })).ok).toBe(true)
    expect((await people.trustTool({ who: "marie", level: "ask" })).ok).toBe(true)
    const trust = await import("../src/trust.ts")
    expect(trust.load().people.robo).toBe("notify")
  })
})

describe("muting", () => {
  test("for, in plain words", () => {
    expect(mute.parseFor(undefined)).toBe(mute.DEFAULT_MS)
    expect(mute.parseFor("30m")).toBe(30 * 60_000)
    expect(mute.parseFor("2h")).toBe(2 * 3600_000)
    expect(mute.parseFor("an hour")).toBe(3600_000)
    expect(mute.parseFor("a day")).toBe(86400_000)
    expect(mute.parseFor(0)).toBe(0)
    expect(mute.parseFor("forever")!).toBeGreaterThan(365 * 86400_000)
    expect(mute.parseFor("whenever")).toBeNull()
  })
  test("a muted thread holds its messages, and its cards go", () => {
    const t = authThread()
    ui.withStore((items, now) => {
      ui.upsert(items, { id: "msg:m1", kind: "message", sessionId: "s1", from: "marie", thread: "auth", text: "hi" }, now)
      ui.upsert(items, { id: "msg:m2", kind: "message", sessionId: "s1", from: "jo", thread: "billing", text: "hi" }, now)
    })
    mute.muteThread(t, 3600_000)
    expect(ui.snapshot()["msg:m1"].state).toBe("muted")
    expect(ui.snapshot()["msg:m2"].state).toBe("pending")
    expect(mute.threadMuted({ threads: [t.id] })).toBe(true)
    expect(mute.threadMuted({ thread: "auth" })).toBe(true)
    expect(mute.threadMuted({ thread: "billing" })).toBe(false)
    mute.muteThread(t, 0)
    expect(mute.threadMuted({ thread: "auth" })).toBe(false)
  })
})

describe("open in editor", () => {
  const bin = fs.mkdtempSync(path.join(os.tmpdir(), "ct-editor-"))
  for (const c of ["zed", "vim"]) {
    fs.writeFileSync(path.join(bin, c), "#!/bin/sh\n", { mode: 0o755 })
  }
  const env = { PATH: bin }
  test("$VISUAL when it opens a window, else the first editor installed", () => {
    expect(open.chooseEditor("/w", { env: { ...env, VISUAL: "zed" }, platform: "linux" })).toEqual({ cmd: path.join(bin, "zed"), args: ["/w"], name: "zed" })
    expect(open.chooseEditor("/w", { env: { ...env, EDITOR: "vim" }, platform: "linux" })).toMatchObject({ name: "zed" })
    expect(open.chooseEditor("/w", { env: { PATH: "" }, platform: "linux" })).toBeNull()
    expect(open.chooseEditor("/w", { env: { PATH: "", EDITOR: "vim" }, platform: "linux" })).toEqual({ terminal: "vim" })
  })
  test("macOS falls back to open -a", () => {
    expect(open.chooseEditor("/w", { env: { PATH: "" }, platform: "darwin", exists: (p) => p === "/Applications/Cursor.app" })).toEqual({ cmd: "open", args: ["-a", "Cursor", "/w"], name: "Cursor" })
    expect(open.chooseEditor("/w", { env: { PATH: "" }, editor: "Sublime Text", platform: "darwin" })).toMatchObject({ cmd: "open", args: ["-a", "Sublime Text", "/w"] })
  })
  test("a thread's session's folder, else its repo's clone", () => {
    const sessions = [{ name: "api", cwd: "/w/api", threads: ["auth"] }]
    const threadRepo = (n: string) => (n === "auth" || n === "billing" ? { name: n, repo: "github.com/acme/api" } : undefined)
    expect(open.findWorktree({ thread: "auth" }, { sessions, roots: {}, threadRepo })).toMatchObject({ dir: "/w/api" })
    expect(open.findWorktree({ thread: "billing" }, { sessions, roots: { "github.com/acme/api": "/w/main" }, threadRepo })).toMatchObject({ dir: "/w/main" })
    expect(open.findWorktree({ session: "api" }, { sessions, roots: {} })).toMatchObject({ dir: "/w/api" })
    expect("error" in open.findWorktree({ thread: "nope" }, { sessions, roots: {}, threadRepo })).toBe(true)
  })
})

describe("digest and standup", () => {
  const rules = ['answered marie\'s question "which tenant column?" with "tenant_id", by the standing rule (ask about the tenant column: "tenant_id").']
  test("the digest, in plain language", () => {
    const d = D.digest({ since: T0 - 86400_000, now: T0, st: st([authThread()]), rules })
    expect(d.text).toContain("auth")
    expect(d.text).toContain("paul decided v1 tokens accepted until 0.2")
    expect(d.text).toContain("merged v2 token format (behind auth-v2-tokens), https://github.com/acme/api/pull/7")
    expect(d.text).toContain('paul answered "rename the cookie?": yes, xt_session')
    expect(d.text).toContain('an incident: Find and fix the cause of the incident "login 500s"')
    expect(d.text).toContain("Answered by standing rules")
    expect(d.text).toContain("tenant_id")
    expect(D.digest({ since: T0, now: T0 + 1000, st: st([authThread()]), rules: [] }).text).toContain("Nothing happened")
  })
  test("the band's line: counts, never anyone's words, at most every two hours", () => {
    const s = st([authThread()])
    const line = D.bandForSession("s1", { now: T0, st: s, rules })!
    expect(line).toContain("1 decision")
    expect(line).toContain("1 merge")
    expect(line).toContain("1 answered by a rule")
    expect(line).toContain("1 incident")
    expect(line).not.toContain("v1 tokens")
    expect(D.bandForSession("s1", { now: T0 + 3600_000, st: s, rules })).toBeNull()
    expect(D.bandForSession("s1", { now: T0 + 3 * 3600_000, st: s, rules: [] })).toBeNull()
  })
  test("standup: what each person shipped, finished and decided", () => {
    const s = D.standup({ now: T0, st: st([authThread()]) })
    expect(s.text).toContain("paul")
    expect(s.text).toContain("shipped: v2 token format")
    expect(s.text).toContain("decided: v1 tokens accepted until 0.2 (auth)")
    expect(s.text).toContain("marie")
    expect(s.text).toContain("finished: write the migration note (auth)")
    expect(D.standup({ who: "marie", now: T0, st: st([authThread()]) }).text).not.toContain("decided")
  })
  test("since, in plain words", () => {
    expect(D.parseSince("6h", T0)).toBe(T0 - 6 * 3600_000)
    expect(D.parseSince("yesterday", T0)).toBe(T0 - 86400_000)
    expect(D.parseSince("monday", T0)).toBeLessThan(T0)
    expect(D.parseSince("2026-11-01", T0)).toBe(Date.parse("2026-11-01"))
    expect(D.parseSince("whenever", T0)).toBeUndefined()
  })
})

describe("PR text", () => {
  test("a public thread gives the PR its recap, decisions, evidence and open questions", () => {
    const t = authThread({ public: true })
    const body = prBody(t, t.features["v2-token-format"])
    expect(body).toContain("## Recap")
    expect(body).toContain("Moving tokens to v2 format")
    expect(body).toContain("## Decisions")
    expect(body).toContain("paul · v1 tokens accepted until 0.2")
    expect(body).toContain("## Evidence")
    expect(body).toContain("Old tokens still log in")
    expect(body).toContain("test: token.test.ts")
    expect(body).toContain("## Open questions")
    expect(body).toContain("keep the v1 endpoint? **(blocking)**")
    expect(body).not.toContain("rename the cookie")
    expect(body).toContain("Reviewed by adversarial (codex)")
    expect(body).toContain("`auth-v2-tokens`")
  })
  test("a sealed thread keeps its recap and decisions out of a PR", () => {
    const t = authThread()
    const body = prBody(t, t.features["v2-token-format"])
    expect(body).not.toContain("Moving tokens")
    expect(body).not.toContain("v1 tokens accepted")
    expect(body).toContain("## Evidence")
    expect(body).toContain("sealed to its people")
  })
})

describe("the doctor at SessionStart", () => {
  test("says nothing when all is well, and something broken once, with the fix", async () => {
    fs.rmSync(path.join(HOME, "doctor-check.json"), { force: true })
    config.saveIdentity(crypto.newIdentity("paul"))
    const quiet = await doctor.atSessionStart({ sessionId: "s1", env: {}, now: T0, mod: false, relayUp: async () => true })
    expect(quiet.ran).toBe(true)
    expect(quiet.systemMessage).toBeUndefined()
    fs.rmSync(path.join(HOME, "doctor-check.json"), { force: true })
    const broken = await doctor.atSessionStart({ sessionId: "s1", env: {}, now: T0, mod: false, relayUp: async () => false })
    expect(broken.problems.map((p) => p.key)).toEqual(["relay"])
    expect(broken.systemMessage).toContain("the relay")
    expect(broken.systemMessage).toContain("To fix it:")
    const again = await doctor.atSessionStart({ sessionId: "s2", env: {}, now: T0 + 3600_000, mod: false, relayUp: async () => false })
    expect(again.ran).toBe(false)
    expect(again.systemMessage).toBeUndefined()
  })
  test("with the mod, it is a picker, and Ask the agent hands over the fix", async () => {
    fs.rmSync(path.join(HOME, "doctor-check.json"), { force: true })
    const r = await doctor.atSessionStart({ sessionId: "s3", env: { CLAUDE_CODE_MESSAGING_SOCKET: path.join(HOME, "no-such.sock") }, now: T0, mod: true, relayUp: async () => true })
    expect(r.systemMessage).toBeUndefined()
    const it = Object.values(ui.snapshot()).find((i) => i.kind === "doctor" && i.sessionId === "s3")!
    expect(it.question).toContain("inbox socket")
    expect(it.options).toEqual([doctor.FIX_IT, doctor.NOT_NOW])
    const a: any = doctor.act(it.id, "answer", doctor.FIX_IT)
    expect(a.prompt).toContain("Help me fix it")
    expect(ui.snapshot()[it.id].state).toBe("answered")
  })
})

describe("invite words", () => {
  test("read from what the person typed, and never repeated", () => {
    expect(people.wordsFrom("marie gave me words: 3644 cherry horn cataract redwing")).toBe("3644-cherry-horn-cataract-redwing")
    expect(people.wordsFrom("3644-cherry-horn-cataract-redwing at 10.0.0.2:8787")).toBe("3644-cherry-horn-cataract-redwing at 10.0.0.2:8787")
    expect(people.wordsFrom("no words here")).toBeUndefined()
    expect(people.scrub("joined with 3644-cherry-horn-cataract-redwing ok", "3644-cherry-horn-cataract-redwing")).toBe("joined with [the words] ok")
    expect(people.scrub("phrase cherry-horn-cataract-redwing", "3644-cherry-horn-cataract-redwing")).toBe("phrase [the words]")
  })
})
