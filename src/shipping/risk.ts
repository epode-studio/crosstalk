// Which features are risky.
//
// A repo says which of its paths are risky in `.crosstalk/risk`:
//
//   # anything here gets an adversarial reviewer, evidence and a flag
//   high: src/auth/** migrations/**
//   high: infra/*.tf
//   everyday: src/auth/**/*.test.ts      # exceptions to the above
//
// `high:` (or `risky:`) lines list globs; a feature whose branch touches one
// is risky. `everyday:` lines list globs a change may touch without counting.
// A glob with no slash matches a file name at any depth, as in .gitignore;
// `**` is any number of folders, `*` and `?` stay within one.
//
// Risk only ratchets up on its own. An agent may make a feature risky at any
// time; making one everyday again is always a question to a person, and no
// standing rule answers it.

import type { Risk } from "../threads/model.ts"

export type RiskRules = { high: string[]; everyday: string[] }

export const RISK_FILE = ".crosstalk/risk"

export function parseRisk(text: string): RiskRules {
  const out: RiskRules = { high: [], everyday: [] }
  let cur: keyof RiskRules | null = null
  for (const raw of text.split("\n")) {
    const line = raw.replace(/(^|\s)#.*$/, "").trimEnd()
    if (!line.trim()) continue
    const m = /^\s*(high|risky|everyday|low)\s*:\s*(.*)$/i.exec(line)
    let rest: string
    if (m) {
      cur = /^(high|risky)$/i.test(m[1]) ? "high" : "everyday"
      rest = m[2]
    } else if (cur && /^\s/.test(raw)) rest = line.replace(/^\s*-\s*/, "")
    else continue
    for (const g of rest.split(/[\s,]+/).filter(Boolean)) out[cur].push(g.replace(/^\.\//, ""))
  }
  return out
}

const reCache = new Map<string, RegExp>()

/** A glob as a regular expression over a repo-relative path. */
export function globRe(glob: string): RegExp {
  const hit = reCache.get(glob)
  if (hit) return hit
  let g = glob.replace(/^\/+/, "")
  if (g.endsWith("/")) g += "**"
  if (!g.includes("/")) g = `**/${g}`
  let re = ""
  for (let i = 0; i < g.length; i++) {
    const c = g[i]
    if (c === "*" && g[i + 1] === "*") {
      // `**/` is zero or more folders; a trailing `**` is anything below.
      if (g[i + 2] === "/") {
        re += "(?:[^/]+/)*"
        i += 2
      } else {
        re += ".*"
        i += 1
      }
    } else if (c === "*") re += "[^/]*"
    else if (c === "?") re += "[^/]"
    else re += c.replace(/[.+^${}()|[\]\\]/g, "\\$&")
  }
  const out = new RegExp(`^${re}$`)
  reCache.set(glob, out)
  return out
}

export const matches = (glob: string, file: string) => globRe(glob).test(file.replace(/^\.\//, ""))

/** The risky paths among these files, each with the rule that made it so. */
export function riskyPaths(files: string[], rules: RiskRules): { file: string; glob: string }[] {
  const out: { file: string; glob: string }[] = []
  for (const f of files) {
    if (rules.everyday.some((g) => matches(g, f))) continue
    const g = rules.high.find((g) => matches(g, f))
    if (g) out.push({ file: f, glob: g })
  }
  return out
}

/** What the rules say about a change, and why, in words. */
export function assess(files: string[], rules: RiskRules): { risk: Risk; why?: string } {
  const hits = riskyPaths(files, rules)
  if (!hits.length) return { risk: "everyday" }
  const globs = [...new Set(hits.map((h) => h.glob))]
  const names = hits.slice(0, 3).map((h) => h.file)
  return { risk: "risky", why: `touches ${names.join(", ")}${hits.length > 3 ? ` and ${hits.length - 3} more` : ""} (${globs.join(" ")} in ${RISK_FILE})` }
}

export type Ratchet =
  /** The risk to record now. */
  | { risk: Risk; changed: boolean; ask?: undefined }
  /** Lowering: the risk stays, and a person is asked. */
  | { risk: Risk; changed: false; ask: true }

/**
 * Risk moves up freely and down only through a person. `byPerson` is true
 * only for the answer to that question, never for an agent or a rule.
 */
export function ratchet(current: Risk | undefined, want: Risk, o: { byPerson?: boolean } = {}): Ratchet {
  const cur = current ?? "everyday"
  if (want === cur) return { risk: cur, changed: false }
  if (want === "risky") return { risk: "risky", changed: true }
  if (o.byPerson) return { risk: "everyday", changed: true }
  return { risk: cur, changed: false, ask: true }
}

/** The higher of two risks. */
export const higher = (a: Risk | undefined, b: Risk | undefined): Risk => (a === "risky" || b === "risky" ? "risky" : "everyday")
