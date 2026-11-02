// How much of a session's context is spent.
//
// Two sources, freshest wins:
//
//   the mod         `$.session.usage().context` (the status line's
//                   `context_window` figures: used_percentage of
//                   context_window_size), reported after every turn through
//                   `crosstalk attn context`
//   the transcript  the last assistant message's usage: input, cache-written
//                   and cache-read tokens together are what the next request
//                   is answered over, against the model's window
//
// The window is 200k unless the model says otherwise: a `[1m]` model, or
// CROSSTALK_CONTEXT_WINDOW for anything else.

import { lines, tail } from "./recap.ts"

export const DEFAULT_WINDOW = 200_000

export type Usage = { tokens: number; window: number; percent: number; model?: string; at?: number }

export function windowFor(model: string | undefined, env: NodeJS.ProcessEnv = process.env): number {
  const forced = Number(env.CROSSTALK_CONTEXT_WINDOW)
  if (forced > 0) return forced
  if (model && /\[1m\]|-1m\b|1m-context/i.test(model)) return 1_000_000
  return DEFAULT_WINDOW
}

/** The last assistant turn's input side, from transcript entries. */
export function usageOf(entries: any[], env: NodeJS.ProcessEnv = process.env): Usage | null {
  for (let i = entries.length - 1; i >= 0; i--) {
    const e = entries[i]
    if (!e || e.isSidechain) continue
    const u = e.message?.usage
    if ((e.message?.role ?? e.type) !== "assistant" || !u || typeof u !== "object") continue
    const tokens = (Number(u.input_tokens) || 0) + (Number(u.cache_creation_input_tokens) || 0) + (Number(u.cache_read_input_tokens) || 0)
    if (!tokens) continue
    const model = typeof e.message?.model === "string" ? e.message.model : undefined
    const window = windowFor(model, env)
    const at = Date.parse(e.timestamp ?? "")
    return { tokens, window, percent: Math.min(100, Math.round((tokens / window) * 100)), model, ...(Number.isFinite(at) ? { at } : {}) }
  }
  return null
}

export const usageFromTranscript = (file: string | undefined, env: NodeJS.ProcessEnv = process.env) => usageOf(lines(tail(file, 256 * 1024)), env)

/** At this share of the window, a fresh session is offered instead of a compaction. */
export const spentAt = (env: NodeJS.ProcessEnv = process.env) => {
  const n = Number(env.CROSSTALK_DISPOSE_PCT)
  return n > 0 && n <= 100 ? n : 85
}

/** The freshest of the two readings. */
export function freshest(a: Usage | null | undefined, b: Usage | null | undefined): Usage | null {
  if (!a) return b ?? null
  if (!b) return a
  return (b.at ?? 0) > (a.at ?? 0) ? b : a
}
