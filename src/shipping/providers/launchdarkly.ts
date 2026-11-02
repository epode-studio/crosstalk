// LaunchDarkly, through its REST API (v2) with semantic patches.
//
//   LAUNCHDARKLY_API_TOKEN          an API access token with writer rights (required)
//   LAUNCHDARKLY_PROJECT            project key, default "default"
//   LAUNCHDARKLY_ENVIRONMENT        environment key, default "production"
//   LAUNCHDARKLY_BASE_URL           default https://app.launchdarkly.com (tests point it at a mock)
//   LAUNCHDARKLY_INTERNAL_SEGMENT   a segment key holding your own accounts (optional; see internal)
//   LAUNCHDARKLY_METRICS            metric keys to read for the flag, comma separated (optional)
//
// Stages map onto a boolean flag's targeting in that environment:
//
//   off        targeting off
//   internal   targeting on, default rule serves false: only the flag's own
//              targets and rules get true. With LAUNCHDARKLY_INTERNAL_SEGMENT
//              set, crosstalk adds one rule itself ("crosstalk: internal",
//              the segment → true) the first time; without it, your own
//              individual targets and rules decide who is internal
//   N%         targeting on, the internal rule as above, default rule a
//              percentage rollout, N% true
//   on         targeting on, default rule serves true
//
// (dark is a companion flag, <flag>-dark: providers/index.ts.)
//
// Metrics: with LAUNCHDARKLY_METRICS set, each metric's results for the
// flag's true variation are read from the experimentation results endpoint
// (GET /api/v2/flags/:project/:flag/experiments/:env/:metric, a beta API),
// as the conversion rate when there is one, else the mean value.

import type { Stage } from "../flags.ts"
import { percent } from "../flags.ts"
import { call, NotConfigured, type Env, type Fetch, type FlagProvider } from "./types.ts"

type Variation = { _id: string; value: unknown }

