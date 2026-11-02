// Evidence of behaviour: what changed in what the software does, with proof.
// Plain language, never a diff. A risky feature cannot merge without it, and
// each flag step shows the evidence gathered at the step before.

import fs from "node:fs"
import path from "node:path"
import type { Evidence } from "./types.ts"

export type EvidenceInput = {
  summary?: unknown
  tests?: unknown
  evals?: unknown
  before_after?: unknown
  screenshots?: unknown
  stage?: unknown
}

/** Lines that are a patch rather than a description of one. */
const DIFF_LINE = /^(diff --git |@@ -\d|\+\+\+ [ab/]|--- [ab/]|index [0-9a-f]{7,}\.\.[0-9a-f]{7,})/m

/** True when text reads as a diff: a patch header, or mostly +/- lines. */
export function looksLikeDiff(text: string): boolean {
  if (DIFF_LINE.test(text)) return true
  const lines = text.split("\n").filter((l) => l.trim())
  if (lines.length < 4) return false
  const pm = lines.filter((l) => /^[+-](?![+-]|\s*$)/.test(l) && !/^[-+]\s/.test(l)).length
  return pm / lines.length > 0.5
}

const strings = (v: unknown, max: number): string[] | undefined => {
  if (v === undefined || v === null || v === "") return undefined
  const arr = Array.isArray(v) ? v : [v]
  const out = arr.map((x) => (typeof x === "string" ? x : x && typeof x === "object" ? JSON.stringify(x) : String(x))).map((s) => s.trim()).filter(Boolean)
  return out.length ? out.slice(0, max).map((s) => s.slice(0, 2000)) : undefined
}

const pairs = (v: unknown): { before: string; after: string }[] | undefined => {
  if (v === undefined || v === null) return undefined
  const arr = Array.isArray(v) ? v : [v]
  const out: { before: string; after: string }[] = []
  for (const x of arr) {
    if (x && typeof x === "object" && "before" in x && "after" in x)
      out.push({ before: String((x as any).before).slice(0, 2000), after: String((x as any).after).slice(0, 2000) })
    else if (typeof x === "string" && x.trim()) {
      const m = /^\s*before:?\s*([\s\S]*?)\s*after:?\s*([\s\S]*)$/i.exec(x)
      out.push(m ? { before: m[1], after: m[2] } : { before: "", after: x })
    }
  }
  return out.length ? out.slice(0, 10) : undefined
}

export type Checked = { ok: true; evidence: Omit<Evidence, "who" | "at"> } | { ok: false; error: string }

/**
 * Check what an agent attached. `base` is where relative screenshot paths are
 * looked for; a path that is not there is refused, a URL is taken as given.
 */
export function validate(input: EvidenceInput, o: { risky: boolean; base?: string; exists?: (p: string) => boolean }): Checked {
  const exists = o.exists ?? ((p: string) => fs.existsSync(p))
  const summary = typeof input.summary === "string" ? input.summary.trim() : ""
  if (summary.length < 10) return { ok: false, error: "evidence needs a summary: what changed in behaviour, in a sentence or two of plain language" }
  const tests = strings(input.tests, 50)
  const evals = strings(input.evals, 50)
  const before_after = pairs(input.before_after)
  const screenshots = strings(input.screenshots, 20)
  const all = [summary, ...(tests ?? []), ...(evals ?? []), ...(before_after ?? []).flatMap((p) => [p.before, p.after])]
  if (all.some(looksLikeDiff))
    return { ok: false, error: "that reads as a diff. Evidence is what the software now does differently, in plain words, with proof (tests, evals, before and after, screenshots); nobody reads the code" }
  if (o.risky && !tests && !evals && !before_after && !screenshots)
    return { ok: false, error: "a risky feature's evidence needs proof as well as the summary: tests that pass, evals, a before and after, or screenshots" }
  for (const s of screenshots ?? []) {
    if (/^https?:\/\//.test(s)) continue
    const p = path.isAbsolute(s) || !o.base ? s : path.join(o.base, s)
    if (!exists(p)) return { ok: false, error: `no screenshot at ${s}` }
  }
  const stage = typeof input.stage === "string" && input.stage.trim() ? input.stage.trim() : "merge"
  return {
    ok: true,
    evidence: {
      summary: summary.slice(0, 4000),
      ...(tests ? { tests } : {}),
      ...(evals ? { evals } : {}),
      ...(before_after ? { before_after } : {}),
      ...(screenshots ? { screenshots } : {}),
      stage,
    },
  }
}

/** Evidence as a person reads it in a question: a few lines, never code. */
export function describe(e: Evidence | undefined, max = 900): string {
  if (!e) return "no evidence attached"
  const out: string[] = [e.summary]
  if (e.tests?.length) out.push(`Tests: ${e.tests.join("; ")}`)
  if (e.evals?.length) out.push(`Evals: ${e.evals.join("; ")}`)
  for (const p of e.before_after ?? []) out.push(`Before: ${p.before} After: ${p.after}`)
  if (e.screenshots?.length) out.push(`Screenshots: ${e.screenshots.join(", ")}`)
  const s = out.join("\n")
  return s.length > max ? s.slice(0, max - 1) + "…" : s
}

/** The newest evidence for a stage, "merge" being the one before merging. */
export const latestFor = (list: Evidence[] | undefined, stage: string) => [...(list ?? [])].reverse().find((e) => e.stage === stage)
