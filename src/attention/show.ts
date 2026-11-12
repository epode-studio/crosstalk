// "show me api" for a session the person runs themselves: its tab, brought to
// the front through the focus adapters (focus.ts). Background agents are
// src/spawn.ts's show(), which opens a tab attached to them; this is what it
// falls back to when the name is not a background agent's, and what a click on
// crosstalk's notification runs (`crosstalk attn focus`).

import * as R from "../restore.ts"
import * as F from "./focus.ts"

export function focusSession(o: { sessionId?: string; name?: string; env?: NodeJS.ProcessEnv; sys?: F.Sys; recs?: R.Rec[] }): { ok: boolean; text: string; found: boolean } {
  const recs = o.recs ?? F.liveRecs()
  const rec = (o.sessionId ? recs.find((r) => r.sessionId === o.sessionId) : undefined) ?? (o.name ? F.findRec(o.name, recs) : undefined)
  if (!rec) return { ok: false, found: false, text: `◢ crosstalk: no open session called ${o.name ?? o.sessionId ?? "that"}.` }
  const label = rec.name ?? rec.sessionId.slice(0, 8)
  const r = F.focusTerm(rec.terminal, o.sys ?? F.liveSys(o.env))
  if (r.ok) return { ok: true, found: true, text: `◢ crosstalk: brought ${label} to the front${r.kind ? ` (${r.kind})` : ""}.` }
  // Its terminal looked and no tab has it any more: as good as no tab (it runs on without one).
  if (r.gone) return { ok: false, found: false, text: `◢ crosstalk: ${label} has no tab open any more.` }
  return {
    ok: false,
    found: true,
    text: `◢ crosstalk: ${label} is in ${R.appName(rec.terminal) || "a terminal"} that cannot be brought to the front from outside. It is in ${rec.cwd}.`,
  }
}
