// Shipping: risk, reviewers, evidence, merging, flags and their providers,
// incidents, and the engine that runs them.
//
//   bun test test/shipping.test.ts
//
// Providers run against local mock servers; git is real, in temp repos. The
// whole thing through a daemon, with stub reviewers, is test/shipping.sh.

import { afterAll, describe, expect, test } from "bun:test"
import { spawnSync } from "node:child_process"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), "ct-ship-"))
process.env.CROSSTALK_HOME = path.join(TMP, "home")
process.env.GIT_AUTHOR_NAME = process.env.GIT_COMMITTER_NAME = "t"
process.env.GIT_AUTHOR_EMAIL = process.env.GIT_COMMITTER_EMAIL = "t@t"
afterAll(() => fs.rmSync(TMP, { recursive: true, force: true }))

const Risk = await import("../src/shipping/risk.ts")
const C = await import("../src/shipping/config.ts")
const E = await import("../src/shipping/evidence.ts")
const F = await import("../src/shipping/flags.ts")
const Mg = await import("../src/shipping/merge.ts")
const G = await import("../src/shipping/git.ts")
const Rv = await import("../src/shipping/reviewer.ts")
const I = await import("../src/shipping/incident.ts")
const { LaunchDarkly } = await import("../src/shipping/providers/launchdarkly.ts")
const { PostHog } = await import("../src/shipping/providers/posthog.ts")
const { providerFor, FileFlags, NotConfigured } = await import("../src/shipping/providers/index.ts")
const M = await import("../src/threads/model.ts")
const { ShipEngine } = await import("../src/shipping/engine.ts")
type ThreadPort = import("../src/shipping/engine.ts").ThreadPort
type Question = import("../src/shipping/engine.ts").Question

const sh = (cwd: string, ...args: string[]) => {
  const r = spawnSync("git", ["-C", cwd, ...args], { encoding: "utf8" })
  if (r.status !== 0) throw new Error(`git ${args.join(" ")}: ${r.stderr}`)
  return r.stdout.trim()
}
let n = 0
/** A repo with a bare remote, `main` pushed. */
function repo(files: Record<string, string> = { "README.md": "hi\n" }) {
  const dir = path.join(TMP, `r${++n}`)
  const bare = `${dir}.git`
  spawnSync("git", ["init", "-q", "--bare", "-b", "main", bare])
  spawnSync("git", ["clone", "-q", bare, dir])
  sh(dir, "checkout", "-q", "-b", "main")
  for (const [f, c] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(dir, f)), { recursive: true })
    fs.writeFileSync(path.join(dir, f), c)
  }
  sh(dir, "add", "-A")
  sh(dir, "commit", "-qm", "init")
  sh(dir, "push", "-q", "-u", "origin", "main")
  sh(dir, "remote", "set-head", "origin", "main")
  return { dir, bare }
}
function commitOn(dir: string, branch: string, file: string, content: string, base = "main") {
  const wt = path.join(TMP, `wt${++n}`)
  sh(dir, "worktree", "add", "-q", "-b", branch, wt, base)
  fs.mkdirSync(path.dirname(path.join(wt, file)), { recursive: true })
  fs.writeFileSync(path.join(wt, file), content)
  sh(wt, "add", "-A")
  sh(wt, "commit", "-qm", `change ${file}`)
  return wt
}

// --- risk ------------------------------------------------------------------------------

describe("risk", () => {
  const rules = Risk.parseRisk(`# risky paths
high: src/auth/** migrations/**
risky: *.tf
everyday: src/auth/**/*.test.ts
high:
  - billing/
`)
  test("the file is read: high and risky lines, continuations, exceptions", () => {
    expect(rules.high).toEqual(["src/auth/**", "migrations/**", "*.tf", "billing/"])
    expect(rules.everyday).toEqual(["src/auth/**/*.test.ts"])
  })
  test("globs: ** across folders, * within one, bare names at any depth, trailing slash", () => {
    expect(Risk.matches("src/auth/**", "src/auth/login.ts")).toBe(true)
    expect(Risk.matches("src/auth/**", "src/auth/deep/x.ts")).toBe(true)
    expect(Risk.matches("src/auth/**", "src/authz/x.ts")).toBe(false)
    expect(Risk.matches("*.tf", "infra/prod/main.tf")).toBe(true)
    expect(Risk.matches("src/*.ts", "src/a/b.ts")).toBe(false)
    expect(Risk.matches("billing/", "billing/charge.ts")).toBe(true)
    expect(Risk.matches("src/**/x.ts", "src/x.ts")).toBe(true)
  })
  test("a change touching a listed path is risky, says why; exceptions do not count", () => {
    expect(Risk.assess(["README.md", "src/ui/a.ts"], rules)).toEqual({ risk: "everyday" })
    const a = Risk.assess(["src/auth/login.ts"], rules)
    expect(a.risk).toBe("risky")
    expect(a.why).toContain("src/auth/login.ts")
    expect(a.why).toContain("src/auth/**")
    expect(Risk.assess(["src/auth/login.test.ts"], rules).risk).toBe("everyday")
  })
  test("the ratchet: up freely, down only through a person", () => {
    expect(Risk.ratchet("everyday", "risky")).toEqual({ risk: "risky", changed: true })
    expect(Risk.ratchet("risky", "everyday")).toEqual({ risk: "risky", changed: false, ask: true })
    expect(Risk.ratchet("risky", "everyday", { byPerson: true })).toEqual({ risk: "everyday", changed: true })
    expect(Risk.ratchet(undefined, "everyday")).toEqual({ risk: "everyday", changed: false })
    expect(Risk.higher("everyday", "risky")).toBe("risky")
  })
})

// --- config -------------------------------------------------------------------------------

