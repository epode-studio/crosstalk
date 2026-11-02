// The MCP tools for services (docs/services.md): run something long-running
// so it outlives this session, list them, read a log, stop one. An action of one of
// the eight tools (src/tools/) resolves to one of these names. None needs a
// room or the daemon.

import path from "node:path"
import * as S from "./service.ts"

const text = (out: { ok: boolean; text: string }) => ({ content: [{ type: "text" as const, text: out.text }], ...(out.ok ? {} : { isError: true }) })

export async function callTool(name: string, a: any, o: { sessionId: string; cwd: string }) {
  const here = (c: unknown) => (typeof c === "string" && c.trim() ? path.resolve(o.cwd, c) : o.cwd)
  switch (name) {
    case "crosstalk_serve":
      return text(
        S.serve({
          command: String(a.command ?? ""),
          name: a.name ? String(a.name) : undefined,
          cwd: here(a.cwd),
          port: a.port === undefined ? undefined : Number(a.port),
          by: o.sessionId || undefined,
        }),
      )
    case "crosstalk_services":
      return text(S.describe({ cwd: o.cwd, name: a.name ? String(a.name) : undefined, tail: a.tail === undefined ? undefined : Number(a.tail) || 40 }))
    case "crosstalk_stop":
      return text(S.stop({ name: String(a.name ?? ""), cwd: o.cwd }))
    default:
      return null
  }
}
