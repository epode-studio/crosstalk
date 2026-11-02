// The disk budget (docs/design/next-generation.md, "Disk"): one question when
// Claude Code's leftovers pass a threshold, and a standing rule once the
// person has said yes to it twice.
//
//   "Worktrees and old sessions are using 18 GB; free 14 GB from 6 finished
//    threads?"                          Free it / Show me / Not now
//
//   Free it    removes exactly what was counted, after checking each item
//              again (scan.ts free)
//   Show me    the list, and the question again without Show me
//   Not now    not asked again for a week, or until the reclaimable total
//              doubles
//
// The second "Free it" offers "Free it by itself from now on?". That rule is
// this machine's, kept here: the repo's standing rules (src/rules) are the
// team's answers and are sealed to everyone in a repo, and one person's disk
// is nobody else's business. With the rule on, a check over budget frees what
// it finds and says so in the digest; "crosstalk_disk {rule: false}" undoes it.
//
// Nothing is deleted without one of those yeses.

import fs from "node:fs"
import path from "node:path"
import { ROOT } from "../config.ts"
import * as S from "./scan.ts"

export const FREE = "Free it"
export const SHOW = "Show me"
export const NOT_NOW = "Not now"
export const ALWAYS = "Free it by itself"

export const thresholdKb = () => Number(process.env.CROSSTALK_DISK_BUDGET_GB ?? 5) * 1024 * 1024
const WEEK = 7 * S.DAY

export type State = {
  v: 1
  /** The scan the person was last shown or asked about: what "Free it" frees. */
  report?: S.Report
  askedAt?: number
  notNowAt?: number
  notNowKb?: number
  frees: number
  ruleOffered?: boolean
  rule?: boolean
  questionId?: string
}

const file = () => path.join(process.env.CROSSTALK_HOME ?? ROOT, "disk.json")

export function load(): State {
  try {
    const s = JSON.parse(fs.readFileSync(file(), "utf8"))
    if (s?.v === 1) return { frees: 0, ...s }
  } catch {}
  return { v: 1, frees: 0 }
}

export function save(s: State) {
  fs.mkdirSync(path.dirname(file()), { recursive: true, mode: 0o700 })
  const tmp = `${file()}.${process.pid}.tmp`
  fs.writeFileSync(tmp, JSON.stringify(s), { mode: 0o600 })
  fs.renameSync(tmp, file())
}

export const questionText = (r: S.Report) =>
  `Worktrees and old sessions are using ${S.human(r.usedKb)}; free ${S.human(r.reclaimKb)} from ${r.groups} finished thread${r.groups === 1 ? "" : "s"}?`

export const ruleQuestion = () => `That is twice you said free it. Free finished threads' disk by itself from now on, whenever it passes ${S.human(thresholdKb())}?`

/** The list, for "Show me" and the tool. */
export function listing(r: S.Report): string {
  if (!r.reclaim.length) return `◢ crosstalk: nothing to free. Claude Code's worktrees and sessions use ${S.human(r.usedKb)}, all of it in use or not finished.`
  const lines = [`◢ crosstalk: ${S.human(r.reclaimKb)} can be freed from ${r.groups} finished thread${r.groups === 1 ? "" : "s"} (of ${S.human(r.usedKb)} in Claude Code's worktrees and sessions):`]
  const groups = new Map<string, S.Item[]>()
  for (const i of r.reclaim) (groups.get(i.group) ?? groups.set(i.group, []).get(i.group)!).push(i)
  for (const [g, items] of [...groups].sort((a, b) => b[1].reduce((s, i) => s + i.kb, 0) - a[1].reduce((s, i) => s + i.kb, 0))) {
    lines.push(`  ${g}  (${S.human(items.reduce((s, i) => s + i.kb, 0))})`)
    for (const i of items.slice(0, 6)) lines.push(`    ${i.kind === "worktree" ? "worktree  " : "transcript"} ${i.path}  ${S.human(i.kb)}: ${i.why}`)
    if (items.length > 6) lines.push(`    … and ${items.length - 6} more`)
  }
  if (r.kept.length) lines.push(`Kept: ${r.kept.length} worktree${r.kept.length === 1 ? "" : "s"} (${[...new Set(r.kept.map((k) => k.why))].join("; ")}).`)
  lines.push(`Nothing is removed until you say so: "free it".`)
  return lines.join("\n")
}

