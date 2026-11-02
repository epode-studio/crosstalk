// Dark launch: the new path runs next to the old one, its result is thrown
// away, and only whether the two agreed is kept.
//
// The app does this with the crosstalk-flags helper (docs/shipping.md, "Dark
// launch"): at stage `dark` it runs both paths, answers with the old one, and
// reports each mismatch either way:
//
//   crosstalk incident --source shadow --flag <flag> --title "..." \
//     --details "calls=1200 mismatches=3"     (or JSON {"calls": 1200, ...})
//
//   a counter file <shadow folder>/<flag>.json  {"calls": 1200, "mismatches": 3}
//
// An incident from source `shadow` is never a kill and never reopens a
// thread: the shadow's results are not used, so a mismatch hurts nobody. It is
// counted here, and the mismatch rate becomes evidence for the step out of
// dark (and a regression rule, shadow_mismatch_rate, can hold that step back).

import fs from "node:fs"
import path from "node:path"
import type { Metrics } from "./metrics.ts"

export type ShadowCount = { calls: number; mismatches: number; since: number; at: number; examples: string[] }

/** calls=N, mismatches=N, as words or JSON, from an incident's details. */
export function parseCounts(details: string | undefined): { calls?: number; mismatches?: number } {
  const t = (details ?? "").trim()
  if (t.startsWith("{"))
    try {
      const o = JSON.parse(t)
      return {
        ...(Number.isFinite(Number(o.calls)) && o.calls !== undefined ? { calls: Number(o.calls) } : {}),
        ...(Number.isFinite(Number(o.mismatches)) && o.mismatches !== undefined ? { mismatches: Number(o.mismatches) } : {}),
      }
    } catch {}
  const calls = /\bcalls\s*[=:]\s*(\d+)/i.exec(t)?.[1]
  const mism = /\bmismatch(?:es)?\s*[=:]\s*(\d+)/i.exec(t)?.[1]
  return { ...(calls ? { calls: Number(calls) } : {}), ...(mism ? { mismatches: Number(mism) } : {}) }
}

/**
 * One shadow report folded into the count. A report naming cumulative
 * numbers replaces them (the helper counts in the process); a bare report is
 * one more mismatch.
 */
export function record(prev: ShadowCount | undefined, report: { title: string; details?: string }, now: number): ShadowCount {
  const c = parseCounts(report.details)
  const base: ShadowCount = prev ?? { calls: 0, mismatches: 0, since: now, at: now, examples: [] }
  const mismatches = c.mismatches !== undefined ? Math.max(base.mismatches, c.mismatches) : base.mismatches + 1
  const calls = Math.max(base.calls, c.calls ?? 0, mismatches)
  const examples = [...base.examples, `${report.title}${report.details ? `: ${report.details}` : ""}`.slice(0, 200)].slice(-3)
  return { calls, mismatches, since: base.since, at: now, examples }
}

/** The counter file for a flag, when the app writes one. */
export function readCounter(dir: string | undefined, flag: string): { calls: number; mismatches: number } | undefined {
  if (!dir) return undefined
  try {
    const o = JSON.parse(fs.readFileSync(path.join(dir, `${flag.replace(/[^A-Za-z0-9._-]/g, "_")}.json`), "utf8"))
    const calls = Number(o.calls)
    const mismatches = Number(o.mismatches)
    if (!Number.isFinite(calls) || !Number.isFinite(mismatches)) return undefined
    return { calls, mismatches }
  } catch {
    return undefined
  }
}

/** The shadow numbers as metrics. */
export function asMetrics(c: { calls: number; mismatches: number } | undefined): Metrics {
  if (!c) return {}
  return { shadow_calls: c.calls, shadow_mismatches: c.mismatches, shadow_mismatch_rate: c.calls > 0 ? c.mismatches / c.calls : c.mismatches > 0 ? 1 : 0 }
}

/** The two sources together: whichever has seen more. */
export function combine(a: { calls: number; mismatches: number } | undefined, b: { calls: number; mismatches: number } | undefined) {
  if (!a) return b
  if (!b) return a
  return { calls: Math.max(a.calls, b.calls), mismatches: Math.max(a.mismatches, b.mismatches) }
}
