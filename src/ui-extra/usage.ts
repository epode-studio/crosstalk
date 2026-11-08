// Credit usage, for the main session's pane: each session's mod reports what its
// session has cost and the plan's rate-limit windows (`$.session.usage()`), at
// the end of each turn; the pane sums it up.
//
//   per session   usage/<session>.json: { usd, limits, at }
//   the account   the most recent report's windows (five_hour, seven_day, a
//                 gateway's spend_limit): how much is used and when it resets
//   crossing      80% and 90% of a window, once each per window, go to the
//                 main session's Lately (src/urls/ci.ts recordEvent)

import fs from "node:fs"
import path from "node:path"
import { P } from "../config.ts"
import { recordEvent } from "../urls/ci.ts"

export type Limit = { kind: string; percentUsed: number; resetsAt?: string }
export type Report = { usd?: number; limits: Limit[]; at: number }

const dir = () => path.join(P.root, "usage")
const safe = (id: string) => id.replace(/[^A-Za-z0-9._-]/g, "_")

export function write(sessionId: string, r: Report, now = Date.now()) {
  fs.mkdirSync(dir(), { recursive: true, mode: 0o700 })
  const before = latest()
  fs.writeFileSync(path.join(dir(), `${safe(sessionId)}.json`), JSON.stringify(r), { mode: 0o600 })
  crossed(before?.limits ?? [], r.limits, now)
}

export function read(sessionId: string): Report | null {
  try {
    return JSON.parse(fs.readFileSync(path.join(dir(), `${safe(sessionId)}.json`), "utf8"))
  } catch {
    return null
  }
}

/** Every session's report, by session. */
export function all(): Map<string, Report> {
  const out = new Map<string, Report>()
  let names: string[] = []
  try {
    names = fs.readdirSync(dir()).filter((n) => n.endsWith(".json"))
  } catch {}
  for (const n of names)
    try {
      out.set(n.slice(0, -5), JSON.parse(fs.readFileSync(path.join(dir(), n), "utf8")))
    } catch {}
  return out
}

/** The newest report that has windows: the account's, as of then. */
export function latest(reports = all()): Report | null {
  let best: Report | null = null
  for (const r of reports.values()) if (r.limits?.length && (!best || r.at > best.at)) best = r
  return best
}

const WORD: Record<string, string> = { five_hour: "5-hour", seven_day: "week", spend_limit: "spend limit" }

/** When a window resets, said short: `3:10 PM`, or `Tue` when not today. */
export function resetText(iso: string | undefined, now: number): string {
  if (!iso) return ""
  const t = Date.parse(iso)
  if (!Number.isFinite(t)) return ""
  const d = new Date(t)
  const same = new Date(now).toDateString() === d.toDateString()
  return same ? d.toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit" }) : d.toLocaleDateString("en-US", { weekday: "short" })
}

/** The pane's usage line, and whether it needs a look (a window at 80% or more). */
export function line(o: { reports?: Map<string, Report>; now?: number } = {}): { text: string; hot: boolean } | null {
  const reports = o.reports ?? all()
  const now = o.now ?? Date.now()
  const acct = latest(reports)
  const parts: string[] = []
  let hot = false
  for (const l of acct?.limits ?? []) {
    if (l.percentUsed >= 80) hot = true
    const r = resetText(l.resetsAt, now)
    parts.push(`${WORD[l.kind] ?? l.kind} ${Math.round(l.percentUsed)}%${r ? ` (resets ${r})` : ""}`)
  }
  // Today's spend: the sessions that reported today.
  const day = new Date(now).toDateString()
  let usd = 0
  let n = 0
  for (const r of reports.values()) {
    if (typeof r.usd !== "number" || new Date(r.at).toDateString() !== day) continue
    usd += r.usd
    n++
  }
  void n
  void usd
  return parts.length ? { text: parts.join(" · "), hot } : null
}

/** 80% and 90% of a window, said once each per window: a reset starts it again. */
function crossed(before: Limit[], after: Limit[], now: number) {
  for (const a of after) {
    const b = before.find((x) => x.kind === a.kind)
    const fresh = !b || b.resetsAt !== a.resetsAt
    for (const mark of [80, 90])
      if (a.percentUsed >= mark && (fresh || b!.percentUsed < mark)) {
        recordEvent(`${WORD[a.kind] ?? a.kind} limit at ${Math.round(a.percentUsed)}%${a.resetsAt ? `, resets ${resetText(a.resetsAt, now)}` : ""}`, now)
        break
      }
  }
}

/** `$1.20`, for an agent's line. */
export const usdText = (usd: number | undefined) => (typeof usd === "number" && usd > 0 ? `$${usd < 10 ? usd.toFixed(2) : usd.toFixed(0)}` : "")
