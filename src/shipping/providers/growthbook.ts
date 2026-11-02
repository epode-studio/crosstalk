// GrowthBook features, through its REST API (v1).
//
//   GROWTHBOOK_API_KEY              a secret API key (or personal access token) with write access (required)
//   GROWTHBOOK_API_HOST             default https://api.growthbook.io (self-hosted: your API host; tests point it at a mock)
//   GROWTHBOOK_ENVIRONMENT          default production
//   GROWTHBOOK_PROJECT              the project a created feature goes in (optional)
//   GROWTHBOOK_OWNER                the owner a created feature names (default crosstalk)
//   GROWTHBOOK_INTERNAL_CONDITION   a targeting condition, as JSON, that means "your own accounts",
//                                   e.g. {"email": {"$regex": "@example\\.com$"}}, or
//   GROWTHBOOK_INTERNAL_EMAIL_DOMAIN  e.g. example.com (the condition is built from it)
//   GROWTHBOOK_HASH_ATTRIBUTE       what a percentage rollout hashes on, default id
//
// Stages map onto the feature's rules in that environment. crosstalk only
// touches rules whose description starts "crosstalk:", so rules you wrote
// yourself stay (and come first):
//
//   off        the environment disabled
//   internal   enabled; a force rule: the internal condition → true
//   N%         that, plus a rollout rule: true for N% (coverage N/100)
//   on         enabled; a force rule: true for everyone
//
// The feature's default value is false. A feature GrowthBook does not have
// yet is created (boolean, default false, disabled).
//
// Endpoints: GET /api/v1/features/:id, POST /api/v1/features/:id (update),
// POST /api/v1/features (create), all with Authorization: Bearer <key>.

import type { Stage } from "../flags.ts"
import { percent } from "../flags.ts"
import { call, NotConfigured, type Env, type Fetch, type FlagProvider } from "./types.ts"

export type GbRule = {
  id?: string
  type: "force" | "rollout" | "experiment" | string
  description?: string
  condition?: string
  value?: string
  coverage?: number
  hashAttribute?: string
  enabled?: boolean
}

const MINE = "crosstalk:"

export class GrowthBook implements FlagProvider {
  readonly name = "GrowthBook"
  readonly instant = true
  private host: string
  private key: string
  private env: string
  private project?: string
  private owner: string
  private internal?: string
  private hash: string
  constructor(e: Env, private fetcher: Fetch = fetch as unknown as Fetch) {
    if (!e.GROWTHBOOK_API_KEY) throw new NotConfigured("GrowthBook needs GROWTHBOOK_API_KEY in the daemon's environment")
    this.key = e.GROWTHBOOK_API_KEY
    this.host = (e.GROWTHBOOK_API_HOST ?? "https://api.growthbook.io").replace(/\/$/, "")
    this.env = e.GROWTHBOOK_ENVIRONMENT ?? "production"
    this.project = e.GROWTHBOOK_PROJECT
    this.owner = e.GROWTHBOOK_OWNER ?? "crosstalk"
    this.hash = e.GROWTHBOOK_HASH_ATTRIBUTE ?? "id"
    if (e.GROWTHBOOK_INTERNAL_CONDITION) {
      try {
        JSON.parse(e.GROWTHBOOK_INTERNAL_CONDITION)
      } catch {
        throw new NotConfigured("GROWTHBOOK_INTERNAL_CONDITION is not JSON")
      }
      this.internal = e.GROWTHBOOK_INTERNAL_CONDITION
    } else if (e.GROWTHBOOK_INTERNAL_EMAIL_DOMAIN) {
      const d = e.GROWTHBOOK_INTERNAL_EMAIL_DOMAIN.replace(/^@/, "").replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
      this.internal = JSON.stringify({ email: { $regex: `@${d}$` } })
    }
  }

  private h = (json = false) => ({ Authorization: `Bearer ${this.key}`, ...(json ? { "Content-Type": "application/json" } : {}) })
  private url = (id = "") => `${this.host}/api/v1/features${id ? `/${encodeURIComponent(id)}` : ""}`

