// Unleash feature toggles, through the Admin API (Unleash v5 and later,
// self-hosted or Unleash Cloud).
//
//   UNLEASH_URL                   the instance, e.g. https://unleash.example.com or
//                                 https://<region>.app.unleash-hosted.com/<instance> (required;
//                                 a trailing /api is fine)
//   UNLEASH_ADMIN_TOKEN           an admin or personal access token (required), sent as Authorization
//   UNLEASH_PROJECT               default "default"
//   UNLEASH_ENVIRONMENT           default "production"
//   UNLEASH_INTERNAL_SEGMENT      a segment id holding your own accounts, or
//   UNLEASH_INTERNAL_CONSTRAINT   a constraint, e.g. "email ENDS_WITH @company.com"
//                                 (<context field> <operator> <value>[,<value>...]; operators are
//                                 Unleash's: IN, NOT_IN, STR_ENDS_WITH, STR_STARTS_WITH,
//                                 STR_CONTAINS, ..., and ENDS_WITH, STARTS_WITH, CONTAINS for short)
//   UNLEASH_STICKINESS            what a percentage sticks to, default "default"
//
// Stages map onto the toggle's strategies in that environment. crosstalk only
// touches strategies whose title starts "crosstalk:"; yours stay.
//
//   off        the environment disabled: the instant kill
//   dark       enabled; one flexibleRollout at 100% carrying a variant named
//              "dark" (payload "crosstalk-stage=dark"). The app's shadow helper
//              reads it: getVariant(toggle).name === "dark" means run the new
//              path in shadow and use the old one's result. NB: isEnabled() is
//              true at dark, so check the variant before isEnabled (the
//              crosstalk-flags helper in docs/shipping.md does)
//   internal   enabled; flexibleRollout 100% constrained to the internal
//              segment or constraint
//   N%         that, plus flexibleRollout N% for everyone
//   on         enabled; flexibleRollout 100% for everyone (the default strategy)
//
// A toggle Unleash does not have is created (type release), its environment off.
//
// Metrics: exposures from GET /api/admin/client-metrics/features/:name (the
// last hour's yes and no counts in the environment): exposures_yes,
// exposures_no, exposures. They are data for the question, not health:
// errors and latency come from `metrics:` in .crosstalk/ship.

import type { Stage } from "../flags.ts"
import { percent } from "../flags.ts"
import { call, NotConfigured, type Env, type Fetch, type FlagProvider } from "./types.ts"

export type Constraint = { contextName: string; operator: string; values?: string[]; value?: string; caseInsensitive?: boolean; inverted?: boolean }
export type Strategy = {
  id?: string
  name: string
  title?: string
  disabled?: boolean
  parameters?: Record<string, string>
  constraints?: Constraint[]
  segments?: number[]
  variants?: { name: string; weight: number; weightType: string; stickiness: string; payload?: { type: string; value: string } }[]
}

const MINE = "crosstalk:"
const OPS: Record<string, string> = { ENDS_WITH: "STR_ENDS_WITH", STARTS_WITH: "STR_STARTS_WITH", CONTAINS: "STR_CONTAINS" }
const SINGLE = new Set(["NUM_EQ", "NUM_GT", "NUM_GTE", "NUM_LT", "NUM_LTE", "DATE_AFTER", "DATE_BEFORE", "SEMVER_EQ", "SEMVER_GT", "SEMVER_LT"])

/** "email ENDS_WITH @company.com" → an Unleash constraint. */
export function parseConstraint(text: string): Constraint {
  const m = /^\s*(\S+)\s+(\S+)\s+(.+?)\s*$/.exec(text)
  if (!m) throw new NotConfigured(`UNLEASH_INTERNAL_CONSTRAINT should read "<field> <operator> <value>", e.g. "email ENDS_WITH @company.com"; got "${text}"`)
  const op = OPS[m[2].toUpperCase()] ?? m[2].toUpperCase()
  const values = m[3].split(",").map((v) => v.trim()).filter(Boolean)
  if (SINGLE.has(op)) return { contextName: m[1], operator: op, value: values[0], inverted: false }
  return { contextName: m[1], operator: op, values, caseInsensitive: op.startsWith("STR_"), inverted: false }
}

export class Unleash implements FlagProvider {
  readonly name = "Unleash"
  readonly instant = true
  private base: string
  private token: string
  private project: string
  private env: string
  private stickiness: string
  private internal?: { segments?: number[]; constraints?: Constraint[] }
  constructor(e: Env, private fetcher: Fetch = fetch as unknown as Fetch) {
    if (!e.UNLEASH_URL || !e.UNLEASH_ADMIN_TOKEN) throw new NotConfigured("Unleash needs UNLEASH_URL and UNLEASH_ADMIN_TOKEN in the daemon's environment")
    this.base = e.UNLEASH_URL.replace(/\/+$/, "").replace(/\/api(\/admin)?$/, "")
    this.token = e.UNLEASH_ADMIN_TOKEN
    this.project = e.UNLEASH_PROJECT ?? "default"
    this.env = e.UNLEASH_ENVIRONMENT ?? "production"
    this.stickiness = e.UNLEASH_STICKINESS ?? "default"
    if (e.UNLEASH_INTERNAL_SEGMENT) {
      const id = Number(e.UNLEASH_INTERNAL_SEGMENT)
      if (!Number.isInteger(id)) throw new NotConfigured("UNLEASH_INTERNAL_SEGMENT is a segment's numeric id")
      this.internal = { segments: [id] }
    } else if (e.UNLEASH_INTERNAL_CONSTRAINT) this.internal = { constraints: [parseConstraint(e.UNLEASH_INTERNAL_CONSTRAINT)] }
  }

