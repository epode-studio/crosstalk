// PostHog feature flags, through its REST API.
//
//   POSTHOG_PERSONAL_API_KEY       a personal API key with feature_flag:write (required)
//   POSTHOG_PROJECT_ID             the project's id (required)
//   POSTHOG_HOST                   default https://us.posthog.com (tests point it at a mock)
//   POSTHOG_INTERNAL_COHORT        a cohort id holding your own accounts, or
//   POSTHOG_INTERNAL_EMAIL_DOMAIN  e.g. example.com: who "internal" means
//
// Stages map onto the flag's release conditions:
//
//   off        active: false
//   internal   one condition: the internal cohort (or email domain), 100%
//   N%         the internal condition at 100%, plus everyone at N%
//   on         everyone at 100%
//
// A flag crosstalk is asked to move that PostHog does not have yet is
// created, off. Metrics: not read yet.

import type { Stage } from "../flags.ts"
import { percent } from "../flags.ts"
import { call, NotConfigured, type Env, type Fetch, type FlagProvider } from "./types.ts"

type Group = { properties: any[]; rollout_percentage: number | null }

export class PostHog implements FlagProvider {
  readonly name = "PostHog"
  readonly instant = true
  private host: string
  private key: string
  private project: string
  private internal?: object
  constructor(e: Env, private fetcher: Fetch = fetch as unknown as Fetch) {
    if (!e.POSTHOG_PERSONAL_API_KEY || !e.POSTHOG_PROJECT_ID)
      throw new NotConfigured("PostHog needs POSTHOG_PERSONAL_API_KEY and POSTHOG_PROJECT_ID in the daemon's environment")
    this.key = e.POSTHOG_PERSONAL_API_KEY
    this.project = e.POSTHOG_PROJECT_ID
    this.host = (e.POSTHOG_HOST ?? "https://us.posthog.com").replace(/\/$/, "")
    if (e.POSTHOG_INTERNAL_COHORT) this.internal = { key: "id", type: "cohort", value: Number(e.POSTHOG_INTERNAL_COHORT) || e.POSTHOG_INTERNAL_COHORT }
    else if (e.POSTHOG_INTERNAL_EMAIL_DOMAIN) this.internal = { key: "email", type: "person", operator: "icontains", value: `@${e.POSTHOG_INTERNAL_EMAIL_DOMAIN.replace(/^@/, "")}` }
  }

  private h = (json = false) => ({ Authorization: `Bearer ${this.key}`, ...(json ? { "Content-Type": "application/json" } : {}) })
  private base = () => `${this.host}/api/projects/${encodeURIComponent(this.project)}/feature_flags/`

  private async find(flag: string): Promise<any | undefined> {
    const r = await call(this.fetcher, `${this.base()}?search=${encodeURIComponent(flag)}`, { headers: this.h() }, `PostHog ${flag}`)
    return (r?.results ?? []).find((f: any) => f.key === flag && !f.deleted)
  }

  async get(flag: string): Promise<Stage | undefined> {
    const f = await this.find(flag)
    if (!f) return undefined
    if (!f.active) return "off"
    const groups: Group[] = f.filters?.groups ?? []
    const everyone = groups.filter((g) => !g.properties?.length)
    const pct = Math.max(0, ...everyone.map((g) => (g.rollout_percentage === null || g.rollout_percentage === undefined ? 100 : g.rollout_percentage)))
    if (pct >= 100) return "on"
    if (pct > 0) return `${pct}%` as Stage
    return groups.some((g) => g.properties?.length) ? "internal" : "off"
  }

  private groups(stage: Stage): Group[] {
    if (stage === "on") return [{ properties: [], rollout_percentage: 100 }]
    if (!this.internal) {
      if (stage === "internal") throw new NotConfigured("PostHog needs POSTHOG_INTERNAL_COHORT or POSTHOG_INTERNAL_EMAIL_DOMAIN to know who internal is")
      return [{ properties: [], rollout_percentage: percent(stage) }]
    }
    const inside: Group = { properties: [this.internal], rollout_percentage: 100 }
    return stage === "internal" ? [inside] : [inside, { properties: [], rollout_percentage: percent(stage) }]
  }

  async set(flag: string, stage: Stage, why: string): Promise<string> {
    let f = await this.find(flag)
    if (!f)
      f = await call(
        this.fetcher,
        this.base(),
        { method: "POST", headers: this.h(true), body: JSON.stringify({ key: flag, name: `crosstalk: ${why}`.slice(0, 400), active: false, filters: { groups: [] } }) },
        `PostHog ${flag}`,
      )
    const body = stage === "off" ? { active: false } : { active: true, filters: { ...(f.filters ?? {}), groups: this.groups(stage) } }
    await call(this.fetcher, `${this.base()}${f.id}/`, { method: "PATCH", headers: this.h(true), body: JSON.stringify(body) }, `PostHog ${flag}`)
    return `${flag} is ${stage} in PostHog, in effect now`
  }
}