describe("ship config and the test command", () => {
  test("parsed with defaults", () => {
    const c = C.parseShip("test: make check  # ours\npush: direct\nrounds: 2\nramp: internal 25% on\nflags: posthog\nadversarial: claude\n")
    expect(c).toMatchObject({ test: "make check", push: "direct", rounds: 2, ramp: ["internal", "25%", "on"], flags: "posthog", adversarial: "claude" })
    const d = C.parseShip("")
    expect(d).toMatchObject({ rounds: 3, ramp: C.DEFAULT_RAMP, flags: "file", incidentDays: 14, adversarial: "auto" })
    expect(d.push).toBeUndefined()
    expect(C.parseShip("push: sideways\nflags: nope").push).toBeUndefined()
  })
  test("discovered: package.json by lockfile, make, pytest; npm's placeholder is no test", () => {
    const files: Record<string, string> = {}
    const ex = (p: string) => path.basename(p) in files
    const rd = (p: string) => {
      const b = path.basename(p)
      if (!(b in files)) throw new Error("no")
      return files[b]
    }
    expect(C.discoverTest("/r", ex, rd)).toBeUndefined()
    files["package.json"] = JSON.stringify({ scripts: { test: 'echo "Error: no test specified" && exit 1' } })
    expect(C.discoverTest("/r", ex, rd)).toBeUndefined()
    files["Makefile"] = "build:\n\ttrue\ntest:\n\ttrue\n"
    expect(C.discoverTest("/r", ex, rd)).toBe("make test")
    files["package.json"] = JSON.stringify({ scripts: { test: "vitest" } })
    expect(C.discoverTest("/r", ex, rd)).toBe("npm test")
    files["bun.lock"] = ""
    expect(C.discoverTest("/r", ex, rd)).toBe("bun run test")
    const py: Record<string, string> = { "pyproject.toml": "[tool.pytest.ini_options]\n" }
    expect(C.discoverTest("/r", (p) => path.basename(p) in py, (p) => py[path.basename(p)] ?? (() => { throw 0 })())).toBe("pytest -q")
  })
})

// --- evidence -------------------------------------------------------------------------------

describe("evidence", () => {
  test("plain language with proof is taken", () => {
    const r = E.validate({ summary: "Login now accepts passkeys; passwords still work.", tests: "login.test: 12 pass", before_after: [{ before: "password only", after: "passkey or password" }] }, { risky: true })
    expect(r.ok).toBe(true)
    if (r.ok) {
      expect(r.evidence.tests).toEqual(["login.test: 12 pass"])
      expect(r.evidence.stage).toBe("merge")
    }
  })
  test("a diff is refused, wherever it is", () => {
    const diff = "diff --git a/x b/x\n--- a/x\n+++ b/x\n@@ -1 +1 @@\n-old\n+new"
    expect(E.looksLikeDiff(diff)).toBe(true)
    expect(E.looksLikeDiff("+a\n+b\n-c\n+d\n+e")).toBe(true)
    expect(E.looksLikeDiff("- a bullet\n- another bullet\n- third\n- fourth")).toBe(false)
    expect(E.validate({ summary: diff }, { risky: false }).ok).toBe(false)
    const r = E.validate({ summary: "Changes login behaviour a lot", tests: [diff] }, { risky: true })
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.error).toContain("diff")
  })
  test("risky needs proof beyond the summary; no summary is never enough; screenshots must exist", () => {
    expect(E.validate({ summary: "It works better now, trust me." }, { risky: true }).ok).toBe(false)
    expect(E.validate({ summary: "It works better now, trust me." }, { risky: false }).ok).toBe(true)
    expect(E.validate({ tests: ["all pass"] }, { risky: false }).ok).toBe(false)
    const shot = path.join(TMP, "shot.png")
    fs.writeFileSync(shot, "png")
    expect(E.validate({ summary: "The new page renders correctly.", screenshots: ["shot.png"] }, { risky: true, base: TMP }).ok).toBe(true)
    expect(E.validate({ summary: "The new page renders correctly.", screenshots: ["gone.png"] }, { risky: true, base: TMP }).ok).toBe(false)
    expect(E.validate({ summary: "The new page renders correctly.", screenshots: ["https://x.test/a.png"] }, { risky: true }).ok).toBe(true)
  })
  test("described for a question, never as code", () => {
    const d = E.describe({ summary: "S is now faster.", tests: ["t1 pass"], evals: ["p95 120ms → 80ms"], stage: "merge", who: "a", at: 1 })
    expect(d).toContain("S is now faster.")
    expect(d).toContain("Tests: t1 pass")
    expect(d).toContain("Evals:")
    expect(E.describe(undefined)).toBe("no evidence attached")
  })
})

// --- flags ---------------------------------------------------------------------------------

