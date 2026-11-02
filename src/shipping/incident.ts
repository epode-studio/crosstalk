// Production feeds threads. Something went wrong; which thread shipped it?
//
//   crosstalk incident --source sentry --title "500s on /login" \
//     --details "TypeError in session.ts:40" [--flag login-v2] [--files a,b] [--sha abc123]
//
// A clear cause reopens the thread that shipped it, with the incident
// attached, and its agents are told: they have the context. Clear means one
// thread, by the first of these that names any:
//
//   the flag     a feature behind that flag
//   the sha      a commit a feature merged (or its prefix)
//   the files    files a feature merged within incident_days, most overlap,
//                and no tie
//
// Anything else starts an incident thread to look for the cause, and links
// to the thread that shipped it once that is found.
//
// The automatic kill: an incident that names the flag of a risky feature
// turns that flag off at once, and says so. Turning off is never a question.

import type { Thread } from "../threads/model.ts"
import * as M from "../threads/model.ts"

export type Incident = { source: string; title: string; details: string; flag?: string; files?: string[]; sha?: string }

export type Match = { thread: string; feature: string; by: "flag" | "sha" | "files"; score: number }

const DAY = 24 * 60 * 60_000

/** Paths from a stack trace or a list, made repo-relative where they can be. */
export function normaliseFiles(files: string[] | undefined): string[] {
  return [...new Set((files ?? []).map((f) => f.trim().replace(/:\d+(:\d+)?$/, "").replace(/^(\.\/|\/)/, "")).filter(Boolean))]
}

const tail = (a: string, b: string) => a === b || a.endsWith("/" + b) || b.endsWith("/" + a)

export function mapIncident(inc: Incident, threads: Thread[], o: { now: number; days: number }): Match | null {
  const features = threads.flatMap((t) => M.live(t, "features").map((f) => ({ t, f })))
  if (inc.flag) {
    const hit = features.filter(({ f }) => f.flag === inc.flag)
    const ts = [...new Set(hit.map((h) => h.t.id))]
    if (ts.length === 1) return { thread: ts[0], feature: hit[0].f.id, by: "flag", score: 1 }
  }
  const sha = inc.sha?.trim().toLowerCase()
  if (sha && sha.length >= 7) {
    const hit = features.filter(({ f }) => f.ship?.merged && [f.ship.merged.sha, ...(f.ship.merged.shas ?? [])].some((s) => s?.startsWith(sha)))
    const ts = [...new Set(hit.map((h) => h.t.id))]
    if (ts.length === 1) return { thread: ts[0], feature: hit[0].f.id, by: "sha", score: 1 }
  }
  const files = normaliseFiles(inc.files)
  if (files.length) {
    const recent = features.filter(({ f }) => f.ship?.merged && o.now - f.ship.merged.at < o.days * DAY)
    const scored = recent
      .map(({ t, f }) => ({ t, f, score: files.filter((x) => f.ship!.merged!.files.some((y) => tail(x, y))).length }))
      .filter((s) => s.score > 0)
      .sort((a, b) => b.score - a.score || b.f.ship!.merged!.at - a.f.ship!.merged!.at)
    if (scored.length) {
      const best = scored[0]
      const tied = scored.filter((s) => s.score === best.score && s.t.id !== best.t.id)
      if (!tied.length) return { thread: best.t.id, feature: best.f.id, by: "files", score: best.score }
    }
  }
  return null
}

/** The incident as the thread records it: words from outside, marked as such. */
export const describeIncident = (inc: Incident) =>
  `Incident from ${inc.source}: ${inc.title}${inc.details ? ` — ${inc.details}` : ""}${inc.flag ? ` (flag ${inc.flag})` : ""}${inc.sha ? ` (at ${inc.sha.slice(0, 12)})` : ""}${inc.files?.length ? ` (in ${normaliseFiles(inc.files).slice(0, 5).join(", ")})` : ""}`.slice(0, 1500)
