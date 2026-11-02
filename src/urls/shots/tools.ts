// The MCP tools for screenshots (docs/urls.md, "Screenshots as evidence").
// src/tools/ resolves an action of one of the eight tools to one of these names and calls callTool.
// Neither needs a room or the daemon.

import * as S from "./index.ts"

const text = (out: { ok: boolean; text: string }) => ({ content: [{ type: "text" as const, text: out.text }], ...(out.ok ? {} : { isError: true }) })

export async function callTool(name: string, a: any, o: { sessionId: string; cwd: string }) {
  switch (name) {
    case "crosstalk_screenshot":
      return text(
        await S.captureFor({
          sessionId: o.sessionId || undefined,
          cwd: o.cwd,
          thread: a.thread ? String(a.thread) : undefined,
          url: a.url ? String(a.url) : undefined,
          path: a.path,
          reason: "demand",
        }),
      )
    case "crosstalk_screenshots":
      return text(S.openPair({ sessionId: o.sessionId || undefined, cwd: o.cwd, thread: a.thread ? String(a.thread) : undefined, name: a.name ? String(a.name) : undefined, open: a.open === true }))
    default:
      return null
  }
}
