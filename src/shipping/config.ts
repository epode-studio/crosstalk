// How a repo ships, from `.crosstalk/ship`. Every line is optional:
//
//   test: bun run test           # the check a branch must pass; found if absent
//   push: direct                 # direct | pr | local (see merge.ts)
//   rounds: 3                    # author/reviewer rounds before people are asked
//   ramp: dark internal 10% 50% on  # the flag steps of a risky feature
//   everyday_ramp: internal on   # an everyday feature's flag, moved by itself while metrics hold
//   flags: file                  # file | unleash | launchdarkly | posthog | growthbook | statsig
//   incident_days: 14            # how recent a ship counts for an incident
//   reviewer_model: sonnet       # claude --model for the everyday reviewer
//   adversarial_model: opus      # claude --model when codex is not installed
//   adversarial: auto            # auto | codex | claude
//   test_timeout: 900            # seconds
//   preview: vercel deploy --prebuilt     # a risky branch's preview deploy, its flag forced on
//   preview_check: npx playwright test    # an e2e check against $PREVIEW_URL
//   preview_teardown: vercel rm {url} -y  # when it has merged
//   preview_timeout: 900         # seconds, for each of those three
//   metrics: ./metrics.sh        # prints JSON {"errors": 3, "latency_p95": 120, ...} for $CROSSTALK_FLAG
//   regress: errors:+50% latency_p95:+20% shadow_mismatch_rate:>0.01
//   dwell: 1h                    # how long metrics must hold at a stage before the next
//   shadow: .crosstalk/shadow    # a folder of <flag>.json counters {calls, mismatches}
//
// The test command, when not named, is the first of: package.json's test
// script (run with the package manager its lockfile names), a Makefile's
// test target, pytest for a Python project. None found means there is no
// check to run, and the result says so.

import fs from "node:fs"
import path from "node:path"

export type PushMode = "direct" | "pr" | "local"
export type ProviderName = "file" | "unleash" | "launchdarkly" | "posthog" | "growthbook" | "statsig"

/**
 * One regression rule. `+N%`: the metric rose more than N% over the baseline
 * taken before the step. `-N%`: it fell more than N% (for things where more
 * is better). `>X`: it is above X whatever the baseline (`>N%` is X = N/100).
 * A name of `*` applies to every metric no other rule names.
 */
export type Threshold = { metric: string; kind: "rise" | "fall" | "above"; value: number }

export type ShipConfig = {
  test?: string
  push?: PushMode
  rounds: number
  ramp: string[]
  flags: ProviderName
  incidentDays: number
  reviewerModel?: string
  adversarialModel?: string
  adversarial: "auto" | "codex" | "claude"
  testTimeoutS: number
  /** An everyday feature's flag steps, taken by themselves while metrics hold. */
  everydayRamp: string[]
  preview?: string
  previewCheck?: string
  previewTeardown?: string
  previewTimeoutS: number
  metrics?: string
  regress: Threshold[]
  dwellMs: number
  shadow?: string
}

export const SHIP_FILE = ".crosstalk/ship"
export const DEFAULT_RAMP = ["dark", "internal", "10%", "50%", "on"]
export const DEFAULT_EVERYDAY_RAMP = ["internal", "on"]
export const DEFAULT_REGRESS = "*:+50% shadow_mismatch_rate:>0.01"
const PROVIDERS: ProviderName[] = ["file", "unleash", "launchdarkly", "posthog", "growthbook", "statsig"]

export function parseRegress(text: string): Threshold[] {
  const out: Threshold[] = []
  for (const tok of text.split(/[\s,]+/).filter(Boolean)) {
    const m = /^([A-Za-z0-9_.*-]+)[:=]([+>-])(\d+(?:\.\d+)?)(%?)$/.exec(tok)
    if (!m) continue
    const v = Number(m[3])
    if (m[2] === ">") out.push({ metric: m[1], kind: "above", value: m[4] ? v / 100 : v })
    else out.push({ metric: m[1], kind: m[2] === "+" ? "rise" : "fall", value: v / 100 })
  }
  return out
}

