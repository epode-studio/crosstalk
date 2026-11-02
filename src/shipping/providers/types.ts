import type { Stage } from "../flags.ts"

/**
 * Where a flag lives. crosstalk drives it: reads where it stands, moves it a
 * step, and reads its metrics when the provider has them. `instant` says
 * whether turning it off takes effect at once (a provider) or at the next
 * deploy (the flags file).
 */
export interface FlagProvider {
  readonly name: string
  readonly instant: boolean
  get(flag: string): Promise<Stage | undefined>
  /** Returns a line saying what happened, in plain words. */
  set(flag: string, stage: Stage, why: string): Promise<string>
  metrics?(flag: string): Promise<Record<string, number> | undefined>
}

export class NotConfigured extends Error {}

export type Env = Record<string, string | undefined>

export type Fetch = (url: string, init?: { method?: string; headers?: Record<string, string>; body?: string }) => Promise<{ ok: boolean; status: number; json(): Promise<any>; text(): Promise<string> }>

export async function call(fetcher: Fetch, url: string, init: { method?: string; headers?: Record<string, string>; body?: string }, what: string): Promise<any> {
  let r
  try {
    r = await fetcher(url, init)
  } catch (e) {
    throw new Error(`${what}: could not reach ${new URL(url).host} (${(e as Error).message})`)
  }
  if (!r.ok) {
    const t = await r.text().catch(() => "")
    throw new Error(`${what}: ${r.status} ${t.slice(0, 200)}`)
  }
  const t = await r.text()
  return t ? JSON.parse(t) : {}
}
