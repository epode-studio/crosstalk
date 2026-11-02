// The MCP tool for sessions and attention, for a session without the mod:
// its questions arrive as a systemMessage the person reads, and the person's
// answer in plain words reaches this. src/tools/ resolves an action of the
// eight tools to one of these names and calls callTool.

import { request } from "../client.ts"

const ok = (t: string) => ({ content: [{ type: "text" as const, text: t }] })
const err = (m: string) => ({ content: [{ type: "text" as const, text: `crosstalk error: ${m}` }], isError: true })

export async function callTool(name: string, a: any, o: { sessionId: string; cwd: string }) {
  if (name !== "crosstalk_attention") return null
  const r = await request({ op: "attn_act", sessionId: o.sessionId, cwd: o.cwd, id: String(a.id ?? ""), action: "answer", value: String(a.answer ?? "") }, 120_000)
  return r?.ok ? ok(r.text ?? "Answered.") : err(r?.error ?? r?.text ?? "no answer")
}
