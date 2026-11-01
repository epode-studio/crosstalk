// The terminal workspace's MCP tools: new agents, watching a background one,
// and cleaning up finished worktrees. src/server.ts lists TOOLS and hands any
// call it does not know to callTool. None needs a room or the daemon.

import * as spawn from "../spawn.ts"
import * as cleanup from "../cleanup.ts"
import * as ui from "../uistate.ts"

export const TOOLS = [
  {
    name: "crosstalk_spawn",
    description:
      "Start new Claude agents on a task, each in its own private copy of this repository (a git worktree on a new branch, dependencies shared, not copied) and its own tab in the user's terminal, in the window that already holds this repository. Call this whenever the user asks for more agents or another agent, e.g. \"put two more on auth\" (count 2, task about auth), \"start an agent to fix the flaky login test\", \"get someone on the docs\", \"spin up three agents for the migration\". Write `task` as the full instruction the new agent should start from, with the context it needs from this conversation. Use background: true when the user wants it to run in the background or out of sight (\"in the background\", \"without a window\"); it then keeps running when windows close and \"show me <name>\" opens it. Relay the result text to the user as it is.",
    inputSchema: {
      type: "object",
      properties: {
        task: { type: "string", description: "What each new agent should do: its first prompt, complete enough to start on its own" },
        count: { type: "number", description: "How many agents, default 1, at most 8" },
        name: { type: "string", description: "A short name for the agent(s), e.g. auth; several become auth-1, auth-2" },
        background: { type: "boolean", description: "true runs it in crosstalk's background tmux instead of a tab" },
      },
      required: ["task"],
    },
  },
  {
    name: "crosstalk_show",
    description:
      "Open a tab in the user's terminal attached to an agent crosstalk runs in the background, so they can watch or talk to it. Call this when the user asks to see, show, open, watch or attach to an agent, e.g. \"show me auth\". Closing that tab leaves the agent running. Relay the result text to the user as it is.",
    inputSchema: {
      type: "object",
      properties: { name: { type: "string", description: "The agent's name, e.g. auth or auth-2" } },
      required: ["name"],
    },
  },
  {
    name: "crosstalk_cleanup",
    description:
      "Remove agent worktrees that are done with: crosstalk's own worktrees whose branch is merged into the default branch (or deleted) and whose session has ended, reporting the disk space freed. Call this when the user asks to clean up, remove or prune worktrees or free disk space, or answers yes to crosstalk's offer to remove them, e.g. \"clean up the worktrees\". Without confirm it only lists what can go, including merged worktrees crosstalk did not make; call it with confirm: true when the user has agreed. Worktrees crosstalk did not make are removed only when the user names them: pass their paths in include. Relay the result text to the user as it is.",
    inputSchema: {
      type: "object",
      properties: {
        confirm: { type: "boolean", description: "true removes them; false or absent only lists them" },
        include: { type: "array", items: { type: "string" }, description: "Paths of worktrees crosstalk did not make that the user confirmed by name" },
      },
    },
  },
]

const text = (out: { ok: boolean; text: string }) => ({ content: [{ type: "text" as const, text: out.text }], ...(out.ok ? {} : { isError: true }) })

/** The call, or null when the tool is not one of these. */
export function callTool(name: string, a: any, o: { sessionId: string; cwd: string }) {
  switch (name) {
    case "crosstalk_spawn":
      return text(spawn.spawnAgents({ task: String(a.task ?? ""), count: Number(a.count ?? 1), name: a.name, background: !!a.background, cwd: o.cwd, by: o.sessionId || undefined }))
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
