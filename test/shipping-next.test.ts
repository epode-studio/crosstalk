// Shipping, the rest of it: previews per thread, dark launches, metrics that
// ramp a flag or turn it off, GrowthBook and Statsig, and shipping questions
// answered from another person's machine.
//
//   bun test test/shipping-next.test.ts
//
// Providers run against local mocks (test/flag-mocks.ts); git is real, in
// temp repos; time is a fake clock.

import { afterAll, describe, expect, test } from "bun:test"
import { spawnSync } from "node:child_process"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), "ct-ship2-"))
process.env.CROSSTALK_HOME = path.join(TMP, "home")
process.env.GIT_AUTHOR_NAME = process.env.GIT_COMMITTER_NAME = "t"
process.env.GIT_AUTHOR_EMAIL = process.env.GIT_COMMITTER_EMAIL = "t@t"
afterAll(() => fs.rmSync(TMP, { recursive: true, force: true }))

const C = await import("../src/shipping/config.ts")
const F = await import("../src/shipping/flags.ts")
const G = await import("../src/shipping/git.ts")
const Mx = await import("../src/shipping/metrics.ts")
const Sh = await import("../src/shipping/shadow.ts")
const Pv = await import("../src/shipping/preview.ts")
const Rm = await import("../src/shipping/remote.ts")
const { GrowthBook } = await import("../src/shipping/providers/growthbook.ts")
const { Statsig } = await import("../src/shipping/providers/statsig.ts")
const { LaunchDarkly } = await import("../src/shipping/providers/launchdarkly.ts")
const { WithDark, darkFlag, NotConfigured, providerFor } = await import("../src/shipping/providers/index.ts")
const { Unleash, parseConstraint } = await import("../src/shipping/providers/unleash.ts")
const M = await import("../src/threads/model.ts")
const { ShipEngine, choose } = await import("../src/shipping/engine.ts")
const { newIdentity, fingerprint } = await import("../src/crypto.ts")
const { serveFlagMocks, GB_KEY, SS_KEY, UL_KEY } = await import("./flag-mocks.ts")
type ThreadPort = import("../src/shipping/engine.ts").ThreadPort
type Question = import("../src/shipping/engine.ts").Question
type Peer = import("../src/config.ts").Peer

