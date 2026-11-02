// Statsig feature gates, through the Console API (v1).
//
//   STATSIG_CONSOLE_API_KEY         a Console API key (console-...) with write access (required)
//   STATSIG_API_URL                 default https://statsigapi.net/console/v1 (tests point it at a mock)
//   STATSIG_INTERNAL_SEGMENT        a segment id holding your own accounts, or
//   STATSIG_INTERNAL_EMAIL_DOMAIN   e.g. example.com: who "internal" means
//   STATSIG_ENVIRONMENT             when set, crosstalk's rules apply in that environment only
//
// Stages map onto the gate's rules. crosstalk only touches rules whose name
// starts "crosstalk:", so your own rules stay (and come first):
//
//   off        the gate disabled (isEnabled: false)
//   internal   enabled; a rule passing the internal segment (or email domain) at 100%
//   N%         that, plus a rule for everyone (a public condition) at passPercentage N
//   on         enabled; a public rule at 100%
//
// A gate Statsig does not have yet is created, disabled.
//
// Endpoints: GET /gates/:id, PATCH /gates/:id, POST /gates, all with the
// STATSIG-API-KEY header.

import type { Stage } from "../flags.ts"
import { percent } from "../flags.ts"
import { call, NotConfigured, type Env, type Fetch, type FlagProvider } from "./types.ts"

type Condition = { type: string; operator?: string; targetValue?: unknown; field?: string }
type SsRule = { name: string; passPercentage: number; conditions: Condition[]; environments?: string[] | null; id?: string }

const MINE = "crosstalk:"

export class Statsig implements FlagProvider {
  readonly name = "Statsig"
  readonly instant = true
  private base: string
  private key: string
  private internal?: Condition
  private envName?: string
  constructor(e: Env, private fetcher: Fetch = fetch as unknown as Fetch) {
    if (!e.STATSIG_CONSOLE_API_KEY) throw new NotConfigured("Statsig needs STATSIG_CONSOLE_API_KEY in the daemon's environment")
    this.key = e.STATSIG_CONSOLE_API_KEY
    this.base = (e.STATSIG_API_URL ?? "https://statsigapi.net/console/v1").replace(/\/$/, "")
    this.envName = e.STATSIG_ENVIRONMENT
    if (e.STATSIG_INTERNAL_SEGMENT) this.internal = { type: "passes_segment", targetValue: [e.STATSIG_INTERNAL_SEGMENT] }
    else if (e.STATSIG_INTERNAL_EMAIL_DOMAIN) this.internal = { type: "email", operator: "str_contains_any", targetValue: [`@${e.STATSIG_INTERNAL_EMAIL_DOMAIN.replace(/^@/, "")}`] }
  }

  private h = (json = false) => ({ "STATSIG-API-KEY": this.key, ...(json ? { "Content-Type": "application/json" } : {}) })
  private url = (id = "") => `${this.base}/gates${id ? `/${encodeURIComponent(id)}` : ""}`

  private async find(flag: string): Promise<any | undefined> {
    try {
      const r = await call(this.fetcher, this.url(flag), { headers: this.h() }, `Statsig ${flag}`)
      return r?.data ?? r
    } catch (e) {
      if (/: 404\b/.test((e as Error).message)) return undefined
      throw e
    }
  }

  async get(flag: string): Promise<Stage | undefined> {
    const g = await this.find(flag)
    if (!g) return undefined
    if (!g.isEnabled) return "off"
    const rules: SsRule[] = (g.rules ?? []).filter((r: SsRule) => (r.name ?? "").startsWith(MINE))
    const everyone = rules.filter((r) => r.conditions?.some((c) => c.type === "public"))
    const pct = Math.max(0, ...everyone.map((r) => Number(r.passPercentage) || 0))
    if (pct >= 100) return "on"
    if (pct > 0) return `${pct}%` as Stage
    return rules.some((r) => !r.conditions?.some((c) => c.type === "public") && r.passPercentage > 0) ? "internal" : "off"
  }

  private rules(stage: Stage): SsRule[] {
    const env = this.envName ? { environments: [this.envName] } : {}
    if (stage === "on") return [{ name: `${MINE} everyone`, passPercentage: 100, conditions: [{ type: "public" }], ...env }]
    const inside: SsRule[] = this.internal ? [{ name: `${MINE} internal`, passPercentage: 100, conditions: [this.internal], ...env }] : []
    if (stage === "internal") {
      if (!this.internal) throw new NotConfigured("Statsig needs STATSIG_INTERNAL_SEGMENT or STATSIG_INTERNAL_EMAIL_DOMAIN to know who internal is")
      return inside
    }
    return [...inside, { name: `${MINE} ${stage} of everyone`, passPercentage: percent(stage), conditions: [{ type: "public" }], ...env }]
  }

  async set(flag: string, stage: Stage, why: string): Promise<string> {
    let g = await this.find(flag)
    if (!g) {
      const r = await call(
        this.fetcher,
        this.url(),
        { method: "POST", headers: this.h(true), body: JSON.stringify({ name: flag, description: `crosstalk: ${why}`.slice(0, 400), isEnabled: false, rules: [] }) },
        `Statsig ${flag}`,
      )
      g = r?.data ?? { id: flag, isEnabled: false, rules: [] }
    }
    const theirs: SsRule[] = (g.rules ?? []).filter((r: SsRule) => !(r.name ?? "").startsWith(MINE))
    const body = stage === "off" ? { isEnabled: false } : { isEnabled: true, rules: [...theirs, ...this.rules(stage)] }
    await call(this.fetcher, this.url(g.id ?? flag), { method: "PATCH", headers: this.h(true), body: JSON.stringify(body) }, `Statsig ${flag}`)
    return `${flag} is ${stage} in Statsig, in effect now`
  }
}
