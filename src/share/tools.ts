// The MCP tools for sharing a running server (docs/urls.md, "Sharing"):
// "show marie the auth page", "stop sharing it", "what am I sharing?".
// src/tools/ resolves an action of one of the eight tools to one of these names and calls callTool.
// The daemon does the work: it holds the peers and the relay link.

import { ensureDaemon, request } from "../client.ts"

const text = (r: any) => ({ content: [{ type: "text" as const, text: String(r?.text ?? r?.error ?? "crosstalk: no answer") }], ...(r?.ok ? {} : { isError: true }) })

export async function callTool(name: string, a: any, o: { sessionId: string; cwd: string }) {
  if (name !== "crosstalk_share" && name !== "crosstalk_unshare" && name !== "crosstalk_shares") return null
  if (!(await ensureDaemon())) return text({ ok: false, error: "crosstalk: the daemon is not running, and sharing goes through it" })
  const op = name === "crosstalk_share" ? "share" : name === "crosstalk_unshare" ? "unshare" : "shares"
  const r = await request({ op, sessionId: o.sessionId, cwd: o.cwd, ...a }, 90_000).catch((e) => ({ ok: false, error: `crosstalk: ${(e as Error).message}` }))
  return text(r)
}
