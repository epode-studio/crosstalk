// Shipping's MCP tools. Each is one `ship` request to the daemon; the daemon's
// engine (src/shipping/engine.ts) does the work. An action of one of
// the eight tools (src/tools/) resolves to one of these names.

import { request } from "../client.ts"

const ACTIONS: Record<string, string> = {
  crosstalk_feature: "feature",
  crosstalk_ready: "ready",
  crosstalk_review: "review",
  crosstalk_evidence: "evidence",
  crosstalk_flag: "flag",
  crosstalk_incident: "incident",
  crosstalk_ship_status: "status",
}

/** The call, or null when the tool is not one of these. */
export async function callTool(name: string, a: any, o: { sessionId: string; cwd: string }) {
  const action = ACTIONS[name]
  if (!action) return null
  // Never `person`: an agent's call cannot answer a person's question.
  const { person: _p, ...args } = a ?? {}
  const r = await request({ ...args, op: "ship", action, sessionId: o.sessionId, cwd: o.cwd }, 60_000)
  const { ok, text, error: _e, ...rest } = r ?? {}
  const body = Object.keys(rest).length ? `${text ?? ""}\n\n${JSON.stringify(rest, null, 2)}` : String(text ?? r?.error ?? "no answer")
  return { content: [{ type: "text" as const, text: body }], ...(ok ? {} : { isError: true }) }
}
