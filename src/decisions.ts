// The decisions log. When either side's Claude marks something settled, it is
// appended here with attribution. Two people pairing with agents settle things
// constantly and record almost none of it.

import fs from "node:fs"
import path from "node:path"

export type Decision = {
  text: string
  by: string
  session?: string
  rationale?: string
  ts: number
}

const HEADER = `# Decisions

Appended by crosstalk when either side marks something settled. Newest last.
`

export function appendDecision(repoRoot: string, d: Decision, file = "DECISIONS.md"): string {
  const target = path.join(repoRoot, file)
  if (!fs.existsSync(target)) fs.writeFileSync(target, HEADER)
  const when = new Date(d.ts).toISOString().replace("T", " ").slice(0, 16)
  const who = d.session ? `${d.by}/${d.session}` : d.by
  const lines = [``, `## ${d.text}`, ``, `- ${when} · ${who}`]
  if (d.rationale) lines.push(`- ${d.rationale}`)
  fs.appendFileSync(target, lines.join("\n") + "\n")
  return target
}

export function readDecisions(repoRoot: string, file = "DECISIONS.md"): string {
  try {
    return fs.readFileSync(path.join(repoRoot, file), "utf8")
  } catch {
    return ""
  }
}