  private async find(flag: string): Promise<any | undefined> {
    try {
      const r = await call(this.fetcher, this.url(flag), { headers: this.h() }, `GrowthBook ${flag}`)
      return r?.feature
    } catch (e) {
      if (/: 404\b/.test((e as Error).message)) return undefined
      throw e
    }
  }

  async get(flag: string): Promise<Stage | undefined> {
    const f = await this.find(flag)
    if (!f) return undefined
    const e = f.environments?.[this.env]
    if (!e || !e.enabled) return "off"
    const rules: GbRule[] = (e.rules ?? []).filter((r: GbRule) => r.enabled !== false && (r.description ?? "").startsWith(MINE))
    const yes = (v: unknown) => v === "true" || v === true
    if (rules.some((r) => r.type === "force" && yes(r.value) && !hasCondition(r))) return "on"
    const roll = rules.find((r) => r.type === "rollout" && yes(r.value))
    if (roll) {
      const n = Math.round((roll.coverage ?? 0) * 100)
      if (n >= 100) return "on"
      if (n > 0) return `${n}%` as Stage
    }
    if (rules.some((r) => r.type === "force" && yes(r.value) && hasCondition(r))) return "internal"
    return yes(e.defaultValue ?? f.defaultValue) ? "on" : "off"
  }

  private rules(stage: Stage): GbRule[] {
    if (stage === "on") return [{ type: "force", description: `${MINE} everyone`, value: "true", enabled: true }]
    const inside: GbRule[] = this.internal ? [{ type: "force", description: `${MINE} internal`, condition: this.internal, value: "true", enabled: true }] : []
    if (stage === "internal") {
      if (!this.internal) throw new NotConfigured("GrowthBook needs GROWTHBOOK_INTERNAL_CONDITION or GROWTHBOOK_INTERNAL_EMAIL_DOMAIN to know who internal is")
      return inside
    }
    return [...inside, { type: "rollout", description: `${MINE} ${stage} of everyone`, value: "true", coverage: percent(stage) / 100, hashAttribute: this.hash, enabled: true }]
  }

  async set(flag: string, stage: Stage, why: string): Promise<string> {
    let f = await this.find(flag)
    if (!f) {
      const created = await call(
        this.fetcher,
        this.url(),
        {
          method: "POST",
          headers: this.h(true),
          body: JSON.stringify({
            id: flag,
            description: `crosstalk: ${why}`.slice(0, 400),
            owner: this.owner,
            valueType: "boolean",
            defaultValue: "false",
            ...(this.project ? { project: this.project } : {}),
            environments: { [this.env]: { enabled: false, rules: [] } },
          }),
        },
        `GrowthBook ${flag}`,
      )
      f = created?.feature ?? { id: flag, environments: { [this.env]: { enabled: false, rules: [] } } }
    }
    const cur = f.environments?.[this.env] ?? { enabled: false, rules: [] }
    const theirs: GbRule[] = (cur.rules ?? []).filter((r: GbRule) => !(r.description ?? "").startsWith(MINE))
    const env = stage === "off" ? { ...cur, enabled: false } : { ...cur, enabled: true, rules: [...theirs, ...this.rules(stage)] }
    await call(this.fetcher, this.url(flag), { method: "POST", headers: this.h(true), body: JSON.stringify({ environments: { [this.env]: strip(env) } }) }, `GrowthBook ${flag}`)
    return `${flag} is ${stage} in GrowthBook (${this.env}), in effect now`
  }
}

const hasCondition = (r: GbRule) => !!r.condition && r.condition.trim() !== "" && r.condition.trim() !== "{}"

/** What the update endpoint takes back: enabled and rules (ids kept so GrowthBook updates them in place). */
const strip = (e: any) => ({ enabled: !!e.enabled, rules: (e.rules ?? []).map((r: GbRule) => ({ ...r })) })
