// LaunchDarkly, through its REST API (v2) with semantic patches.
//
//   LAUNCHDARKLY_API_TOKEN     an API access token with writer rights (required)
//   LAUNCHDARKLY_PROJECT       project key, default "default"
//   LAUNCHDARKLY_ENVIRONMENT   environment key, default "production"
//   LAUNCHDARKLY_BASE_URL      default https://app.launchdarkly.com (tests point it at a mock)
//
// Stages map onto a boolean flag's targeting in that environment:
//
//   off        targeting off
//   internal   targeting on, default rule serves false: only the flag's own
//              targets and rules (your accounts, an "internal" segment, set up
//              once in LaunchDarkly) get true
//   N%         targeting on, default rule a percentage rollout, N% true
//   on         targeting on, default rule serves true
//
// Metrics: not read yet (LaunchDarkly's metrics live in experiments).

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
  constructor(e: Env, private fetcher: Fetch = fetch as unknown as Fetch) {
    if (!e.LAUNCHDARKLY_API_TOKEN) throw new NotConfigured("LaunchDarkly needs LAUNCHDARKLY_API_TOKEN in the daemon's environment")
    this.token = e.LAUNCHDARKLY_API_TOKEN
    this.base = (e.LAUNCHDARKLY_BASE_URL ?? "https://app.launchdarkly.com").replace(/\/$/, "")
    this.project = e.LAUNCHDARKLY_PROJECT ?? "default"
    this.env = e.LAUNCHDARKLY_ENVIRONMENT ?? "production"
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

  async set(flag: string, stage: Stage, why: string): Promise<string> {
    const f = await this.flag(flag)
    const { yes, no } = this.variations(f)
    const on = { kind: "turnFlagOn" }
    let instructions: object[]
    if (stage === "off") instructions = [{ kind: "turnFlagOff" }]
    else if (stage === "on") instructions = [on, { kind: "updateFallthroughVariationOrRollout", variationId: yes._id }]
    else if (stage === "internal") instructions = [on, { kind: "updateFallthroughVariationOrRollout", variationId: no._id }]
    else {
      const w = Math.round(percent(stage) * 1000)
      instructions = [on, { kind: "updateFallthroughVariationOrRollout", rolloutWeights: { [yes._id]: w, [no._id]: 100_000 - w } }]
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
}
