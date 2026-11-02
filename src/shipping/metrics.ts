// Metrics for a flag, and whether they held.
//
// Where they come from, first that answers:
//
//   `metrics: <command>` in .crosstalk/ship   run in the main checkout with
//                                             CROSSTALK_FLAG and CROSSTALK_STAGE
//                                             set; prints one JSON object of
//                                             numbers, e.g. {"errors": 3,
//                                             "latency_p95": 120}
//   the provider's own metrics                LaunchDarkly (providers/launchdarkly.ts)
//
// plus, for a flag that has been dark, what its shadow runs reported
// (shadow.ts): shadow_calls, shadow_mismatches, shadow_mismatch_rate.
//
// A baseline is read just before each step up. After it, the same metrics
// are compared with it by the `regress:` rules (config.ts); any rule broken
// is a regression and turns the flag off.

import type { Threshold } from "./config.ts"

export type Metrics = Record<string, number>

/** The last JSON object of numbers a command printed. Anything else is ignored. */
export function parseMetrics(out: string): Metrics | undefined {
  const tries: string[] = []
  const t = out.trim()
  if (t.startsWith("{")) tries.push(t)
  for (const line of t.split("\n").reverse()) if (line.trim().startsWith("{")) tries.push(line.trim())
  const i = t.lastIndexOf("\n{")
  if (i >= 0) tries.push(t.slice(i + 1))
  for (const s of tries) {
    try {
      const o = JSON.parse(s)
      if (!o || typeof o !== "object" || Array.isArray(o)) continue
      const src = o.metrics && typeof o.metrics === "object" ? o.metrics : o
      const m: Metrics = {}
      for (const [k, v] of Object.entries(src)) {
        const n = typeof v === "number" ? v : typeof v === "string" && v.trim() && !isNaN(Number(v)) ? Number(v) : NaN
        if (Number.isFinite(n) && /^[A-Za-z0-9_.-]{1,64}$/.test(k)) m[k] = n
      }
      if (Object.keys(m).length) return m
    } catch {}
  }
  return undefined
}

export type Broken = { metric: string; before?: number; now: number; rule: Threshold; text: string }

const fmt = (n: number) => (Math.abs(n) >= 100 || Number.isInteger(n) ? String(Math.round(n * 100) / 100) : n.toPrecision(3))
const pct = (r: number) => `${r >= 0 ? "+" : ""}${Math.round(r * 100)}%`

/** The rule that applies to a metric: its own, else `*`. Only `*` rise/fall rules carry over. */
function rulesFor(metric: string, rules: Threshold[]): Threshold[] {
  const own = rules.filter((r) => r.metric === metric)
  if (own.length) return own
  // A shadow count or an exposure count is not a health metric; only its own rule judges it.
  if (/^(shadow_|exposures)/.test(metric)) return []
  return rules.filter((r) => r.metric === "*")
}

/**
 * What regressed between the baseline and now. A metric with no baseline is
 * judged by absolute rules only; a baseline of zero counts any rise of more
 * than one as a regression (zero errors to three is not "+inf%, fine").
 */
export function regressions(baseline: Metrics | undefined, now: Metrics, rules: Threshold[]): Broken[] {
  const out: Broken[] = []
  for (const [metric, v] of Object.entries(now)) {
    const before = baseline?.[metric]
    for (const r of rulesFor(metric, rules)) {
      if (r.kind === "above") {
        if (v > r.value) out.push({ metric, before, now: v, rule: r, text: `${metric} is ${fmt(v)}, above ${fmt(r.value)}` })
        continue
      }
      if (before === undefined) continue
      if (before === 0) {
        if (r.kind === "rise" && v > 1) out.push({ metric, before, now: v, rule: r, text: `${metric} went from 0 to ${fmt(v)}` })
        continue
      }
      const change = (v - before) / Math.abs(before)
      if (r.kind === "rise" && change > r.value) out.push({ metric, before, now: v, rule: r, text: `${metric} went from ${fmt(before)} to ${fmt(v)} (${pct(change)}, more than ${pct(r.value)})` })
      if (r.kind === "fall" && -change > r.value) out.push({ metric, before, now: v, rule: r, text: `${metric} went from ${fmt(before)} to ${fmt(v)} (${pct(change)}, a fall of more than ${Math.round(r.value * 100)}%)` })
    }
  }
  return out
}

/**
 * What cannot be compared, so "nothing regressed" would mean nothing: no
 * baseline at all, a baseline metric that is no longer reported, or a new
 * metric with nothing before it (shadow and exposure counts aside: they are
 * judged on their own). An automatic step waits while there is any.
 */
export function gaps(baseline: Metrics | undefined, now: Metrics | undefined): string[] {
  if (!now || !Object.keys(now).length) return ["there are no metrics now"]
  const health = (k: string) => !/^(shadow_|exposures)/.test(k)
  if (!baseline || !Object.keys(baseline).filter(health).length) return Object.keys(now).some(health) ? ["there is no baseline from before the step"] : []
  const out: string[] = []
  const gone = Object.keys(baseline).filter((k) => health(k) && !(k in now))
  const fresh = Object.keys(now).filter((k) => health(k) && !(k in baseline))
  if (gone.length) out.push(`no longer reported: ${gone.join(", ")}`)
  if (fresh.length) out.push(`no baseline for: ${fresh.join(", ")}`)
  return out
}

/** Metrics as a person reads them: "errors 3 (was 2), latency_p95 120 (was 118)". */
export function describeMetrics(now: Metrics | undefined, baseline?: Metrics): string {
  if (!now || !Object.keys(now).length) return "no metrics"
  return Object.entries(now)
    .map(([k, v]) => `${k} ${fmt(v)}${baseline && baseline[k] !== undefined ? ` (was ${fmt(baseline[k])})` : ""}`)
    .join(", ")
}