export type Deps = {
  scan: () => Promise<S.Report>
  free: (confirmed: S.Item[], fresh: S.Report) => S.Freed[]
  /** Put a question to the person; returns its id. */
  ask: (o: { id: string; question: string; options: string[] }) => void
  settle: (id: string) => void
  digest: (id: string, text: string) => void
  now?: () => number
  log?: (...a: unknown[]) => void
}

export class Budget {
  constructor(private d: Deps) {}
  private now = () => (this.d.now ? this.d.now() : Date.now())

  /** A periodic check: ask, or free by the standing rule, when over budget. */
  async check(): Promise<{ asked?: boolean; freed?: S.Freed[] }> {
    const s = load()
    const now = this.now()
    if (s.questionId && s.askedAt && now - s.askedAt < S.DAY) return {}
    const r = await this.d.scan()
    if (r.reclaimKb < thresholdKb()) return {}
    if (s.rule) {
      const freed = this.d.free(r.reclaim, r)
      const kb = freed.filter((f) => f.ok).reduce((a, f) => a + f.kb, 0)
      this.d.digest(`disk:auto:${now}`, `◢ crosstalk: freed ${S.human(kb)} from ${r.groups} finished thread${r.groups === 1 ? "" : "s"} by your standing rule (worktrees merged and done with, sessions whose folder is gone). Say "stop freeing disk by itself" to undo it.`)
      this.d.log?.(`disk: freed ${S.human(kb)} by the standing rule`)
      return { freed }
    }
    if (s.notNowAt && now - s.notNowAt < WEEK && r.reclaimKb < 2 * (s.notNowKb ?? 0)) return {}
    const id = `disk:${now}`
    if (s.questionId) this.d.settle(s.questionId)
    this.d.ask({ id, question: questionText(r), options: [FREE, SHOW, NOT_NOW] })
    save({ ...s, report: r, askedAt: now, questionId: id })
    return { asked: true }
  }

  /** The person's answer to either question. */
  async answer(id: string, value: string): Promise<{ ok: boolean; text: string }> {
    const s = load()
    const v = value.trim()
    if (id.startsWith("disk-rule:")) {
      s.ruleOffered = true
      s.rule = v === ALWAYS
      save(s)
      return { ok: true, text: s.rule ? `Done: from now on finished threads' disk is freed by itself once it passes ${S.human(thresholdKb())}, and the digest says what went.` : "Fine: you will be asked each time." }
    }
    if (v === SHOW) {
      const r = s.report ?? (await this.d.scan())
      const next = `${id}:again`
      this.d.ask({ id: next, question: questionText(r), options: [FREE, NOT_NOW] })
      save({ ...s, report: r, questionId: next, askedAt: this.now() })
      return { ok: true, text: listing(r) }
    }
    if (v === FREE) return this.freeNow(s)
    save({ ...s, questionId: undefined, notNowAt: this.now(), notNowKb: s.report?.reclaimKb ?? 0 })
    return { ok: true, text: `Kept everything. Say "free the disk" any time.` }
  }

  /** "Free it": what the person was shown, still finished on a fresh look. */
  async freeNow(s = load()): Promise<{ ok: boolean; text: string }> {
    const fresh = await this.d.scan()
    const confirmed = s.report && this.now() - s.report.at < S.DAY ? s.report.reclaim : fresh.reclaim
    const freed = this.d.free(confirmed, fresh)
    const ok = freed.filter((f) => f.ok)
    const kb = ok.reduce((a, f) => a + f.kb, 0)
    s.frees = (s.frees ?? 0) + 1
    s.questionId = undefined
    s.report = undefined
    const lines = [`◢ crosstalk: freed ${S.human(kb)} (${ok.length} item${ok.length === 1 ? "" : "s"}).`]
    for (const f of freed.filter((x) => !x.ok).slice(0, 5)) lines.push(`  kept ${f.path}: ${f.why}`)
    if (s.frees >= 2 && !s.ruleOffered && !s.rule) {
      s.ruleOffered = true
      this.d.ask({ id: `disk-rule:${this.now()}`, question: ruleQuestion(), options: [ALWAYS, NOT_NOW] })
    }
    save(s)
    this.d.log?.(`disk: freed ${S.human(kb)} on the person's yes`)
    return { ok: true, text: lines.join("\n") }
  }

  setRule(on: boolean): string {
    const s = load()
    s.rule = on
    s.ruleOffered = true
    save(s)
    return on ? `◢ crosstalk: finished threads' disk is freed by itself from now on, once it passes ${S.human(thresholdKb())}.` : "◢ crosstalk: disk is only freed when you say so."
  }
}