describe("flags", () => {
  test("stages and the ramp", () => {
    expect(F.parseStage("OFF")).toBe("off")
    expect(F.parseStage("100%")).toBe("on")
    expect(F.parseStage(25)).toBe("25%")
    expect(F.parseStage("0")).toBe("off")
    expect(F.parseStage("sideways")).toBeUndefined()
    const ramp = ["internal", "10%", "50%", "on"]
    expect(F.nextStage("off", ramp)).toBe("internal")
    expect(F.nextStage("internal", ramp)).toBe("10%")
    expect(F.nextStage("25%", ramp)).toBe("50%")
    expect(F.nextStage("on", ramp)).toBeUndefined()
    expect(F.nextStage("internal", ["internal", "50%"])).toBe("50%")
    expect(F.nextStage("50%", ["internal", "50%"])).toBe("on")
    expect(F.isUp("10%", "internal")).toBe(false)
  })
  test("the simple form round-trips, comments kept, and a flag is set", () => {
    const text = "# our flags\nlogin-v2: internal\nnew-billing: 10%\nbad line\n"
    const f = F.parseFlags(text)
    expect(f.form).toBe("lines")
    expect(f.flags).toEqual({ "login-v2": "internal", "new-billing": "10%" })
    const out = F.setFlag(text, "login-v2", "50%")
    expect(out).toContain("# our flags")
    expect(F.parseFlags(out).flags["login-v2"]).toBe("50%")
    expect(F.setFlag(undefined, "x", "off")).toMatch(/^# Feature flags/)
  })
  test("the JSON form stays JSON", () => {
    const out = F.setFlag('{ "a": "on", "b": { "stage": "10%" } }', "c", "internal")
    expect(JSON.parse(out)).toEqual({ a: "on", b: "10%", c: "internal" })
  })
})

// --- merging ---------------------------------------------------------------------------------

describe("merge planning", () => {
  const base = { defaultBranch: "main", branch: "crosstalk/a", ahead: 2, behind: 0, landed: false, remote: "origin", gh: false }
  test("fast-forward or rebase, pushed only when direct", () => {
    expect(Mg.planMerge({ ...base, push: "direct" })).toMatchObject({ how: "ff", push: true })
    expect(Mg.planMerge({ ...base, behind: 3, push: "direct" })).toMatchObject({ how: "rebase", push: true })
    expect(Mg.planMerge({ ...base, push: "local" })).toMatchObject({ how: "ff", push: false })
    expect(Mg.planMerge({ ...base })).toMatchObject({ how: "ff", push: false })
  })
  test("a PR when not direct and gh is there, or when asked", () => {
    expect(Mg.planMerge({ ...base, gh: true }).how).toBe("pr")
    expect(Mg.planMerge({ ...base, push: "pr", gh: false }).how).toBe("refuse")
    expect(Mg.planMerge({ ...base, push: "pr", remote: undefined, gh: true }).how).toBe("refuse")
  })
  test("nothing to do, or nothing it may do", () => {
    expect(Mg.planMerge({ ...base, ahead: 0 }).how).toBe("nothing")
    expect(Mg.planMerge({ ...base, landed: true }).how).toBe("nothing")
    expect(Mg.planMerge({ ...base, branch: "main" }).how).toBe("refuse")
    expect(Mg.planMerge({ ...base, defaultBranch: undefined }).how).toBe("refuse")
  })
})

describe("merging, with real git", () => {
  test("fast-forward into a checked-out main, pushed to the remote", () => {
    const { dir, bare } = repo()
    commitOn(dir, "crosstalk/ff", "docs/a.md", "a\n")
    const tip = sh(dir, "rev-parse", "crosstalk/ff")
    const m = Mg.executeMerge(dir, "crosstalk/ff", { push: "direct", gh: false, scratchDir: path.join(TMP, "scratch") })
    expect(m).toMatchObject({ ok: true, how: "ff", sha: tip })
    expect(m.files).toEqual(["docs/a.md"])
    expect(sh(dir, "rev-parse", "main")).toBe(tip)
    expect(fs.readFileSync(path.join(dir, "docs/a.md"), "utf8")).toBe("a\n")
    expect(sh(bare, "rev-parse", "main")).toBe(tip)
  })
  test("rebased onto a main that moved, the branch itself untouched, and cleanup sees it landed", () => {
    const { dir } = repo()
    commitOn(dir, "crosstalk/rb", "b.txt", "b\n")
    const before = sh(dir, "rev-parse", "crosstalk/rb")
    fs.writeFileSync(path.join(dir, "other.txt"), "o\n")
    sh(dir, "add", "-A")
    sh(dir, "commit", "-qm", "main moved")
    const m = Mg.executeMerge(dir, "crosstalk/rb", { push: "local", gh: false, scratchDir: path.join(TMP, "scratch") })
    expect(m).toMatchObject({ ok: true, how: "rebase" })
    expect(sh(dir, "rev-parse", "crosstalk/rb")).toBe(before)
    expect(fs.existsSync(path.join(dir, "b.txt"))).toBe(true)
    expect(G.landed(dir, "main", "crosstalk/rb")).toBe(true)
  })
  test("a conflict is handed back, nothing moved", () => {
    const { dir } = repo({ "x.txt": "one\n" })
    commitOn(dir, "crosstalk/cf", "x.txt", "two\n")
    fs.writeFileSync(path.join(dir, "x.txt"), "three\n")
    sh(dir, "commit", "-qam", "main edits x")
    const main = sh(dir, "rev-parse", "main")
    const m = Mg.executeMerge(dir, "crosstalk/cf", { push: "local", gh: false, scratchDir: path.join(TMP, "scratch") })
    expect(m.ok).toBe(false)
    expect(m.conflict).toBe(true)
    expect(m.text).toContain("x.txt")
    expect(sh(dir, "rev-parse", "main")).toBe(main)
  })
  test("a PR through gh: pushed, created, set to auto-merge", () => {
    const { dir, bare } = repo()
    commitOn(dir, "crosstalk/pr", "p.txt", "p\n")
    const bin = path.join(TMP, "ghbin")
    fs.mkdirSync(bin, { recursive: true })
    const log = path.join(TMP, "gh.log")
    fs.writeFileSync(path.join(bin, "gh"), `#!/bin/sh\necho "$@" >>${log}\ncase "$1 $2" in "pr create") echo https://github.test/pr/1 ;; esac\n`, { mode: 0o755 })
    const old = process.env.PATH
    process.env.PATH = `${bin}:${old}`
    try {
      const m = Mg.executeMerge(dir, "crosstalk/pr", { gh: true, scratchDir: path.join(TMP, "scratch") })
      expect(m).toMatchObject({ ok: true, how: "pr", pr: "https://github.test/pr/1" })
    } finally {
      process.env.PATH = old
    }
    const calls = fs.readFileSync(log, "utf8")
    expect(calls).toContain("pr create --head crosstalk/pr --base main")
    expect(calls).toContain("pr merge crosstalk/pr --auto --rebase")
    expect(sh(bare, "rev-parse", "crosstalk/pr")).toBe(sh(dir, "rev-parse", "crosstalk/pr"))
    // main did not move: the PR merges it.
    expect(sh(dir, "rev-parse", "main")).toBe(sh(bare, "rev-parse", "main"))
  })
  test("a push that would need force is refused, never forced", () => {
    const { dir, bare } = repo()
    // Someone else pushed to main meanwhile, from another clone.
    const other = path.join(TMP, `o${++n}`)
    spawnSync("git", ["clone", "-q", bare, other])
    fs.writeFileSync(path.join(other, "theirs.txt"), "t\n")
    sh(other, "add", "-A")
    sh(other, "commit", "-qm", "theirs")
    sh(other, "push", "-q", "origin", "main")
    // And main here moved its own way.
    fs.writeFileSync(path.join(dir, "mine.txt"), "m\n")
    sh(dir, "add", "-A")
    sh(dir, "commit", "-qm", "mine")
    commitOn(dir, "crosstalk/np", "n.txt", "n\n")
    const theirs = sh(bare, "rev-parse", "main")
    const m = Mg.executeMerge(dir, "crosstalk/np", { push: "direct", gh: false, scratchDir: path.join(TMP, "scratch") })
    expect(m.ok).toBe(false)
    expect(m.text).toContain("both moved")
    expect(sh(bare, "rev-parse", "main")).toBe(theirs)
  })
  test("one file committed on main without touching the index, then fast-forwarded", () => {
    const { dir, bare } = repo()
    fs.writeFileSync(path.join(dir, "wip.txt"), "uncommitted\n")
    const r = Mg.commitToDefault(dir, F.FLAGS_FILE, "x: off\n", "flags: x off", { push: "direct" })
    expect(r.ok).toBe(true)
    expect(G.show(bare, "main", F.FLAGS_FILE)).toBe("x: off\n")
    expect(fs.readFileSync(path.join(dir, F.FLAGS_FILE), "utf8")).toBe("x: off\n")
    expect(fs.readFileSync(path.join(dir, "wip.txt"), "utf8")).toBe("uncommitted\n")
  })
})

// --- reviewers ---------------------------------------------------------------------------------

describe("reviewers", () => {
  const cfg = { adversarial: "auto" as const }
  test("everyday: one review by claude", () => {
    const r = Rv.choose({ risky: false, have: { claude: "/b/claude", codex: "/b/codex" }, cfg })
    expect(r.picks.map((p) => [p.kind, p.who.client])).toEqual([["review", "claude"]])
  })
  test("risky: adversarial on codex when installed, plus a security pass", () => {
    const r = Rv.choose({ risky: true, have: { claude: "/b/claude", codex: "/b/codex" }, cfg })
    expect(r.picks.map((p) => [p.kind, Rv.label(p.who)])).toEqual([["adversarial", "codex"], ["security", "claude"]])
  })
  test("risky without codex: claude on another model", () => {
    const r = Rv.choose({ risky: true, have: { claude: "/b/claude" }, cfg })
    expect(Rv.label(r.picks[0].who)).toBe("claude --model opus")
    expect(Rv.label(Rv.choose({ risky: true, have: { claude: "/b/claude" }, cfg, authorModel: "claude-opus-5" }).picks[0].who)).toBe("claude --model sonnet")
    expect(Rv.label(Rv.choose({ risky: true, have: { claude: "/b/claude", codex: "/b/codex" }, cfg: { adversarial: "claude", adversarialModel: "haiku" } }).picks[0].who)).toBe("claude --model haiku")
    expect(Rv.choose({ risky: true, have: {}, cfg }).error).toContain("neither")
  })
  test("the prompt carries the thread's intent as data, the range, earlier rounds and the verdict format", () => {
    const p = Rv.prompt({
      kind: "adversarial",
      run: "r123",
      thread: { name: "auth", recap: "Move to passkeys", decisions: ["keep passwords for now"], facts: [], questions: ["v1? → keep"] },
      feature: { name: "passkeys", risk: "risky", why: "touches src/auth/**", flag: "passkeys" },
      base: "main",
      branch: "crosstalk/pk",
      commits: ["abc add passkeys"],
      files: ["src/auth/pk.ts"],
      round: 2,
      previous: [{ findings: "no rate limit", response: "added one" }],
      cli: "crosstalk",
    })
    for (const s of ["adversarial", "Move to passkeys", "keep passwords for now", "<thread-data>", "git diff main...HEAD", "src/auth/pk.ts", "no rate limit", "added one", "VERDICT: approve", "FINDINGS:", "r123", "flag passkeys", "round 2", "Do not commit"]) expect(p).toContain(s)
    expect(Rv.prompt({ kind: "security", run: "r", thread: { name: "t", recap: "", decisions: [], facts: [], questions: [] }, feature: { name: "f", risk: "risky" }, base: "main", branch: "b", commits: [], files: [], round: 1, cli: "c" })).toContain("security")
  })
  test("verdicts: the last one counts; none is changes, never a sign-off", () => {
    expect(Rv.parseVerdict("looks fine\nVERDICT: approve\nFINDINGS:\nnone")).toMatchObject({ verdict: "approve", findings: "none", clear: true })
    expect(Rv.parseVerdict("VERDICT: changes\nFINDINGS:\n- no rate limit on /login")).toMatchObject({ verdict: "changes", findings: "- no rate limit on /login" })
    expect(Rv.parseVerdict("**VERDICT:** approve")).toMatchObject({ verdict: "approve" })
    expect(Rv.parseVerdict("I think it is fine.")).toMatchObject({ verdict: "changes", clear: false })
  })
  test("the wrapper runs the client in the copy and hands its answer back", () => {
    const s = Rv.script({ name: "review-x", dir: "/d", worktree: "/w", who: { client: "codex", bin: "/b/codex" }, prompt: "p", cli: "crosstalk", run: "r9" })
    expect(s).toContain("cd /w")
    expect(s).toContain("/b/codex exec")
    expect(s).toContain("--output-last-message /d/last.txt")
    expect(s).toContain("crosstalk review --run r9 --output")
    const c = Rv.argvFor({ client: "claude", bin: "/b/claude", model: "opus" }, "/d/prompt.txt", "/d/last.txt")
    expect(c).toContain("-p \"$(cat /d/prompt.txt)\" --model opus")
    expect(c).toContain("--allowedTools")
  })
})

// --- providers against mocks ----------------------------------------------------------------------

describe("LaunchDarkly against a mock", () => {
  const state: any = {
    key: "login-v2",
    variations: [{ _id: "v-true", value: true }, { _id: "v-false", value: false }],
    environments: { production: { on: false, fallthrough: { variation: 1 } } },
  }
  const seen: any[] = []
  const server = Bun.serve({
    port: 0,
    async fetch(req) {
      const u = new URL(req.url)
      if (req.headers.get("authorization") !== "api-tok") return new Response("unauthorised", { status: 401 })
      if (!u.pathname.startsWith("/api/v2/flags/web/login-v2")) return new Response("nope", { status: 404 })
      if (req.method === "GET") return Response.json(state)
      if (req.method === "PATCH") {
        expect(req.headers.get("content-type")).toContain("domain-model=launchdarkly.semanticpatch")
        const body = await req.json()
        seen.push(body)
        const e = state.environments[body.environmentKey]
        for (const i of body.instructions) {
          if (i.kind === "turnFlagOn") e.on = true
          else if (i.kind === "turnFlagOff") e.on = false
          else if (i.kind === "updateFallthroughVariationOrRollout") {
            if (i.variationId) e.fallthrough = { variation: state.variations.findIndex((v: any) => v._id === i.variationId) }
            else e.fallthrough = { rollout: { variations: Object.entries(i.rolloutWeights).map(([id, w]) => ({ variation: state.variations.findIndex((v: any) => v._id === id), weight: w })) } }
          }
        }
        return Response.json(state)
      }
      return new Response("bad", { status: 405 })
    },
  })
  afterAll(() => server.stop(true))
  const env = { LAUNCHDARKLY_API_TOKEN: "api-tok", LAUNCHDARKLY_PROJECT: "web", LAUNCHDARKLY_ENVIRONMENT: "production", LAUNCHDARKLY_BASE_URL: `http://127.0.0.1:${server.port}` }

  test("every stage, set and read back", async () => {
    const ld = new LaunchDarkly(env)
    expect(await ld.get("login-v2")).toBe("off")
    expect(await ld.set("login-v2", "internal", "merged")).toContain("internal")
    expect(await ld.get("login-v2")).toBe("internal")
    await ld.set("login-v2", "10%", "ramp")
    expect(await ld.get("login-v2")).toBe("10%")
    expect(seen.at(-1).instructions[1].rolloutWeights).toEqual({ "v-true": 10000, "v-false": 90000 })
    await ld.set("login-v2", "on", "ramp")
    expect(await ld.get("login-v2")).toBe("on")
    await ld.set("login-v2", "off", "incident")
    expect(await ld.get("login-v2")).toBe("off")
    expect(seen.at(-1).instructions).toEqual([{ kind: "turnFlagOff" }])
    expect(seen.at(-1).comment).toBe("crosstalk: incident")
  })
  test("a bad token, an unknown flag, and no token at all", async () => {
    await expect(new LaunchDarkly({ ...env, LAUNCHDARKLY_API_TOKEN: "wrong" }).get("login-v2")).rejects.toThrow("401")
    await expect(new LaunchDarkly(env).get("other")).rejects.toThrow("404")
    expect(() => new LaunchDarkly({})).toThrow(NotConfigured)
  })
})

describe("PostHog against a mock", () => {
  const flags: any[] = [{ id: 7, key: "login-v2", active: false, filters: { groups: [] } }]
  const server = Bun.serve({
    port: 0,
    async fetch(req) {
      const u = new URL(req.url)
      if (req.headers.get("authorization") !== "Bearer phx_key") return new Response("unauthorised", { status: 401 })
      const base = "/api/projects/42/feature_flags/"
      if (req.method === "GET" && u.pathname === base) return Response.json({ results: flags.filter((f) => f.key.includes(u.searchParams.get("search") ?? "")) })
      if (req.method === "POST" && u.pathname === base) {
        const body = await req.json()
        const f = { id: flags.length + 100, ...body }
        flags.push(f)
        return Response.json(f)
      }
      const m = new RegExp(`^${base}(\\d+)/$`).exec(u.pathname)
      if (req.method === "PATCH" && m) {
        const f = flags.find((x) => x.id === Number(m[1]))
        Object.assign(f, await req.json())
        return Response.json(f)
      }
      return new Response("nope", { status: 404 })
    },
  })
  afterAll(() => server.stop(true))
  const env = { POSTHOG_PERSONAL_API_KEY: "phx_key", POSTHOG_PROJECT_ID: "42", POSTHOG_HOST: `http://127.0.0.1:${server.port}`, POSTHOG_INTERNAL_COHORT: "5" }

  test("every stage, set and read back; internal is the cohort", async () => {
    const ph = new PostHog(env)
    expect(await ph.get("login-v2")).toBe("off")
    await ph.set("login-v2", "internal", "merged")
    expect(await ph.get("login-v2")).toBe("internal")
    expect(flags[0].filters.groups).toEqual([{ properties: [{ key: "id", type: "cohort", value: 5 }], rollout_percentage: 100 }])
    await ph.set("login-v2", "50%", "ramp")
    expect(await ph.get("login-v2")).toBe("50%")
    await ph.set("login-v2", "on", "ramp")
    expect(await ph.get("login-v2")).toBe("on")
    await ph.set("login-v2", "off", "incident")
    expect(await ph.get("login-v2")).toBe("off")
    expect(flags[0].active).toBe(false)
  })
  test("a flag PostHog lacks is created; internal needs to know who internal is", async () => {
    const ph = new PostHog(env)
    expect(await ph.get("brand-new")).toBeUndefined()
    await ph.set("brand-new", "off", "merged")
    expect(flags.find((f) => f.key === "brand-new")).toBeTruthy()
    const { POSTHOG_INTERNAL_COHORT: _c, ...noCohort } = env
    await expect(new PostHog(noCohort).set("login-v2", "internal", "x")).rejects.toThrow(NotConfigured)
    await expect(new PostHog({ ...env, POSTHOG_PERSONAL_API_KEY: "bad" }).get("login-v2")).rejects.toThrow("401")
    expect(() => new PostHog({})).toThrow(NotConfigured)
  })
})

describe("the other providers and the flags file", () => {
  test("GrowthBook and Statsig say not yet", async () => {
    await expect(providerFor("growthbook", { root: TMP }).get("x")).rejects.toThrow("not supported yet")
    await expect(providerFor("statsig", { root: TMP }).set("x", "on", "y")).rejects.toThrow("not supported yet")
  })
  test("the flags file: read from main, changed with a commit", async () => {
    const { dir, bare } = repo()
    const p = new FileFlags(dir, { push: "direct" })
    expect(p.instant).toBe(false)
    expect(await p.get("login-v2")).toBeUndefined()
    expect(await p.set("login-v2", "off", "merged")).toContain("next deploy")
    expect(await p.set("login-v2", "internal", "ramp")).toContain("internal")
    expect(await p.get("login-v2")).toBe("internal")
    expect(F.parseFlags(G.show(bare, "main", F.FLAGS_FILE)!).flags).toEqual({ "login-v2": "internal" })
    expect(sh(dir, "log", "-1", "--format=%s", "main")).toBe("flags: login-v2 internal")
    expect(await p.set("login-v2", "internal", "again")).toContain("already")
  })
})

// --- incidents ---------------------------------------------------------------------------------

describe("incident mapping", () => {
  const now = Date.parse("2026-11-01")
  const mk = (name: string, features: { name: string; risk?: "risky"; flag?: string; merged?: { sha: string; files: string[]; at: number; shas?: string[] } }[]) => {
    const t = M.create({ name, repo: "r", by: "me", label: "paul", now })
    for (const f of features)
      M.put(t, "features", M.slug(f.name), { name: f.name, risk: f.risk ?? "everyday", ...(f.flag ? { flag: f.flag } : {}), ...(f.merged ? { ship: { merged: { ...f.merged, shas: f.merged.shas ?? [], how: "ff" } } } : {}) }, "me")
    return t
  }
  const auth = mk("auth", [{ name: "login v2", risk: "risky", flag: "login-v2", merged: { sha: "aaaa1111bbbb", files: ["src/auth/login.ts"], at: now - 86400_000, shas: ["cccc2222dddd"] } }])
  const docs = mk("docs", [{ name: "new docs", merged: { sha: "eeee3333", files: ["docs/a.md", "src/shared/x.ts"], at: now - 2 * 86400_000 } }])
  const old = mk("old", [{ name: "old thing", merged: { sha: "ffff4444", files: ["src/legacy.ts"], at: now - 60 * 86400_000 } }])
  const all = [auth, docs, old]
  const map = (i: Partial<import("../src/shipping/incident.ts").Incident>) => I.mapIncident({ source: "s", title: "t", details: "", ...i }, all, { now, days: 14 })
  test("by flag, by sha or its prefix, by files", () => {
    expect(map({ flag: "login-v2" })).toMatchObject({ thread: auth.id, by: "flag" })
    expect(map({ sha: "cccc2222" })).toMatchObject({ thread: auth.id, by: "sha" })
    expect(map({ files: ["/src/auth/login.ts:40:2"] })).toMatchObject({ thread: auth.id, by: "files" })
    expect(map({ files: ["app/docs/a.md"] })).toMatchObject({ thread: docs.id })
  })
  test("unclear is null: nothing matches, a tie, or a ship too long ago", () => {
    expect(map({ flag: "nope", files: ["src/nowhere.ts"] })).toBeNull()
    expect(map({ files: ["src/legacy.ts"] })).toBeNull()
    const twin = mk("twin", [{ name: "twin", merged: { sha: "9999", files: ["src/auth/login.ts"], at: now - 1000 } }])
    expect(I.mapIncident({ source: "s", title: "t", details: "", files: ["src/auth/login.ts"] }, [auth, twin], { now, days: 14 })).toBeNull()
  })
})

// --- the engine ----------------------------------------------------------------------------------

/** Threads in memory, the way ThreadService keeps them. */
class MemPort implements ThreadPort {
  me = "fp-me"
  label = "paul"
  threads = new Map<string, import("../src/threads/model.ts").Thread>()
  placed = new Map<string, string>()
  sessions = new Map<string, import("../src/shipping/engine.ts").SessionInfo>()
  notes: string[] = []
  get = (id: string) => this.threads.get(id)
  find = (sid: string | undefined, n?: string) => {
    if (!n) return sid ? this.threads.get(this.placed.get(sid) ?? "") : undefined
    return [...this.threads.values()].find((t) => t.id === n || t.meta.value.name === M.slug(n))
  }
  all = () => [...this.threads.values()]
  mutate = (id: string, fn: (t: any, by: string, now: number) => unknown) => {
    const t = this.threads.get(id)
    if (t) fn(t, this.me, Date.now())
  }
  notify = (_id: string, text: string) => void this.notes.push(text)
  open = (o: { name: string; repo: string }) => {
    const t = M.create({ name: o.name, repo: o.repo, by: this.me, label: this.label })
    this.threads.set(t.id, t)
    return t
  }
  sessionsIn = (id: string) => [...this.placed.entries()].filter(([, t]) => t === id).map(([s]) => s)
  session = (sid: string) => this.sessions.get(sid)
  rootFor = (_repo: string) => [...this.sessions.values()][0]?.root
}

function engineWith(o: { launches?: any[]; root: string }) {
  const port = new MemPort()
  const asked: Question[] = []
  const woke: { sid: string; text: string }[] = []
  const launches = o.launches ?? []
  const e = new ShipEngine({
    threads: port,
    file: path.join(TMP, `ship-${++n}.json`),
    home: path.join(TMP, `shiphome-${n}`),
    cli: "crosstalk",
    wake: (sid, text) => void woke.push({ sid, text }),
    ask: (q) => void asked.push(q),
    settle: () => {},
    launch: (l) => (launches.push(l), { ok: true, how: "test" }),
    detect: () => ({ claude: "/stub/claude", codex: "/stub/codex" }),
    gh: false,
    log: () => {},
  })
  return { e, port, asked, woke, launches }
}

describe("the engine", () => {
  test("everyday: ready → one reviewer → approve → green → merged; the thread is done", async () => {
    const { dir, bare } = repo({ "README.md": "hi\n", ".crosstalk/ship": "push: direct\ntest: test -f README.md\n", ".crosstalk/risk": "high: src/auth/**\n" })
    const wt = commitOn(dir, "crosstalk/docs", "docs/guide.md", "guide\n")
    const { e, port, launches, woke } = engineWith({ root: dir })
    const t = port.open({ name: "docs", repo: "r" })
    port.placed.set("s1", t.id)
    port.sessions.set("s1", { sessionId: "s1", name: "docs", cwd: wt, root: wt, branch: "crosstalk/docs" })
    const f = await e.feature("s1", { name: "user guide" })
    expect(f).toMatchObject({ ok: true, risk: "everyday" })
    const r = await e.ready("s1", { feature: "user guide" })
    expect(r.ok).toBe(true)
    expect(launches.map((l) => l.who.client)).toEqual(["claude"])
    expect(launches[0].prompt).toContain("user guide")
    expect(fs.existsSync(launches[0].worktree)).toBe(true)
    const run = launches[0].run
    const done = await e.review({ run, verdict: "approve", findings: "none" })
    expect(done.ok).toBe(true)
    expect(fs.existsSync(launches[0].worktree)).toBe(false)
    const feat = port.get(t.id)!.features["user-guide"]
    expect(feat.ship?.state).toBe("merged")
    expect(feat.ship?.signoff?.[0]).toMatchObject({ kind: "review", client: "claude" })
    expect(sh(bare, "rev-parse", "main")).toBe(sh(dir, "rev-parse", "crosstalk/docs"))
    expect(port.get(t.id)!.meta.value.status).toBe("done")
    expect(M.live(port.get(t.id)!, "decisions").map((d) => d.text).join("\n")).toContain("Reviewers signed off")
    expect(woke.at(-1)?.text).toContain("merged into main")
  })

  test("risky by path; lowering is a question no agent can answer; changes go back to the author; evidence gates the merge", async () => {
    const { dir } = repo({ "README.md": "hi\n", ".crosstalk/ship": "push: local\nrounds: 2\n", ".crosstalk/risk": "high: src/auth/**\n" })
    const wt = commitOn(dir, "crosstalk/auth", "src/auth/login.ts", "export const login = 1\n")
    const { e, port, launches, woke, asked } = engineWith({ root: dir })
    const t = port.open({ name: "auth", repo: "r" })
    port.placed.set("s2", t.id)
    port.sessions.set("s2", { sessionId: "s2", name: "auth", cwd: wt, root: wt, branch: "crosstalk/auth" })
    const f = await e.feature("s2", { name: "login v2" })
    expect(f).toMatchObject({ risk: "risky", flag: "login-v2" })
    // An agent asks to lower it: a question, and the risk holds.
    const low = await e.feature("s2", { name: "login v2", risk: "everyday", why: "it is small" })
    expect(low.question).toBeTruthy()
    expect(port.get(t.id)!.features["login-v2"].risk).toBe("risky")
    expect((await e.answer(String(low.question), "Make it everyday", { person: false })).ok).toBe(false)
    expect((await e.answer(String(low.question), "Keep it risky", { person: true })).text).toContain("stays risky")
    // Review: codex adversarial and a security pass.
    await e.ready("s2", { feature: "login v2" })
    expect(launches.map((l) => `${l.name.includes("adversarial") ? "adversarial" : "security"}:${l.who.client}`)).toEqual(["adversarial:codex", "security:claude"])
    await e.review({ run: launches[0].run, verdict: "changes", findings: "no rate limit on login" })
    expect(woke.length).toBe(0)
    await e.review({ run: launches[1].run, verdict: "approve", findings: "none" })
    expect(woke.at(-1)!.text).toContain("no rate limit on login")
    expect(woke.at(-1)!.text).toContain("<crosstalk-review")
    // Round 2: the author answers; both approve; no evidence yet.
    await e.ready("s2", { feature: "login v2", response: "added a rate limit" })
    expect(launches[2].prompt).toContain("added a rate limit")
    await e.review({ run: launches[2].run, verdict: "approve", findings: "none" })
    await e.review({ run: launches[3].run, verdict: "approve", findings: "none" })
    expect(port.get(t.id)!.features["login-v2"].ship?.state).toBe("needs-evidence")
    expect(woke.at(-1)!.text).toContain("crosstalk_evidence")
    // Evidence: a diff is refused, plain words with proof are not, and the merge is asked.
    expect((await e.evidence("s2", { feature: "login v2", summary: "diff --git a/x b/x\n@@ -1 +1 @@" })).ok).toBe(false)
    const ev = await e.evidence("s2", { feature: "login v2", summary: "Login is rate limited to 5 tries a minute.", tests: ["rate-limit.test: 4 pass"] })
    expect(ev.question).toBeTruthy()
    const mq = asked.find((q) => q.kind === "merge")!
    expect(mq.text).toContain("rate limited to 5 tries")
    expect(sh(dir, "rev-parse", "main")).not.toBe(sh(dir, "rev-parse", "crosstalk/auth"))
    const m = await e.answer(mq.id, "Merge it", { person: true })
    expect(m.ok).toBe(true)
    // In main, with the flag's own commit on top.
    expect(sh(dir, "rev-parse", "main~1")).toBe(sh(dir, "rev-parse", "crosstalk/auth"))
    expect(F.parseFlags(G.show(dir, "main", F.FLAGS_FILE)!).flags["login-v2"]).toBe("off")
    // The first ramp step is asked straight away, on the merge evidence.
    const r1 = asked.find((q) => q.kind === "ramp")!
    expect(r1.stage).toBe("internal")
    expect(r1.text).toContain("rate limited")
    await e.answer(r1.id, "Turn it up to internal", { person: true })
    expect(F.parseFlags(G.show(dir, "main", F.FLAGS_FILE)!).flags["login-v2"]).toBe("internal")
    // The next step waits for evidence at internal.
    expect(asked.filter((q) => q.kind === "ramp").length).toBe(1)
    const ev2 = await e.evidence("s2", { feature: "login v2", summary: "Internal accounts logged in 40 times, no errors.", evals: ["error rate 0%"], stage: "internal" })
    expect(ev2.question).toBeTruthy()
    // An agent turning it up is a question; turning it off is not.
    const up = await e.flag("s2", { flag: "login-v2", stage: "on" })
    expect(up.text).toContain("already out")
    const off = await e.flag("s2", { flag: "login-v2", stage: "off", why: "errors spiking" })
    expect(off.ok).toBe(true)
    expect(F.parseFlags(G.show(dir, "main", F.FLAGS_FILE)!).flags["login-v2"]).toBe("off")
    expect(e.open().filter((q) => q.kind === "ramp").length).toBe(0)
  })

  test("a flag that reaches everyone leaves a task to remove it", async () => {
    const { dir } = repo({ "README.md": "hi\n", ".crosstalk/ship": "push: local\n" })
    const wt = commitOn(dir, "crosstalk/x", "x.txt", "x\n")
    const { e, port, launches } = engineWith({ root: dir })
    const t = port.open({ name: "x", repo: "r" })
    port.placed.set("s3", t.id)
    port.sessions.set("s3", { sessionId: "s3", name: "x", cwd: wt, root: wt, branch: "crosstalk/x" })
    await e.feature("s3", { name: "banner", flag: "banner" })
    await e.ready("s3", { feature: "banner" })
    await e.review({ run: launches[0].run, verdict: "approve", findings: "none" })
    // Everyday: its flag moves without a question.
    const r = await e.flag("s3", { flag: "banner", stage: "on" })
    expect(r.ok).toBe(true)
    expect(port.get(t.id)!.features["banner"].ship?.state).toBe("shipped")
    expect(M.live(port.get(t.id)!, "tasks").map((k) => k.text).join()).toContain("Remove the flag banner")
  })

  test("disagreement after N rounds is one plain question", async () => {
    const { dir } = repo({ "README.md": "hi\n", ".crosstalk/ship": "push: local\nrounds: 1\n" })
    const wt = commitOn(dir, "crosstalk/y", "y.txt", "y\n")
    const { e, port, launches, asked } = engineWith({ root: dir })
    const t = port.open({ name: "y", repo: "r" })
    port.placed.set("s4", t.id)
    port.sessions.set("s4", { sessionId: "s4", name: "y", cwd: wt, root: wt, branch: "crosstalk/y" })
    await e.ready("s4", { feature: "tidy" })
    await e.review({ run: launches[0].run, verdict: "changes", findings: "rename everything" })
    const q = asked.find((x) => x.kind === "disagree")!
    expect(q.text).toContain("rename everything")
    expect(q.options).toContain("Ship it as it is")
    await e.answer(q.id, "Ship it as it is", { person: true })
    expect(port.get(t.id)!.features["tidy"].ship?.state).toBe("merged")
  })

  test("an incident with a risky feature's flag kills the flag and reopens its thread; an unclear one starts a thread", async () => {
    const { dir } = repo({ "README.md": "hi\n", ".crosstalk/ship": "push: local\n" })
    const { e, port, woke } = engineWith({ root: dir })
    const t = port.open({ name: "auth", repo: "r" })
    port.placed.set("s5", t.id)
    port.sessions.set("s5", { sessionId: "s5", name: "auth", cwd: dir, root: dir })
    port.mutate(t.id, (th, by, now) => {
      M.put(th, "features", "login-v2", { name: "login v2", risk: "risky", flag: "login-v2", ship: { state: "merged", stage: "10%", merged: { sha: "abc1234567", at: Date.now(), files: ["src/auth/login.ts"], shas: [], how: "ff" } } }, by, now)
      M.setMeta(th, by, { status: "done" }, now)
    })
    const r = await e.incident({ source: "sentry", title: "500s on /login", details: "TypeError", flag: "login-v2" })
    expect(r).toMatchObject({ ok: true, reopened: true, killed: "login-v2" })
    expect(port.get(t.id)!.meta.value.status).toBe("active")
    expect(port.get(t.id)!.features["login-v2"].ship?.stage).toBe("off")
    expect(F.parseFlags(G.show(dir, "main", F.FLAGS_FILE)!).flags["login-v2"]).toBe("off")
    expect(woke.at(-1)!.text).toContain("500s on /login")
    const u = await e.incident({ source: "pagerduty", title: "disk full", details: "", files: ["nowhere.c"] })
    expect(u).toMatchObject({ ok: true, reopened: false })
    const it = port.find(undefined, String(u.thread))!
    expect(M.live(it, "facts")[0].text).toContain("disk full")
    const l = await e.link(undefined, { incident: String(u.thread), cause: "auth" })
    expect(l.ok).toBe(true)
    expect(port.find(undefined, String(u.thread))!.meta.value.status).toBe("done")
  })
})

// --- the local incident webhook ------------------------------------------------------------------

const { fromPayload } = await import("../scripts/incident-webhook.ts")

describe("the incident webhook script", () => {
  test("a Sentry event: title, culprit, in-app files, release as sha, flag tag", () => {
    const inc = fromPayload(
      {
        data: {
          event: {
            title: "TypeError: x is undefined",
            culprit: "login.ts in check",
            release: "abc1234def",
            tags: [["flag", "login-v2"], ["env", "prod"]],
            exception: { values: [{ stacktrace: { frames: [{ filename: "node_modules/lib.js", in_app: false }, { filename: "src/auth/login.ts", in_app: true }] } }] },
          },
        },
      },
      "webhook",
    )
    expect(inc).toEqual({ source: "sentry", title: "TypeError: x is undefined", details: "login.ts in check", flag: "login-v2", files: ["src/auth/login.ts"], sha: "abc1234def" })
  })
  test("generic JSON, and nothing without a title", () => {
    expect(fromPayload({ title: "checkout down", details: "502", flag: "pay" }, "uptime")).toEqual({ source: "uptime", title: "checkout down", details: "502", flag: "pay" })
    expect(fromPayload({ nope: 1 }, "x")).toBeNull()
  })
})
