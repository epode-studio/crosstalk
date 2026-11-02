// The terminal workspace's MCP tools: new agents, watching a background one,
// and cleaning up finished worktrees. src/tools/ resolves an action of the
// eight tools to one of these names and calls callTool. None needs a room or the daemon.

import * as spawn from "../spawn.ts"
import * as cleanup from "../cleanup.ts"
import * as ui from "../uistate.ts"
import { spawnOn } from "../sessions/tools.ts"

const text = (out: { ok: boolean; text: string }) => ({ content: [{ type: "text" as const, text: out.text }], ...(out.ok ? {} : { isError: true }) })

/** The call, or null when the tool is not one of these. */
export async function callTool(name: string, a: any, o: { sessionId: string; cwd: string }) {
  switch (name) {
    case "crosstalk_spawn":
      // On another of the user's own machines (src/sessions/remote.ts).
      if (typeof a.machine === "string" && a.machine.trim()) return spawnOn(a.machine.trim(), a, o)
      // From a session in a thread, the agents start in it, from its brief (src/spawn.ts).
      return text(
        await spawn.spawnFromSession({
          task: String(a.task ?? ""),
          count: Number(a.count ?? 1),
          name: a.name,
          background: !!a.background,
          cwd: o.cwd,
          by: o.sessionId || undefined,
          threadName: a.thread ? String(a.thread) : undefined,
        }),
      )
    case "crosstalk_show":
      return text(spawn.show({ name: String(a.name ?? ""), cwd: o.cwd, by: o.sessionId || undefined }))
    case "crosstalk_cleanup": {
      const out = cleanup.run({ confirm: !!a.confirm, include: Array.isArray(a.include) ? a.include.map(String) : [], cwd: o.cwd })
      if (a.confirm && o.sessionId) ui.withStore((items, now) => ui.settle(items, cleanup.cleanupId(o.sessionId), "answered", now))
      return text(out)
    }
    default:
      return null
  }
}