  private h = (json = false) => ({ Authorization: this.token, Accept: "application/json", ...(json ? { "Content-Type": "application/json" } : {}) })
  private p = (rest = "") => `${this.base}/api/admin/projects/${encodeURIComponent(this.project)}/features${rest}`
  private envUrl = (flag: string, rest = "") => this.p(`/${encodeURIComponent(flag)}/environments/${encodeURIComponent(this.env)}${rest}`)

  private async find(flag: string): Promise<any | undefined> {
    try {
      return await call(this.fetcher, this.p(`/${encodeURIComponent(flag)}`), { headers: this.h() }, `Unleash ${flag}`)
    } catch (e) {
      if (/: 404\b/.test((e as Error).message)) return undefined
      throw e
    }
  }

  private envOf(f: any): { enabled: boolean; strategies: Strategy[] } | undefined {
    const e = (f?.environments ?? []).find((x: any) => x.name === this.env)
    return e ? { enabled: !!e.enabled, strategies: e.strategies ?? [] } : undefined
  }

  async get(flag: string): Promise<Stage | undefined> {
    const f = await this.find(flag)
    if (!f) return undefined
    const e = this.envOf(f)
    if (!e) throw new Error(`Unleash ${flag}: no environment ${this.env} in project ${this.project}`)
    if (!e.enabled) return "off"
    const mine = e.strategies.filter((s) => !s.disabled && (s.title ?? "").startsWith(MINE))
    if (!mine.length) return "on" // enabled with only your own strategies, or the default one
    if (mine.some((s) => (s.variants ?? []).some((v) => v.name === "dark"))) return "dark"
    const open = mine.filter((s) => !(s.constraints ?? []).length && !(s.segments ?? []).length)
    const pct = Math.max(0, ...open.map((s) => Number(s.parameters?.rollout ?? 100)))
    if (pct >= 100) return "on"
    if (pct > 0) return `${pct}%` as Stage
    return mine.some((s) => (s.constraints ?? []).length || (s.segments ?? []).length) ? "internal" : "off"
  }

  private roll = (flag: string, n: number, title: string, extra: Partial<Strategy> = {}): Strategy => ({
    name: "flexibleRollout",
    title: `${MINE} ${title}`,
    disabled: false,
    parameters: { rollout: String(n), stickiness: this.stickiness, groupId: flag },
    constraints: [],
    segments: [],
    ...extra,
  })

  private strategies(flag: string, stage: Stage): Strategy[] {
    if (stage === "on") return [this.roll(flag, 100, "everyone")]
    if (stage === "dark")
      return [this.roll(flag, 100, "dark", { variants: [{ name: "dark", weight: 1000, weightType: "variable", stickiness: this.stickiness, payload: { type: "string", value: "crosstalk-stage=dark" } }] })]
    if (!this.internal) {
      if (stage === "internal") throw new NotConfigured("Unleash needs UNLEASH_INTERNAL_SEGMENT or UNLEASH_INTERNAL_CONSTRAINT to know who internal is")
      return [this.roll(flag, percent(stage), `${stage} of everyone`)]
    }
    const inside = this.roll(flag, 100, "internal", { constraints: this.internal.constraints ?? [], segments: this.internal.segments ?? [] })
    return stage === "internal" ? [inside] : [inside, this.roll(flag, percent(stage), `${stage} of everyone`)]
  }

  async set(flag: string, stage: Stage, why: string): Promise<string> {
    let f = await this.find(flag)
    if (!f) {
      await call(this.fetcher, this.p(), { method: "POST", headers: this.h(true), body: JSON.stringify({ name: flag, type: "release", description: `crosstalk: ${why}`.slice(0, 400), impressionData: false }) }, `Unleash ${flag}`)
      f = await this.find(flag)
    }
    const e = this.envOf(f)
    if (!e) throw new Error(`Unleash ${flag}: no environment ${this.env} in project ${this.project}`)
    if (stage === "off") {
      if (e.enabled) await call(this.fetcher, this.envUrl(flag, "/off"), { method: "POST", headers: this.h() }, `Unleash ${flag}`)
      return `${flag} is off in Unleash (${this.env}), in effect now`
    }
    // Strategies first, so enabling never serves an old one.
    for (const s of e.strategies.filter((s) => (s.title ?? "").startsWith(MINE) && s.id))
      await call(this.fetcher, this.envUrl(flag, `/strategies/${encodeURIComponent(s.id!)}`), { method: "DELETE", headers: this.h() }, `Unleash ${flag}`)
    for (const s of this.strategies(flag, stage)) await call(this.fetcher, this.envUrl(flag, "/strategies"), { method: "POST", headers: this.h(true), body: JSON.stringify(s) }, `Unleash ${flag}`)
    if (!e.enabled) await call(this.fetcher, this.envUrl(flag, "/on"), { method: "POST", headers: this.h() }, `Unleash ${flag}`)
    return `${flag} is ${stage} in Unleash (${this.env}), in effect now`
  }

  async metrics(flag: string): Promise<Record<string, number> | undefined> {
    let r: any
    try {
      r = await call(this.fetcher, `${this.base}/api/admin/client-metrics/features/${encodeURIComponent(flag)}`, { headers: this.h() }, `Unleash metrics ${flag}`)
    } catch (e) {
      if (/: 404\b/.test((e as Error).message)) return undefined
      throw e
    }
    const usage: any[] = (r?.lastHourUsage ?? []).filter((u: any) => !u.environment || u.environment === this.env)
    if (!usage.length) return undefined
    const yes = usage.reduce((a, u) => a + (Number(u.yes) || 0), 0)
    const no = usage.reduce((a, u) => a + (Number(u.no) || 0), 0)
    return { exposures_yes: yes, exposures_no: no, exposures: yes + no }
  }
}
