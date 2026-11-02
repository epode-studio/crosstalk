// Which flag provider a repo uses (`flags:` in .crosstalk/ship), built from
// tokens in the daemon's environment. The flags file needs nothing.

import { LaunchDarkly } from "./launchdarkly.ts"
import { PostHog } from "./posthog.ts"
import { NotConfigured, type Env, type Fetch, type FlagProvider } from "./types.ts"
import type { Stage } from "../flags.ts"
import * as F from "../flags.ts"
import * as G from "../git.ts"
import { commitToDefault } from "../merge.ts"
import type { PushMode, ProviderName } from "../config.ts"

export { NotConfigured, type FlagProvider } from "./types.ts"

/** Not built yet: says so instead of pretending. */
class NotYet implements FlagProvider {
  readonly instant = true
  constructor(readonly name: string) {}
  private no(): never {
    throw new NotConfigured(`${this.name} is not supported yet; use flags: launchdarkly, posthog or file in .crosstalk/ship`)
  }
  async get(): Promise<Stage | undefined> {
    this.no()
  }
  async set(): Promise<string> {
    this.no()
  }
}

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

export function providerFor(name: ProviderName, o: { root: string; env?: Env; fetcher?: Fetch; push?: PushMode }): FlagProvider {
  const env = o.env ?? process.env
  switch (name) {
    case "launchdarkly":
      return new LaunchDarkly(env, o.fetcher)
    case "posthog":
      return new PostHog(env, o.fetcher)
    case "growthbook":
      return new NotYet("GrowthBook")
    case "statsig":
      return new NotYet("Statsig")
    default:
      return new FileFlags(o.root, { push: o.push })
  }
}