const sh = (cwd: string, ...args: string[]) => {
  const r = spawnSync("git", ["-C", cwd, ...args], { encoding: "utf8" })
  if (r.status !== 0) throw new Error(`git ${args.join(" ")}: ${r.stderr}`)
  return r.stdout.trim()
}
let n = 0
function repo(files: Record<string, string>) {
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
function commitOn(dir: string, branch: string, file: string, content: string) {
  const wt = path.join(TMP, `wt${++n}`)
  sh(dir, "worktree", "add", "-q", "-b", branch, wt, "main")
  fs.mkdirSync(path.dirname(path.join(wt, file)), { recursive: true })
  fs.writeFileSync(path.join(wt, file), content)
  sh(wt, "add", "-A")
  sh(wt, "commit", "-qm", `change ${file}`)
  return wt
}

// --- small pieces ------------------------------------------------------------------------------

describe("stages, config, metrics, shadow counts", () => {
  test("dark sits between off and internal, and is the first step of the default ramp", () => {
    expect(F.parseStage("dark")).toBe("dark")
    expect(F.parseStage("shadow")).toBe("dark")
    expect(F.order("dark")).toBeGreaterThan(F.order("off"))
    expect(F.order("dark")).toBeLessThan(F.order("internal"))
    expect(F.nextStage("off", C.DEFAULT_RAMP)).toBe("dark")
    expect(F.nextStage("dark", C.DEFAULT_RAMP)).toBe("internal")
    expect(F.parseFlags(F.setFlag(undefined, "x", "dark")).flags.x).toBe("dark")
  })
  test(".crosstalk/ship reads previews, metrics, thresholds and the dwell", () => {
    const c = C.parseShip("preview: fly deploy --app x-pr-{branch}\npreview_check: npx playwright test\npreview_teardown: fly apps destroy x-pr-{branch} -y\nmetrics: ./m.sh\nregress: errors:+25% latency_p95:+10% signups:-20% error_rate:>2%\ndwell: 30m\neveryday_ramp: internal 50% on\nshadow: .shadow\n")
    expect(c).toMatchObject({ preview: "fly deploy --app x-pr-{branch}", previewCheck: "npx playwright test", metrics: "./m.sh", dwellMs: 30 * 60_000, everydayRamp: ["internal", "50%", "on"], shadow: ".shadow" })
    expect(c.regress).toEqual([
      { metric: "errors", kind: "rise", value: 0.25 },
      { metric: "latency_p95", kind: "rise", value: 0.1 },
      { metric: "signups", kind: "fall", value: 0.2 },
      { metric: "error_rate", kind: "above", value: 0.02 },
    ])
    const d = C.parseShip("")
    expect(d.dwellMs).toBe(3_600_000)
    expect(d.everydayRamp).toEqual(["internal", "on"])
    expect(d.ramp[0]).toBe("dark")
    expect(C.parseDuration("90s", 0)).toBe(90_000)
    expect(C.parseDuration("2d", 0)).toBe(2 * 86_400_000)
    expect(C.parseDuration("soon", 7)).toBe(7)
  })
  test("metrics: the JSON a command printed, and what regressed", () => {
    expect(Mx.parseMetrics('querying...\n{"errors": 3, "latency_p95": "120", "note": "x"}\n')).toEqual({ errors: 3, latency_p95: 120 })
    expect(Mx.parseMetrics('{"metrics": {"errors": 1}}')).toEqual({ errors: 1 })
    expect(Mx.parseMetrics("nothing")).toBeUndefined()
    const rules = C.parseRegress("*:+50% signups:-20% shadow_mismatch_rate:>0.01")
    expect(Mx.regressions({ errors: 10, latency: 100, signups: 50 }, { errors: 14, latency: 100, signups: 45 }, rules)).toEqual([])
    const r = Mx.regressions({ errors: 10, signups: 50 }, { errors: 16, signups: 30 }, rules)
    expect(r.map((b) => b.metric)).toEqual(["errors", "signups"])
    expect(r[0].text).toContain("from 10 to 16")
    expect(Mx.regressions({ errors: 0 }, { errors: 1 }, rules)).toEqual([])
    expect(Mx.regressions({ errors: 0 }, { errors: 5 }, rules)[0].text).toContain("from 0 to 5")
    // Shadow counts only answer to their own rule, never to *.
    expect(Mx.regressions({ shadow_mismatches: 1 }, { shadow_mismatches: 9, shadow_mismatch_rate: 0.005 }, rules)).toEqual([])
    expect(Mx.regressions(undefined, { shadow_mismatch_rate: 0.2 }, rules)[0].metric).toBe("shadow_mismatch_rate")
    expect(Mx.describeMetrics({ errors: 3 }, { errors: 2 })).toBe("errors 3 (was 2)")
  })
  test("shadow reports: counted from words or JSON, a bare report is one more, and a counter file", () => {
    expect(Sh.parseCounts("calls=1200 mismatches=3")).toEqual({ calls: 1200, mismatches: 3 })
    expect(Sh.parseCounts('{"calls": 10}')).toEqual({ calls: 10 })
    let c = Sh.record(undefined, { title: "price differs", details: "calls=100" }, 1)
    c = Sh.record(c, { title: "price differs again" }, 2)
    expect(c).toMatchObject({ calls: 100, mismatches: 2, since: 1, at: 2 })
    expect(Sh.asMetrics(c)).toEqual({ shadow_calls: 100, shadow_mismatches: 2, shadow_mismatch_rate: 0.02 })
    const dir = path.join(TMP, "shadow")
    fs.mkdirSync(dir, { recursive: true })
    fs.writeFileSync(path.join(dir, "pay-v2.json"), JSON.stringify({ calls: 500, mismatches: 1 }))
    expect(Sh.readCounter(dir, "pay-v2")).toEqual({ calls: 500, mismatches: 1 })
    expect(Sh.readCounter(dir, "other")).toBeUndefined()
    expect(Sh.combine(c, { calls: 500, mismatches: 1 })).toEqual({ calls: 500, mismatches: 2 })
  })
  test("answers: exactly, by their start, or a plain yes", () => {
    expect(choose(["Turn it up to dark", "Not yet"], "ramp", "yes")).toBe("Turn it up to dark")
    expect(choose(["Keep it risky", "Make it everyday"], "lower", "y")).toBe("Make it everyday")
    expect(choose(["Merge it", "Not yet"], "merge", "not")).toBe("Not yet")
    expect(choose(["Merge it", "Not yet"], "merge", "maybe")).toBeUndefined()
  })
})

// --- previews ------------------------------------------------------------------------------------

describe("preview per thread", () => {
  test("the URL out of what a deploy printed, and {branch} made safe for a hostname", () => {
    expect(Pv.previewUrl("Building...\nhttps://a.example.com/x done\nInspect: https://vercel.com/i/abc.")).toBe("https://vercel.com/i/abc")
    expect(Pv.previewUrl("x https://a.test\nPREVIEW_URL=https://real.test/\n")).toBe("https://real.test/")
    expect(Pv.previewUrl("no url")).toBeUndefined()
    expect(Pv.fill("fly deploy --app x-pr-{branch}", { branch: "crosstalk/Login_V2" })).toBe("fly deploy --app x-pr-crosstalk-login-v2")
  })
  test("deployed from a copy of the branch with the flag forced on; the check gets PREVIEW_URL", async () => {
    const { dir } = repo({ "README.md": "hi\n" })
    commitOn(dir, "crosstalk/pay", "src/pay.ts", "export const pay = 2\n")
    const log = path.join(TMP, "pv.log")
    const r = await Pv.runPreview({
      root: dir,
      branch: "crosstalk/pay",
      flag: "pay-v2",
      feature: "pay v2",
      scratchDir: path.join(TMP, "pvs"),
      deploy: `echo "flags=$CROSSTALK_FLAGS branch=$CROSSTALK_BRANCH file=$(cat src/pay.ts)" >>${log}; echo "Ready: https://{branch}.preview.test"`,
      check: `echo "check $PREVIEW_URL" >>${log}; echo "4 e2e tests pass"`,
      timeoutS: 30,
    })
    expect(r).toMatchObject({ ok: true, url: "https://crosstalk-pay.preview.test" })
    expect(r.check?.out).toContain("4 e2e tests pass")
    const l = fs.readFileSync(log, "utf8")
    expect(l).toContain("flags=pay-v2=on branch=crosstalk/pay file=export const pay = 2")
    expect(l).toContain("check https://crosstalk-pay.preview.test")
    const bad = await Pv.runPreview({ root: dir, branch: "crosstalk/pay", feature: "x", scratchDir: path.join(TMP, "pvs"), deploy: "echo deployed", timeoutS: 30 })
    expect(bad.error).toContain("no URL")
    const red = await Pv.runPreview({ root: dir, branch: "crosstalk/pay", feature: "x", scratchDir: path.join(TMP, "pvs"), deploy: "echo https://x.test", check: "echo broken; exit 1", timeoutS: 30 })
    expect(red).toMatchObject({ ok: false, url: "https://x.test", error: "the preview check failed" })
  })
})

// --- providers against mocks ------------------------------------------------------------------------

const mocks = serveFlagMocks()
afterAll(() => mocks.server.stop(true))

describe("Unleash against a mock", () => {
  const env = { UNLEASH_URL: `${mocks.url}/api/`, UNLEASH_ADMIN_TOKEN: UL_KEY, UNLEASH_INTERNAL_CONSTRAINT: "email ENDS_WITH @company.com" }
  const strategies = (f: string, e = "production") => mocks.state.unleash.features[f].environments.find((x: any) => x.name === e).strategies
  const enabled = (f: string) => mocks.state.unleash.features[f].environments.find((x: any) => x.name === "production").enabled
  test("the internal constraint, read from words", () => {
    expect(parseConstraint("email ENDS_WITH @company.com")).toEqual({ contextName: "email", operator: "STR_ENDS_WITH", values: ["@company.com"], caseInsensitive: true, inverted: false })
    expect(parseConstraint("userId IN 1, 2")).toMatchObject({ operator: "IN", values: ["1", "2"] })
    expect(() => parseConstraint("nonsense")).toThrow(NotConfigured)
  })
  test("a missing toggle is created off; every stage, dark included, set and read back; your strategies stay; off is the environment", async () => {
    const ul = new Unleash(env)
    expect(await ul.get("checkout-v3")).toBeUndefined()
    await ul.set("checkout-v3", "off", "merged")
    expect(mocks.state.unleash.features["checkout-v3"]).toMatchObject({ type: "release", project: "default" })
    expect(await ul.get("checkout-v3")).toBe("off")
    strategies("checkout-v3").push({ id: "theirs", name: "flexibleRollout", title: "QA", parameters: { rollout: "100", stickiness: "default", groupId: "x" }, constraints: [{ contextName: "userId", operator: "IN", values: ["qa"] }] })
    await ul.set("checkout-v3", "dark", "ramp")
    expect(await ul.get("checkout-v3")).toBe("dark")
    expect(enabled("checkout-v3")).toBe(true)
    expect(strategies("checkout-v3").find((s: any) => s.title === "crosstalk: dark").variants[0]).toMatchObject({ name: "dark", weight: 1000, payload: { type: "string", value: "crosstalk-stage=dark" } })
    await ul.set("checkout-v3", "internal", "ramp")
    expect(await ul.get("checkout-v3")).toBe("internal")
    expect(strategies("checkout-v3").map((s: any) => s.title)).toEqual(["QA", "crosstalk: internal"])
    expect(strategies("checkout-v3")[1]).toMatchObject({ name: "flexibleRollout", parameters: { rollout: "100", stickiness: "default", groupId: "checkout-v3" }, constraints: [{ contextName: "email", operator: "STR_ENDS_WITH", values: ["@company.com"] }] })
    await ul.set("checkout-v3", "25%", "ramp")
    expect(await ul.get("checkout-v3")).toBe("25%")
    expect(strategies("checkout-v3").at(-1)).toMatchObject({ parameters: { rollout: "25" }, constraints: [] })
    await ul.set("checkout-v3", "on", "ramp")
    expect(await ul.get("checkout-v3")).toBe("on")
    expect(strategies("checkout-v3").map((s: any) => s.title)).toEqual(["QA", "crosstalk: everyone"])
    await ul.set("checkout-v3", "off", "incident")
    expect(await ul.get("checkout-v3")).toBe("off")
    expect(enabled("checkout-v3")).toBe(false)
    // The development environment was never touched.
    expect(strategies("checkout-v3", "development")).toEqual([])
  })
  test("internal by segment; exposures as metrics, kept out of the health rules; no internal; a bad token; no token", async () => {
    const ul = new Unleash({ ...env, UNLEASH_INTERNAL_CONSTRAINT: undefined, UNLEASH_INTERNAL_SEGMENT: "7", UNLEASH_URL: mocks.url })
    await ul.set("nav-v2", "internal", "x")
    expect(strategies("nav-v2")[0]).toMatchObject({ segments: [7], constraints: [] })
    expect(await ul.metrics("nav-v2")).toBeUndefined()
    mocks.state.unleash.usage["nav-v2"] = [
      { environment: "production", timestamp: "t", yes: 40, no: 960 },
      { environment: "development", timestamp: "t", yes: 5, no: 5 },
    ]
    expect(await ul.metrics("nav-v2")).toEqual({ exposures_yes: 40, exposures_no: 960, exposures: 1000 })
    expect(Mx.regressions({ exposures_yes: 1 }, { exposures_yes: 400 }, C.parseRegress(C.DEFAULT_REGRESS))).toEqual([])
    await expect(new Unleash({ UNLEASH_URL: mocks.url, UNLEASH_ADMIN_TOKEN: UL_KEY }).set("nav-v2", "internal", "x")).rejects.toThrow(NotConfigured)
    await expect(new Unleash({ ...env, UNLEASH_ADMIN_TOKEN: "wrong" }).get("nav-v2")).rejects.toThrow("401")
    expect(() => new Unleash({ UNLEASH_URL: mocks.url })).toThrow(NotConfigured)
    expect(() => new Unleash({ ...env, UNLEASH_INTERNAL_SEGMENT: "staff" })).toThrow(NotConfigured)
    expect(providerFor("unleash", { root: TMP, env }).name).toBe("Unleash")
    expect(C.parseShip("flags: unleash").flags).toBe("unleash")
  })
})

describe("GrowthBook against a mock", () => {
  const env = { GROWTHBOOK_API_KEY: GB_KEY, GROWTHBOOK_API_HOST: mocks.url, GROWTHBOOK_INTERNAL_EMAIL_DOMAIN: "example.com" }
  test("a missing feature is created off; every stage set and read back; others' rules are kept", async () => {
    const gb = new GrowthBook(env)
    expect(await gb.get("checkout-v2")).toBeUndefined()
    await gb.set("checkout-v2", "off", "merged")
    const f = mocks.state.features["checkout-v2"]
    expect(f).toMatchObject({ valueType: "boolean", defaultValue: "false" })
    expect(await gb.get("checkout-v2")).toBe("off")
    // Someone's own rule, which crosstalk must leave alone.
    f.environments.production.rules = [{ id: "mine", type: "force", description: "QA override", condition: '{"id":"qa"}', value: "true", enabled: true }]
    await gb.set("checkout-v2", "internal", "ramp")
    expect(await gb.get("checkout-v2")).toBe("internal")
    const rules = () => mocks.state.features["checkout-v2"].environments.production.rules
    expect(rules()[0].id).toBe("mine")
    expect(rules()[1]).toMatchObject({ type: "force", condition: JSON.stringify({ email: { $regex: "@example\\.com$" } }), value: "true" })
    await gb.set("checkout-v2", "25%", "ramp")
    expect(await gb.get("checkout-v2")).toBe("25%")
    expect(rules().find((r: any) => r.type === "rollout")).toMatchObject({ coverage: 0.25, value: "true", hashAttribute: "id" })
    await gb.set("checkout-v2", "on", "ramp")
    expect(await gb.get("checkout-v2")).toBe("on")
    expect(rules().map((r: any) => r.id === "mine" || r.description)).toEqual([true, "crosstalk: everyone"])
    await gb.set("checkout-v2", "off", "incident")
    expect(await gb.get("checkout-v2")).toBe("off")
    expect(mocks.state.features["checkout-v2"].environments.production.enabled).toBe(false)
  })
  test("internal needs to know who internal is; a bad key; no key", async () => {
    await expect(new GrowthBook({ GROWTHBOOK_API_KEY: GB_KEY, GROWTHBOOK_API_HOST: mocks.url }).set("checkout-v2", "internal", "x")).rejects.toThrow(NotConfigured)
    await expect(new GrowthBook({ ...env, GROWTHBOOK_API_KEY: "wrong" }).get("checkout-v2")).rejects.toThrow("401")
    expect(() => new GrowthBook({})).toThrow(NotConfigured)
    expect(() => new GrowthBook({ GROWTHBOOK_API_KEY: "k", GROWTHBOOK_INTERNAL_CONDITION: "{nope" })).toThrow(NotConfigured)
  })
  test("dark is a companion feature, on, while the flag itself stays off", async () => {
    const p = new WithDark(new GrowthBook(env))
    await p.set("search-v2", "off", "merged")
    expect(await p.set("search-v2", "dark", "ramp")).toContain("shadow")
    expect(await p.get("search-v2")).toBe("dark")
    expect(mocks.state.features[darkFlag("search-v2")].environments.production.enabled).toBe(true)
    await p.set("search-v2", "internal", "ramp")
    expect(await p.get("search-v2")).toBe("internal")
    expect(mocks.state.features[darkFlag("search-v2")].environments.production.enabled).toBe(false)
  })
})

describe("Statsig against a mock", () => {
  const env = { STATSIG_CONSOLE_API_KEY: SS_KEY, STATSIG_API_URL: `${mocks.url}/console/v1`, STATSIG_INTERNAL_SEGMENT: "employees" }
  test("a missing gate is created off; every stage set and read back; others' rules are kept", async () => {
    const ss = new Statsig(env)
    expect(await ss.get("beta-nav")).toBeUndefined()
    await ss.set("beta-nav", "off", "merged")
    expect(mocks.state.gates["beta-nav"]).toMatchObject({ isEnabled: false })
    mocks.state.gates["beta-nav"].rules = [{ name: "QA", passPercentage: 100, conditions: [{ type: "user_id", operator: "any", targetValue: ["qa"] }] }]
    await ss.set("beta-nav", "internal", "ramp")
    expect(await ss.get("beta-nav")).toBe("internal")
    const rules = () => mocks.state.gates["beta-nav"].rules
    expect(rules()[0].name).toBe("QA")
    expect(rules()[1]).toMatchObject({ name: "crosstalk: internal", passPercentage: 100, conditions: [{ type: "passes_segment", targetValue: ["employees"] }] })
    await ss.set("beta-nav", "10%", "ramp")
    expect(await ss.get("beta-nav")).toBe("10%")
    expect(rules().at(-1)).toMatchObject({ passPercentage: 10, conditions: [{ type: "public" }] })
    await ss.set("beta-nav", "on", "ramp")
    expect(await ss.get("beta-nav")).toBe("on")
    await ss.set("beta-nav", "off", "incident")
    expect(await ss.get("beta-nav")).toBe("off")
    expect(rules()[0].name).toBe("QA")
  })
  test("internal by email domain; no internal; a bad key; no key", async () => {
    const ss = new Statsig({ ...env, STATSIG_INTERNAL_SEGMENT: undefined, STATSIG_INTERNAL_EMAIL_DOMAIN: "example.com" })
    await ss.set("beta-nav", "internal", "x")
    expect(mocks.state.gates["beta-nav"].rules.at(-1).conditions[0]).toEqual({ type: "email", operator: "str_contains_any", targetValue: ["@example.com"] })
    await expect(new Statsig({ STATSIG_CONSOLE_API_KEY: SS_KEY, STATSIG_API_URL: `${mocks.url}/console/v1` }).set("beta-nav", "internal", "x")).rejects.toThrow(NotConfigured)
    await expect(new Statsig({ ...env, STATSIG_CONSOLE_API_KEY: "wrong" }).get("beta-nav")).rejects.toThrow("401")
    expect(() => new Statsig({})).toThrow(NotConfigured)
  })
})

describe("LaunchDarkly: the internal segment and metrics", () => {
  const state: any = {
    key: "login-v2",
    variations: [{ _id: "v-true", value: true }, { _id: "v-false", value: false }],
    environments: { production: { on: false, fallthrough: { variation: 1 }, rules: [] } },
  }
  const server = Bun.serve({
    port: 0,
    async fetch(req) {
      const u = new URL(req.url)
      if (req.headers.get("authorization") !== "tok") return new Response("no", { status: 401 })
      if (u.pathname === "/api/v2/flags/default/login-v2/experiments/production/errors") {
        expect(req.headers.get("ld-api-version")).toBe("beta")
        return Response.json({ totals: [{ cumulativeValue: 30, cumulativeCount: 10 }, { cumulativeValue: 5, cumulativeCount: 10 }] })
      }
      if (u.pathname === "/api/v2/flags/default/login-v2/experiments/production/signup") return Response.json({ totals: [{ cumulativeConversionRate: 0.4 }, { cumulativeConversionRate: 0.3 }] })
      if (u.pathname !== "/api/v2/flags/default/login-v2") return new Response("nope", { status: 404 })
      if (req.method === "GET") return Response.json(state)
      const body = await req.json()
      const e = state.environments.production
      for (const i of body.instructions) {
        if (i.kind === "turnFlagOn") e.on = true
        else if (i.kind === "turnFlagOff") e.on = false
        else if (i.kind === "addRule") e.rules.push({ _id: `r${e.rules.length}`, description: i.description, clauses: i.clauses, variation: state.variations.findIndex((v: any) => v._id === i.variationId) })
        else if (i.kind === "updateFallthroughVariationOrRollout") e.fallthrough = i.variationId ? { variation: state.variations.findIndex((v: any) => v._id === i.variationId) } : { rollout: { variations: Object.entries(i.rolloutWeights).map(([id, w]) => ({ variation: state.variations.findIndex((v: any) => v._id === id), weight: w })) } }
      }
      return Response.json(state)
    },
  })
  afterAll(() => server.stop(true))
  const env = { LAUNCHDARKLY_API_TOKEN: "tok", LAUNCHDARKLY_BASE_URL: `http://127.0.0.1:${server.port}`, LAUNCHDARKLY_INTERNAL_SEGMENT: "staff", LAUNCHDARKLY_METRICS: "errors,signup" }
  test("internal adds the segment rule once; metrics are the true variation's", async () => {
    const ld = new LaunchDarkly(env)
    await ld.set("login-v2", "internal", "ramp")
    await ld.set("login-v2", "10%", "ramp")
    expect(state.environments.production.rules).toHaveLength(1)
    expect(state.environments.production.rules[0]).toMatchObject({ description: "crosstalk: internal", variation: 0, clauses: [{ op: "segmentMatch", values: ["staff"] }] })
    expect(await ld.get("login-v2")).toBe("10%")
    expect(await ld.metrics("login-v2")).toEqual({ errors: 3, signup: 0.4 })
    expect(await new LaunchDarkly({ ...env, LAUNCHDARKLY_METRICS: "" }).metrics("login-v2")).toBeUndefined()
  })
})

// --- the engine --------------------------------------------------------------------------------------

class MemPort implements ThreadPort {
  label: string
  threads: Map<string, import("../src/threads/model.ts").Thread>
  placed = new Map<string, string>()
  sessions = new Map<string, import("../src/shipping/engine.ts").SessionInfo>()
  notes: string[] = []
  constructor(public me = "fp-me", label = "paul", shared?: Map<string, any>) {
    this.label = label
    this.threads = shared ?? new Map()
  }
  get = (id: string) => this.threads.get(id)
  find = (sid: string | undefined, nm?: string) => {
    if (!nm) return sid ? this.threads.get(this.placed.get(sid) ?? "") : undefined
    return [...this.threads.values()].find((t) => t.id === nm || t.meta.value.name === M.slug(nm))
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

function engineWith(o: { port?: MemPort; identity?: any; peers?: Peer[] } = {}) {
  const port = o.port ?? new MemPort()
  const asked: Question[] = []
  const woke: { sid: string; text: string }[] = []
  const launches: any[] = []
  const clock = { offset: 0 }
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
    allowed: () => true,
    now: () => Date.now() + clock.offset,
    identity: () => o.identity ?? null,
    peers: () => o.peers ?? [],
  })
  return { e, port, asked, woke, launches, clock }
}

const HOUR = 3_600_000
const flagsOn = (dir: string) => F.parseFlags(G.show(dir, "main", F.FLAGS_FILE) ?? "").flags

describe("the engine: preview, dark, metrics, auto-kill", () => {
  test("a risky feature: preview with its flag on as evidence; dark with shadow mismatches as evidence; a regression turns it off and reopens the thread", async () => {
    const S = path.join(TMP, "s1")
    fs.mkdirSync(S, { recursive: true })
    fs.writeFileSync(path.join(S, "m-pay-v2.json"), '{"errors": 2, "latency_p95": 100}')
    const ship = [
      "push: local",
      "ramp: dark internal on",
      `preview: echo "$CROSSTALK_FLAGS" >${S}/pv-env; echo "Deployed https://{branch}.preview.test"`,
      `preview_check: echo "$PREVIEW_URL" >${S}/pc-url; echo "checkout e2e: 3 pass"`,
      `preview_teardown: echo "$PREVIEW_URL" >${S}/td-url`,
      `metrics: cat ${S}/m-$CROSSTALK_FLAG.json`,
      "regress: errors:+50% shadow_mismatch_rate:>0.05",
      "dwell: 1h",
    ].join("\n")
    const { dir } = repo({ "README.md": "hi\n", ".crosstalk/ship": ship, ".crosstalk/risk": "high: src/pay/**\n" })
    const wt = commitOn(dir, "crosstalk/pay", "src/pay/charge.ts", "export const charge = 2\n")
    const { e, port, launches, asked, woke, clock } = engineWith()
    const t = port.open({ name: "pay", repo: "r" })
    port.placed.set("s", t.id)
    port.sessions.set("s", { sessionId: "s", name: "pay", cwd: wt, root: wt, branch: "crosstalk/pay" })
    expect(await e.feature("s", { name: "pay v2" })).toMatchObject({ risk: "risky", flag: "pay-v2" })
    await e.ready("s", { feature: "pay v2" })
    for (const l of launches) await e.review({ run: l.run, secret: l.secret, verdict: "approve", findings: "none" })
    // The preview ran with the flag forced on, its check got the URL, and it is evidence.
    const f = () => port.get(t.id)!.features["pay-v2"]
    expect(f().ship?.state).toBe("needs-evidence")
    expect(fs.readFileSync(path.join(S, "pv-env"), "utf8").trim()).toBe("pay-v2=on")
    expect(fs.readFileSync(path.join(S, "pc-url"), "utf8").trim()).toBe("https://crosstalk-pay.preview.test")
    expect(f().ship?.preview).toMatchObject({ url: "https://crosstalk-pay.preview.test", ok: true })
    const pev = f().ship!.evidence!.find((x) => x.stage === "preview")!
    expect(pev.summary).toContain("forced on")
    expect(pev.tests?.join()).toContain("checkout e2e: 3 pass")
    // The author's evidence; the merge question shows both.
    await e.evidence("s", { feature: "pay v2", summary: "Charges are retried once on a timeout.", tests: ["charge.test: 5 pass"] })
    const mq = asked.find((q) => q.kind === "merge")!
    expect(mq.text).toContain("https://crosstalk-pay.preview.test")
    expect(mq.text).toContain("retried once")
    await e.answer(mq.id, "Merge it", { person: true })
    expect(f().ship?.state).toBe("merged")
    expect(fs.readFileSync(path.join(S, "td-url"), "utf8").trim()).toBe("https://crosstalk-pay.preview.test")
    expect(f().ship?.preview?.down).toBe(true)
    // The first step is dark.
    const q1 = asked.find((q) => q.kind === "ramp")!
    expect(q1.stage).toBe("dark")
    expect(q1.text).toContain("in shadow")
    await e.answer(q1.id, "yes", { person: true })
    expect(flagsOn(dir)["pay-v2"]).toBe("dark")
    // Shadow mismatches are counted, never a kill.
    const s1 = await e.incident({ source: "shadow", title: "amount differs", details: "calls=200", flag: "pay-v2" })
    expect(s1.text).toContain("1 mismatch in 200 calls")
    await e.incident({ source: "shadow", title: "amount differs", details: "", flag: "pay-v2" })
    expect(flagsOn(dir)["pay-v2"]).toBe("dark")
    expect(s1.killed).toBeUndefined()
    expect(s1.reopened).toBeUndefined()
    // Before the dwell nothing moves; after it, the mismatch rate is the evidence for internal.
    clock.offset = 30 * 60_000
    expect((await e.watch()).text).toContain("to go")
    expect(asked.filter((q) => q.kind === "ramp").length).toBe(1)
    clock.offset = 2 * HOUR
    await e.watch()
    const q2 = asked.filter((q) => q.kind === "ramp")[1]
    expect(q2.stage).toBe("internal")
    expect(q2.text).toContain("shadow_mismatches 2")
    expect(q2.text).toContain("shadow_mismatch_rate 0.01")
    await e.answer(q2.id, "yes", { person: true })
    expect(flagsOn(dir)["pay-v2"]).toBe("internal")
    expect(M.live(port.get(t.id)!, "facts").map((x) => x.text).join("\n")).toContain("Baseline before the step: errors 2")
    // A regression: errors 2 → 9. Off, everyone told, the thread reopened.
    M.setMeta(port.get(t.id)!, "x", { status: "done" })
    fs.writeFileSync(path.join(S, "m-pay-v2.json"), '{"errors": 9, "latency_p95": 100}')
    clock.offset = 2 * HOUR + 5 * 60_000
    const w = await e.watch()
    expect(w.text).toContain("errors went from 2 to 9")
    expect(flagsOn(dir)["pay-v2"]).toBe("off")
    expect(port.get(t.id)!.meta.value.status).toBe("active")
    expect(M.live(port.get(t.id)!, "tasks").map((x) => x.text).join()).toContain("regressed")
    expect(port.notes.at(-1)).toContain("turned off by itself")
    expect(woke.at(-1)!.text).toContain("<crosstalk-metrics")
    expect((await e.watch()).text).toBe("no flag is ramping")
  })

  test("a failing preview check goes back to the author, like a red check", async () => {
    const { dir } = repo({ "README.md": "hi\n", ".crosstalk/ship": "push: local\npreview: echo https://p.test\npreview_check: echo 'login button missing'; exit 1\n", ".crosstalk/risk": "high: src/**\n" })
    const wt = commitOn(dir, "crosstalk/x", "src/x.ts", "x\n")
    const { e, port, launches, woke } = engineWith()
    const t = port.open({ name: "x", repo: "r" })
    port.placed.set("s", t.id)
    port.sessions.set("s", { sessionId: "s", name: "x", cwd: wt, root: wt, branch: "crosstalk/x" })
    await e.ready("s", { feature: "x" })
    for (const l of launches) await e.review({ run: l.run, secret: l.secret, verdict: "approve", findings: "none" })
    expect(port.get(t.id)!.features["x"].ship?.state).toBe("red")
    expect(woke.at(-1)!.text).toContain("login button missing")
  })

  test("an everyday flag: internal on merge, everyone by itself once its metrics hold for the dwell; without metrics it waits", async () => {
    const S = path.join(TMP, "s2")
    fs.mkdirSync(S, { recursive: true })
    fs.writeFileSync(path.join(S, "m-banner.json"), '{"errors": 1}')
    const { dir } = repo({ "README.md": "hi\n", ".crosstalk/ship": `push: local\nmetrics: test -f ${S}/m-$CROSSTALK_FLAG.json && cat ${S}/m-$CROSSTALK_FLAG.json\ndwell: 1h\n` })
    const wt = commitOn(dir, "crosstalk/banner", "banner.txt", "hello\n")
    const { e, port, launches, clock, woke } = engineWith()
    const t = port.open({ name: "banner", repo: "r" })
    port.placed.set("s", t.id)
    port.sessions.set("s", { sessionId: "s", name: "banner", cwd: wt, root: wt, branch: "crosstalk/banner" })
    await e.feature("s", { name: "banner", flag: "banner" })
    await e.ready("s", { feature: "banner" })
    await e.review({ run: launches[0].run, secret: launches[0].secret, verdict: "approve", findings: "none" })
    expect(flagsOn(dir).banner).toBe("internal")
    clock.offset = 59 * 60_000
    await e.watch()
    expect(flagsOn(dir).banner).toBe("internal")
    clock.offset = 61 * 60_000
    expect((await e.watch()).text).toContain("banner internal → on")
    expect(flagsOn(dir).banner).toBe("on")
    expect(port.get(t.id)!.features["banner"].ship?.state).toBe("shipped")
    expect(port.notes.join("\n")).toContain("went from internal to on by itself")
    // A second one with no metrics stays at internal, and the author hears once.
    const wt2 = commitOn(dir, "crosstalk/promo", "promo.txt", "hi\n")
    port.sessions.set("s", { sessionId: "s", name: "banner", cwd: wt2, root: wt2, branch: "crosstalk/promo" })
    await e.feature("s", { name: "promo", flag: "promo", branch: "crosstalk/promo" })
    await e.ready("s", { feature: "promo" })
    await e.review({ run: launches.at(-1).run, secret: launches.at(-1).secret, verdict: "approve", findings: "none" })
    expect(flagsOn(dir).promo).toBe("internal")
    clock.offset = 5 * HOUR
    await e.watch()
    await e.watch()
    expect(flagsOn(dir).promo).toBe("internal")
    expect(woke.filter((w) => w.text.includes("no metrics to judge it by")).length).toBe(1)
  })
})

// --- answers from another machine --------------------------------------------------------------------------

describe("a shipping question answered from another person's machine", () => {
  const ana = newIdentity("ana")
  const ben = newIdentity("ben")
  const bot = newIdentity("ci-bot")
  const fpA = fingerprint(ana.ed.pub)
  const fpB = fingerprint(ben.ed.pub)
  const peer = (id: any, extra: Partial<Peer> = {}): Peer => ({ label: id.label, edPub: id.ed.pub, xPub: id.x.pub, fingerprint: fingerprint(id.ed.pub), joinedAt: 0, ...extra })

  function setup(o: { peers?: Peer[]; inThread?: boolean } = {}) {
    const shared = new Map()
    const A = engineWith({ port: new MemPort(fpA, "ana", shared), identity: ana, peers: o.peers ?? [peer(ben)] })
    const B = engineWith({ port: new MemPort(fpB, "ben", shared), identity: ben, peers: [peer(ana)] })
    const t = A.port.open({ name: "auth", repo: "r" })
    if (o.inThread !== false) M.put(t, "people", fpB, { label: "ben" }, fpB)
    A.port.placed.set("sa", t.id)
    return { A, B, t }
  }
  const askLower = async (A: ReturnType<typeof engineWith>) => {
    await A.e.feature("sa", { name: "login v2", risk: "risky", why: "auth" })
    const r = await A.e.feature("sa", { name: "login v2", risk: "everyday", why: "small" })
    return String(r.question)
  }

  test("the question is on the thread with its options; ben's signed answer is taken by ana's machine", async () => {
    const { A, B, t } = setup()
    const qid = await askLower(A)
    expect(t.questions[qid].ship).toMatchObject({ kind: "lower", asker: fpA, options: ["Keep it risky", "Make it everyday"] })
    expect(B.e.elsewhere().map((q) => q.id)).toEqual([qid])
    expect(A.e.elsewhere()).toEqual([])
    // An agent on ben's machine cannot; ben can.
    expect((await B.e.answer(qid, "Make it everyday", { person: false })).ok).toBe(false)
    const r = await B.e.answer(qid, "everyday", { person: false })
    expect(r.ok).toBe(false)
    const b = await B.e.answer(qid, "Make it everyday", { person: true })
    expect(b).toMatchObject({ ok: true, remote: true })
    expect(b.text).toContain("ana")
    expect(t.questions[qid].vote).toMatchObject({ pick: "Make it everyday", fp: fpB, label: "ben" })
    // Nothing happens on ben's side; ana's machine takes it.
    expect(t.features["login-v2"].risk).toBe("risky")
    const done = await A.e.pollVotes()
    expect(done[0]).toMatchObject({ ok: true, text: "login v2 is everyday now" })
    expect(t.features["login-v2"].risk).toBe("everyday")
    expect(t.questions[qid]).toMatchObject({ answer: "Make it everyday", answeredBy: "ben" })
    expect(A.e.open()).toEqual([])
    expect((await B.e.answer(qid, "Keep it risky", { person: true })).text).toContain("already answered")
  })

  test("not taken: a bot, someone untrusted, someone not in the thread, a forged signature, an answer written straight onto the item", async () => {
    const cases: [string, ReturnType<typeof setup>, (t: any, q: string) => void][] = [
      ["not a person", setup({ peers: [peer(ben, { isMachine: true })] }), () => {}],
      ["not someone this machine trusts", setup({ peers: [] }), () => {}],
      ["not in the thread", setup({ inThread: false }), (t) => M.put(t, "people", fpB, { label: "ben" }, fpB)],
      ["signature", setup(), () => {}],
    ]
    for (const [why, { A, B, t }, before] of cases) {
      const qid = await askLower(A)
      before(t, qid)
      await B.e.answer(qid, "Make it everyday", { person: true })
      if (why === "not in the thread") M.remove(t, "people", fpB, fpB)
      if (why === "signature") {
        const it = t.questions[qid]
        it.vote = { ...it.vote!, pick: "Keep it risky" }
        it.vote.pick = "Make it everyday"
        it.vote.sig = Rm.signVote(bot, t.id, qid, "Make it everyday", it.vote.at).sig
      }
      await A.e.pollVotes()
      expect(t.features["login-v2"].risk).toBe("risky")
      expect(A.e.open().length).toBe(1)
      expect(A.port.notes.at(-1)).toContain(why)
      // Looked at once, not on every poll.
      const before2 = A.port.notes.length
      await A.e.pollVotes()
      expect(A.port.notes.length).toBe(before2)
    }
    // Someone writing `answer` onto the item (an agent's crosstalk_thread, a rule) answers nothing.
    const { A, t } = setup()
    const qid = await askLower(A)
    M.put(t, "questions", qid, { ...t.questions[qid], answer: "Make it everyday", answeredBy: "a rule" } as any, fpB)
    await A.e.pollVotes()
    expect(t.features["login-v2"].risk).toBe("risky")
    expect(A.e.question(qid)).toBeTruthy()
  })

  test("checkVote on its own", () => {
    const t = M.create({ name: "x", repo: "r", by: fpA, label: "ana" })
    M.put(t, "people", fpB, { label: "ben" }, fpB)
    const v = Rm.signVote(ben, t.id, "q1", "Merge it", 5)
    expect(Rm.checkVote({ thread: t, question: "q1", vote: v, options: ["Merge it", "Not yet"], me: fpA, peers: [peer(ben)] })).toEqual({ ok: true, who: "ben" })
    expect(Rm.checkVote({ thread: t, question: "q2", vote: v, options: ["Merge it"], me: fpA, peers: [peer(ben)] }).ok).toBe(false)
    expect(Rm.checkVote({ thread: t, question: "q1", vote: v, options: ["Not yet"], me: fpA, peers: [peer(ben)] }).ok).toBe(false)
    expect(Rm.checkVote({ thread: t, question: "q1", vote: Rm.signVote(ana, t.id, "q1", "Merge it", 5), options: ["Merge it"], me: fpA, peers: [peer(ben)] }).ok).toBe(false)
  })
})

// --- the crosstalk-flags helpers in docs/shipping.md ----------------------------------------------------

describe("the crosstalk-flags helpers, as the docs give them", () => {
  const doc = fs.readFileSync(path.join(import.meta.dir, "..", "docs", "shipping.md"), "utf8")
  const snippet = (name: string) => {
    const start = doc.indexOf(`<!-- ${name} -->`)
    const end = doc.indexOf(`<!-- /${name} -->`)
    if (start < 0 || end < 0) throw new Error(`no ${name} in docs/shipping.md`)
    const block = doc.slice(start, end)
    return block.slice(block.indexOf("\n", block.indexOf("```")) + 1, block.lastIndexOf("```"))
  }
  test("JS/TS: stages from CROSSTALK_FLAGS and the flags file; dark runs both and counts mismatches", async () => {
    const dir = path.join(TMP, "helper-ts")
    fs.mkdirSync(dir, { recursive: true })
    fs.writeFileSync(path.join(dir, "crosstalk-flags.ts"), snippet("crosstalk-flags.ts"))
    fs.writeFileSync(path.join(dir, "flags"), "pricing: dark\nbanner: 20%\nlogin: internal\n")
    process.env.CROSSTALK_FLAGS_FILE = path.join(dir, "flags")
    process.env.CROSSTALK_SHADOW_DIR = path.join(dir, "shadow")
    process.env.CROSSTALK_FLAGS = "preview-only=on"
    try {
      const h = await import(path.join(dir, "crosstalk-flags.ts"))
      expect(h.stage("pricing")).toBe("dark")
      expect(h.stage("preview-only")).toBe("on")
      expect(h.stage("missing")).toBe("off")
      expect(h.isOn("banner", { bucket: 10 })).toBe(true)
      expect(h.isOn("banner", { bucket: 50 })).toBe(false)
      expect(h.isOn("login", { internal: true })).toBe(true)
      expect(h.isOn("login", {})).toBe(false)
      let ranNew = 0
      const a = await h.flagged("pricing", { old: () => 10, new: () => (ranNew++, 10) })
      const b = await h.flagged("pricing", { old: () => 10, new: () => (ranNew++, 11) })
      const c = await h.flagged("pricing", {
        old: () => 10,
        new: () => {
          throw new Error("boom")
        },
      })
      expect([a, b, c, ranNew]).toEqual([10, 10, 10, 2])
      expect(Sh.readCounter(path.join(dir, "shadow"), "pricing")).toEqual({ calls: 3, mismatches: 2 })
      expect(await h.flagged("preview-only", { old: () => "old", new: () => "new" })).toBe("new")
      expect(await h.flagged("pricing", { old: () => "old", new: () => "new" }, { stage: "on" })).toBe("new")
    } finally {
      delete process.env.CROSSTALK_FLAGS_FILE
      delete process.env.CROSSTALK_SHADOW_DIR
      delete process.env.CROSSTALK_FLAGS
    }
  })
  test("Python: the same", () => {
    if (spawnSync("python3", ["--version"]).status !== 0) return
    const dir = path.join(TMP, "helper-py")
    fs.mkdirSync(dir, { recursive: true })
    fs.writeFileSync(path.join(dir, "crosstalk_flags.py"), snippet("crosstalk_flags.py"))
    fs.writeFileSync(path.join(dir, "flags"), '{"pricing": "dark", "banner": "20%"}')
    const prog = [
      "import sys, json",
      "sys.path.insert(0, sys.argv[1])",
      "import crosstalk_flags as f",
      "out = [f.stage('pricing'), f.is_on('banner', bucket=5), f.is_on('banner', bucket=50)]",
      "out += [f.flagged('pricing', lambda: 1, lambda: 1), f.flagged('pricing', lambda: 1, lambda: 2), f.flagged('pricing', lambda: 1, lambda: 1/0)]",
      "print(json.dumps(out))",
    ].join("\n")
    const r = spawnSync("python3", ["-I", "-c", prog, dir], { encoding: "utf8", env: { ...process.env, CROSSTALK_FLAGS_FILE: path.join(dir, "flags"), CROSSTALK_SHADOW_DIR: path.join(dir, "shadow") } })
    expect(r.stderr).toBe("")
    expect(JSON.parse(r.stdout)).toEqual(["dark", true, false, 1, 1, 1])
    expect(Sh.readCounter(path.join(dir, "shadow"), "pricing")).toEqual({ calls: 3, mismatches: 2 })
  })
})
