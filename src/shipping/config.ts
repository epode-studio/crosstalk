// How a repo ships, from `.crosstalk/ship`. Every line is optional:
//
//   test: bun run test           # the check a branch must pass; found if absent
//   push: direct                 # direct | pr | local (see merge.ts)
//   rounds: 3                    # author/reviewer rounds before people are asked
//   ramp: internal 10% 50% on    # the flag steps of a risky feature
//   flags: file                  # file | launchdarkly | posthog | growthbook | statsig
//   incident_days: 14            # how recent a ship counts for an incident
//   reviewer_model: sonnet       # claude --model for the everyday reviewer
//   adversarial_model: opus      # claude --model when codex is not installed
//   adversarial: auto            # auto | codex | claude
//   test_timeout: 900            # seconds
//
// The test command, when not named, is the first of: package.json's test
// script (run with the package manager its lockfile names), a Makefile's
// test target, pytest for a Python project. None found means there is no
// check to run, and the result says so.

import fs from "node:fs"
import path from "node:path"

export type PushMode = "direct" | "pr" | "local"
export type ProviderName = "file" | "launchdarkly" | "posthog" | "growthbook" | "statsig"

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
}

export const SHIP_FILE = ".crosstalk/ship"
export const DEFAULT_RAMP = ["internal", "10%", "50%", "on"]
const PROVIDERS: ProviderName[] = ["file", "launchdarkly", "posthog", "growthbook", "statsig"]

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