export class LaunchDarkly implements FlagProvider {
  readonly name = "LaunchDarkly"
  readonly instant = true
  private base: string
  private token: string
  private project: string
  private env: string
  private segment?: string
  private metricKeys: string[]
  constructor(e: Env, private fetcher: Fetch = fetch as unknown as Fetch) {
    if (!e.LAUNCHDARKLY_API_TOKEN) throw new NotConfigured("LaunchDarkly needs LAUNCHDARKLY_API_TOKEN in the daemon's environment")
    this.token = e.LAUNCHDARKLY_API_TOKEN
    this.base = (e.LAUNCHDARKLY_BASE_URL ?? "https://app.launchdarkly.com").replace(/\/$/, "")
    this.project = e.LAUNCHDARKLY_PROJECT ?? "default"
    this.env = e.LAUNCHDARKLY_ENVIRONMENT ?? "production"
    this.segment = e.LAUNCHDARKLY_INTERNAL_SEGMENT || undefined
    this.metricKeys = (e.LAUNCHDARKLY_METRICS ?? "")
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean)
  }

  private url = (flag: string, q = "") => `${this.base}/api/v2/flags/${encodeURIComponent(this.project)}/${encodeURIComponent(flag)}${q}`

  private async flag(flag: string) {
    return call(this.fetcher, this.url(flag, `?env=${encodeURIComponent(this.env)}`), { headers: { Authorization: this.token } }, `LaunchDarkly ${flag}`)
  }

  private variations(f: any): { yes: Variation; no: Variation } {
    const vs: Variation[] = f?.variations ?? []
    const yes = vs.find((v) => v.value === true)
    const no = vs.find((v) => v.value === false)
    if (!yes || !no) throw new Error(`LaunchDarkly ${f?.key}: crosstalk drives boolean flags only`)
    return { yes, no }
  }

  async get(flag: string): Promise<Stage | undefined> {
    const f = await this.flag(flag)
    const e = f?.environments?.[this.env]
    if (!e) return undefined
    if (!e.on) return "off"
    const vs: Variation[] = f.variations ?? []
    const yesIdx = vs.findIndex((v) => v.value === true)
    const ft = e.fallthrough ?? {}
    if (typeof ft.variation === "number") return ft.variation === yesIdx ? "on" : "internal"
    const roll: { variation: number; weight: number }[] = ft.rollout?.variations ?? []
    const w = roll.find((r) => r.variation === yesIdx)?.weight ?? 0
    if (w >= 100_000) return "on"
    if (w <= 0) return "internal"
    return `${Math.round(w / 1000)}%` as Stage
  }

  /** The rule that makes the internal segment internal, unless the flag has it already. */
  private internalRule(f: any, yes: Variation): object[] {
    if (!this.segment) return []
    const rules: any[] = f?.environments?.[this.env]?.rules ?? []
    const has = rules.some((r) => r.description === "crosstalk: internal" || (r.clauses ?? []).some((c: any) => c.op === "segmentMatch" && (c.values ?? []).includes(this.segment)))
    if (has) return []
    return [{ kind: "addRule", description: "crosstalk: internal", variationId: yes._id, clauses: [{ contextKind: "user", attribute: "segmentMatch", op: "segmentMatch", negate: false, values: [this.segment] }] }]
  }

  async set(flag: string, stage: Stage, why: string): Promise<string> {
    const f = await this.flag(flag)
    const { yes, no } = this.variations(f)
    const on = { kind: "turnFlagOn" }
    let instructions: object[]
    if (stage === "off" || stage === "dark") instructions = [{ kind: "turnFlagOff" }]
    else if (stage === "on") instructions = [on, { kind: "updateFallthroughVariationOrRollout", variationId: yes._id }]
    else if (stage === "internal") instructions = [on, ...this.internalRule(f, yes), { kind: "updateFallthroughVariationOrRollout", variationId: no._id }]
    else {
      const w = Math.round(percent(stage) * 1000)
      instructions = [on, ...this.internalRule(f, yes), { kind: "updateFallthroughVariationOrRollout", rolloutWeights: { [yes._id]: w, [no._id]: 100_000 - w } }]
    }
    await call(
      this.fetcher,
      this.url(flag),
      {
        method: "PATCH",
        headers: { Authorization: this.token, "Content-Type": "application/json; domain-model=launchdarkly.semanticpatch" },
        body: JSON.stringify({ environmentKey: this.env, comment: `crosstalk: ${why}`.slice(0, 500), instructions }),
      },
      `LaunchDarkly ${flag}`,
    )
    return `${flag} is ${stage} in LaunchDarkly (${this.env}), in effect now`
  }

  async metrics(flag: string): Promise<Record<string, number> | undefined> {
    if (!this.metricKeys.length) return undefined
    const f = await this.flag(flag)
    const yesIdx = (f?.variations ?? []).findIndex((v: Variation) => v.value === true)
    const out: Record<string, number> = {}
    for (const m of this.metricKeys) {
      const r = await call(
        this.fetcher,
        this.url(flag, `/experiments/${encodeURIComponent(this.env)}/${encodeURIComponent(m)}`),
        { headers: { Authorization: this.token, "LD-API-Version": "beta" } },
        `LaunchDarkly metric ${m}`,
      )
      const t = (r?.totals ?? [])[yesIdx < 0 ? 0 : yesIdx] ?? {}
      const v =
        typeof t.cumulativeConversionRate === "number"
          ? t.cumulativeConversionRate
          : typeof t.cumulativeValue === "number" && typeof t.cumulativeCount === "number" && t.cumulativeCount > 0
            ? t.cumulativeValue / t.cumulativeCount
            : typeof t.cumulativeValue === "number"
              ? t.cumulativeValue
              : undefined
      if (v !== undefined && Number.isFinite(v)) out[m] = v
    }
    return Object.keys(out).length ? out : undefined
  }
}
