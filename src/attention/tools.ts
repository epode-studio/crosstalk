// The MCP tool for sessions and attention, for a session without the mod:
// its questions arrive as a systemMessage the person reads, and the person's
// answer in plain words reaches this. src/tools/ resolves an action of the
// eight tools to one of these names and calls callTool. crosstalk_auto_merge
// turns merging green PRs without asking on or off (crosstalk_doctor).

import { request } from "../client.ts"

const ok = (t: string) => ({ content: [{ type: "text" as const, text: t }] })
const err = (m: string) => ({ content: [{ type: "text" as const, text: `crosstalk error: ${m}` }], isError: true })

export async function callTool(name: string, a: any, o: { sessionId: string; cwd: string }) {
  if (name === "crosstalk_auto_merge") {
    if (typeof a.on !== "boolean") return err("pass on: true or false")
    const r = await request({ op: "attn_merge_rule", sessionId: o.sessionId, cwd: o.cwd, on: a.on }, 10_000)
    return r?.ok ? ok(r.text) : err(r?.error ?? "the daemon did not answer")
  }
  if (name !== "crosstalk_attention") return null
  const r = await request({ op: "attn_act", sessionId: o.sessionId, cwd: o.cwd, id: String(a.id ?? ""), action: "answer", value: String(a.answer ?? "") }, 120_000)
  return r?.ok ? ok(r.text ?? "Answered.") : err(r?.error ?? r?.text ?? "no answer")
}
