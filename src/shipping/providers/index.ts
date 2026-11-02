// Which flag provider a repo uses (`flags:` in .crosstalk/ship), built from
// tokens in the daemon's environment. The flags file needs nothing.
//
// Unleash (the first-class provider) has dark as a strategy variant of its
// own. On the others:
//
// Dark, on a provider: a boolean flag has no third value, so a flag at
// `dark` is two flags: the flag itself off (nobody gets the new path's
// result) and a companion, `<flag>-dark`, on for everyone (the app runs the
// new path in shadow). PostHog, GrowthBook and Statsig create the companion
// when it is missing; in LaunchDarkly create a boolean flag `<flag>-dark`
// once. Every other stage turns the companion off. The flags file has
// `dark` as a value of its own.

import { Unleash } from "./unleash.ts"
import { LaunchDarkly } from "./launchdarkly.ts"
import { PostHog } from "./posthog.ts"
import { GrowthBook } from "./growthbook.ts"
import { Statsig } from "./statsig.ts"
import { NotConfigured, type Env, type Fetch, type FlagProvider } from "./types.ts"
import type { Stage } from "../flags.ts"
import * as F from "../flags.ts"
import * as G from "../git.ts"
import { commitToDefault } from "../merge.ts"
import type { PushMode, ProviderName } from "../config.ts"

export { NotConfigured, type FlagProvider } from "./types.ts"

export const DARK_SUFFIX = "-dark"
export const darkFlag = (flag: string) => `${flag}${DARK_SUFFIX}`

/** The built-in flags file on the default branch, changed with a commit. */
export class FileFlags implements FlagProvider {
  readonly name = "the flags file"
  readonly instant = false
  constructor(private root: string, private o: { push?: PushMode; gh?: boolean } = {}) {}
  private read(): string | undefined {
    const d = G.defaultBranch(this.root)
    return d ? G.show(this.root, d, F.FLAGS_FILE) : undefined
  }
  async get(flag: string): Promise<Stage | undefined> {
    const t = this.read()
    return t ? F.parseFlags(t).flags[flag] : undefined
  }
  async set(flag: string, stage: Stage, why: string): Promise<string> {
    const before = this.read()
    if (before && F.parseFlags(before).flags[flag] === stage) return `${flag} was already ${stage} in ${F.FLAGS_FILE}`
    const next = F.setFlag(before, flag, stage)
    const r = commitToDefault(this.root, F.FLAGS_FILE, next, `flags: ${flag} ${stage}\n\n${why}`, this.o)
    if (!r.ok) throw new Error(`could not change ${F.FLAGS_FILE}: ${r.text}`)
    return `${flag} is ${stage} in ${F.FLAGS_FILE} (${r.text}); it takes effect at the next deploy`
  }
}

/** A provider whose flags are on or off, given `dark` through a companion flag. */
export class WithDark implements FlagProvider {
  readonly name: string
  readonly instant: boolean
  readonly metrics?: (flag: string) => Promise<Record<string, number> | undefined>
  constructor(readonly inner: FlagProvider) {
    this.name = inner.name
    this.instant = inner.instant
    if (inner.metrics) this.metrics = (flag) => inner.metrics!(flag)
  }

  private async companion(flag: string): Promise<Stage | undefined> {
    try {
      return await this.inner.get(darkFlag(flag))
    } catch {
      return undefined
    }
  }

  async get(flag: string): Promise<Stage | undefined> {
    const main = await this.inner.get(flag)
    if ((main === undefined || main === "off") && (await this.companion(flag)) === "on") return "dark"
    return main
  }

  async set(flag: string, stage: Stage, why: string): Promise<string> {
    if (stage === "dark") {
      let shadow: string
      try {
        shadow = await this.inner.set(darkFlag(flag), "on", `${why} (dark launch of ${flag})`)
      } catch (e) {
        throw new Error(`${flag} cannot go dark in ${this.name} without its companion flag ${darkFlag(flag)}: ${(e as Error).message}`)
      }
      const main = await this.inner.get(flag).catch(() => undefined)
      if (main !== undefined && main !== "off") await this.inner.set(flag, "off", why)
      return `${flag} is dark in ${this.name}: ${darkFlag(flag)} is on, so the new path runs in shadow, and ${flag} is off, so nobody gets its result (${shadow})`
    }
    // The flag itself first: a kill that fails on the companion must not leave the flag on.
    const said = await this.inner.set(flag, stage, why)
    if ((await this.companion(flag)) === "on") {
      try {
        await this.inner.set(darkFlag(flag), "off", `${why} (${flag} leaves dark)`)
      } catch (e) {
        throw new Error(`${flag} is ${stage} in ${this.name}, but its companion ${darkFlag(flag)} could not be turned off: ${(e as Error).message}`)
      }
    }
    return said
  }
}

export function providerFor(name: ProviderName, o: { root: string; env?: Env; fetcher?: Fetch; push?: PushMode }): FlagProvider {
  const env = o.env ?? process.env
  switch (name) {
    case "unleash":
      // Dark is native in Unleash: a strategy variant (providers/unleash.ts), no companion toggle.
      return new Unleash(env, o.fetcher)
    case "launchdarkly":
      return new WithDark(new LaunchDarkly(env, o.fetcher))
    case "posthog":
      return new WithDark(new PostHog(env, o.fetcher))
    case "growthbook":
      return new WithDark(new GrowthBook(env, o.fetcher))
    case "statsig":
      return new WithDark(new Statsig(env, o.fetcher))
    default:
      return new FileFlags(o.root, { push: o.push })
  }
}
