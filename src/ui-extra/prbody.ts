// A pull request's description, written from its thread: the recap, the
// decisions, the evidence of behaviour and what is still open. Shipping
// (src/shipping/engine.ts) passes it to `gh pr create` when it opens a PR.
//
// A pull request can be read by everyone the repository is visible to, which
// is more people than a sealed thread is sealed to. So a sealed thread's
// recap, decisions and questions stay in crosstalk; the PR gets the feature,
// its evidence and its reviewers, and says the rest is in the thread. A public
// thread is committed in plain text already, and gives the PR all of it.

import * as M from "../threads/model.ts"

const line = (s: string) => s.replace(/\s+/g, " ").trim()
const day = (at: number) => new Date(at).toISOString().slice(0, 10)

export function prBody(t: M.Thread, f: M.Item<M.Feature>): string {
  const name = t.meta.value.name
  const sealed = !t.meta.value.public
  const out: string[] = []
  const flag = f.flag ? `, behind the flag \`${f.flag}\`${f.ship?.stage ? ` (now ${f.ship.stage})` : ""}` : ""
  out.push(`**${f.name}**: ${f.risk} work from the crosstalk thread **${name}**${flag}.`)
  if (f.risk === "risky" && f.ship?.why) out.push("", `Risky because: ${line(f.ship.why)}`)

  if (!sealed) {
    out.push("", "## Recap", "", M.recap(t) ? M.recap(t).trim() : "_No recap yet._")
    const decisions = M.notes(t, "decision").sort((a, b) => a.at - b.at)
    out.push("", "## Decisions", "")
    if (decisions.length) for (const d of decisions) out.push(`- ${day(d.at)} · ${d.who} · ${line(d.text)}${d.rationale ? ` (${line(d.rationale)})` : ""}`)
    else out.push("_None recorded._")
  }

  const ev = f.ship?.evidence ?? []
  out.push("", "## Evidence", "")
  if (!ev.length) out.push("_None attached._")
  for (const e of ev) {
    out.push(`- **${e.stage === "merge" ? "before merging" : `at ${e.stage}`}** (${e.who}): ${line(e.summary)}`)
    for (const x of e.tests ?? []) out.push(`  - test: ${line(x)}`)
    for (const x of e.evals ?? []) out.push(`  - eval: ${line(x)}`)
    for (const x of e.before_after ?? []) out.push(`  - before: ${line(x.before) || "nothing"} → after: ${line(x.after)}`)
    for (const x of e.screenshots ?? []) out.push(`  - screenshot: ${x}`)
  }

  if (!sealed) {
    const open = M.live(t, "questions").filter((q) => !q.answer)
    out.push("", "## Open questions", "")
    if (open.length) for (const q of open) out.push(`- ${line(q.text)}${q.blocking ? " **(blocking)**" : ""}`)
    else out.push("_None._")
  } else {
    out.push("", `_The thread **${name}** is sealed to its people, so its recap, decisions and open questions stay in crosstalk (crosstalk_thread action "read")._`)
  }

  const reviewers = (f.ship?.signoff ?? []).map((s) => `${s.kind} (${s.client})`)
  out.push("", "---", `Reviewed by ${reviewers.join(", ") || "crosstalk's reviewers"}. Opened by crosstalk.`)
  return out.join("\n")
}
