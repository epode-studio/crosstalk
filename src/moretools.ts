// MCP tools for disk, team install, local stats and leaving a thread
// (src/extras.ts runs them in the daemon). An action of one of
// the eight tools (src/tools/) resolves to one of these names.

import { request } from "./client.ts"

const ok = (o: unknown) => ({ content: [{ type: "text" as const, text: typeof o === "string" ? o : JSON.stringify(o, null, 2) }] })
const err = (m: string) => ({ content: [{ type: "text" as const, text: `crosstalk error: ${m}` }], isError: true })
const reply = (r: any) => (r?.ok ? ok(r.text ?? { ...r, ok: undefined }) : err(r?.error ?? r?.text ?? "no answer"))

/** The call, or null when the tool is not one of these. */
export async function callTool(name: string, a: any, o: { sessionId: string; cwd: string }) {
  const base = { sessionId: o.sessionId, cwd: o.cwd }
  switch (name) {
    case "crosstalk_disk":
      return reply(await request({ op: "disk", ...base, confirm: a.confirm, rule: a.rule }, 300_000))
    case "crosstalk_stats":
      return reply(await request({ op: "stats", ...base, weeks: a.weeks }, 60_000))
    case "crosstalk_team_install":
      return reply(await request({ op: "team_install", ...base, confirm: a.confirm, repo: a.repo }, 60_000))
    case "crosstalk_thread_person":
      return reply(await request({ op: "thread_person", ...base, person: a.person, thread: a.thread }))
    default:
      return null
  }
}