/** "1h", "30m", "90s", "2d", "500ms", or plain seconds. */
export function parseDuration(text: string | undefined, dflt: number): number {
  const m = /^(\d+(?:\.\d+)?)\s*(ms|s|m|h|d)?$/.exec((text ?? "").trim().toLowerCase())
  if (!m) return dflt
  const unit: Record<string, number> = { ms: 1, s: 1000, m: 60_000, h: 3_600_000, d: 86_400_000 }
  return Math.round(Number(m[1]) * unit[m[2] ?? "s"])
}

const steps = (v: string) => v.split(/[\s,→>]+/).filter(Boolean)

export function parseShip(text: string): ShipConfig {
  const kv: Record<string, string> = {}
  for (const raw of text.split("\n")) {
    const line = raw.replace(/(^|\s)#.*$/, "").trim()
    const m = /^([a-z_]+)\s*:\s*(.*)$/i.exec(line)
    if (m) kv[m[1].toLowerCase()] = m[2].trim()
  }
  const push = kv.push as PushMode
  const flags = (kv.flags ?? kv.flag_provider ?? "file").toLowerCase() as ProviderName
  const adv = (kv.adversarial ?? "auto").toLowerCase()
  return {
    ...(kv.test ? { test: kv.test } : {}),
    ...(["direct", "pr", "local"].includes(push) ? { push } : {}),
    rounds: Math.max(1, Math.min(10, Number(kv.rounds) || 3)),
    ramp: kv.ramp ? kv.ramp.split(/[\s,→>-]+/).filter(Boolean) : DEFAULT_RAMP,
    flags: PROVIDERS.includes(flags) ? flags : "file",
    incidentDays: Math.max(1, Number(kv.incident_days) || 14),
    ...(kv.reviewer_model ? { reviewerModel: kv.reviewer_model } : {}),
    ...(kv.adversarial_model ? { adversarialModel: kv.adversarial_model } : {}),
    adversarial: adv === "codex" || adv === "claude" ? adv : "auto",
    testTimeoutS: Math.max(5, Number(kv.test_timeout) || 900),
    everydayRamp: kv.everyday_ramp ? steps(kv.everyday_ramp) : DEFAULT_EVERYDAY_RAMP,
    ...(kv.preview ? { preview: kv.preview } : {}),
    ...(kv.preview_check ? { previewCheck: kv.preview_check } : {}),
    ...(kv.preview_teardown ? { previewTeardown: kv.preview_teardown } : {}),
    previewTimeoutS: Math.max(5, Number(kv.preview_timeout) || 900),
    ...(kv.metrics ? { metrics: kv.metrics } : {}),
    regress: parseRegress(kv.regress ?? DEFAULT_REGRESS),
    dwellMs: parseDuration(kv.dwell, 3_600_000),
    ...(kv.shadow ? { shadow: kv.shadow } : {}),
  }
}

export function loadShip(root: string): ShipConfig {
  try {
    return parseShip(fs.readFileSync(path.join(root, SHIP_FILE), "utf8"))
  } catch {
    return parseShip("")
  }
}

/** npm's placeholder when nobody wrote a test script. */
const NPM_PLACEHOLDER = /no test specified/

export function discoverTest(root: string, exists = (p: string) => fs.existsSync(p), read = (p: string) => fs.readFileSync(p, "utf8")): string | undefined {
  const at = (f: string) => path.join(root, f)
  try {
    const pkg = JSON.parse(read(at("package.json")))
    const t = pkg?.scripts?.test
    if (typeof t === "string" && t.trim() && !NPM_PLACEHOLDER.test(t)) {
      if (exists(at("bun.lock")) || exists(at("bun.lockb"))) return "bun run test"
      if (exists(at("pnpm-lock.yaml"))) return "pnpm test"
      if (exists(at("yarn.lock"))) return "yarn test"
      return "npm test"
    }
  } catch {}
  for (const mk of ["Makefile", "makefile", "GNUmakefile"])
    try {
      if (/^test\s*:/m.test(read(at(mk)))) return "make test"
    } catch {}
  for (const f of ["pytest.ini", "conftest.py"]) if (exists(at(f))) return "pytest -q"
  for (const f of ["pyproject.toml", "setup.cfg", "tox.ini"])
    try {
      if (/pytest/.test(read(at(f)))) return "pytest -q"
    } catch {}
  return undefined
}

/** The command to run on a branch: the repo's own word first. */
export const testCommand = (root: string, cfg: ShipConfig) => cfg.test ?? discoverTest(root)
