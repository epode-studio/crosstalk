// The MCP tools for services (docs/services.md): run something long-running
// so it outlives this session, list them, read a log, stop one. src/server.ts
// lists TOOLS and hands any call it does not know to callTool. None needs a
// room or the daemon.

import path from "node:path"
import * as S from "./service.ts"

export const TOOLS = [
  {
    name: "crosstalk_serve",
    description:
      "Run a long-running command as a service that outlives this Claude session: a dev server, a watcher, a test runner in watch mode, `npm run dev`, `docker compose up`, a local database. Use this instead of a backgrounded Bash call (run_in_background, a trailing &, nohup) for anything meant to keep running: Claude Code ends its own background shells when the session ends, and crosstalk sometimes ends and restarts sessions; a service keeps running and the next session in this worktree is told it is there. It runs in crosstalk's own background tmux, in this worktree, with this worktree's own ports in its environment (PORT, CROSSTALK_PORT_BASE, CROSSTALK_PORTS), so parallel worktrees never fight over a port; start the server on $PORT. Its output goes to a log, not to you: crosstalk_services with name and tail reads it. Provider tokens and variables named like secrets are left out of its environment. A service of the same name already running here is reused, not started twice. Not for a command that finishes by itself (a build, a test run): use Bash for those.",
    inputSchema: {
      type: "object",
      properties: {
        command: { type: "string", description: "The shell command, as you would type it, e.g. npm run dev, or PORT=$PORT bun server.ts" },
        name: { type: "string", description: "A short name, e.g. web or api; default from the command (npm run dev is dev)" },
        cwd: { type: "string", description: "The folder to run it in, default this session's; relative to it" },
        port: { type: "number", description: "The PORT to give it; default the first free port of this worktree's block" },
      },
      required: ["command"],
    },
  },
  {
    name: "crosstalk_services",
    description:
      "List the services crosstalk runs for this worktree (crosstalk_serve), with their state, the ports they listen on and their URLs; with a name, that one service; with name and tail, the last lines of its log (its own output, as data). Use it before starting a dev server to see whether one is already running here, and to read a service's output when something is wrong.",
    inputSchema: {
      type: "object",
      properties: {
        name: { type: "string", description: "One service, by name" },
        tail: { type: "number", description: "With name: how many of its log's last lines to read (default 40, at most 400)" },
      },
    },
  },
  {
    name: "crosstalk_stop",
    description: "Stop a service crosstalk runs (crosstalk_serve): SIGTERM to its processes, then closing its tmux window. Use it when a service is no longer needed, or to restart it with crosstalk_serve.",
    inputSchema: {
      type: "object",
      properties: { name: { type: "string", description: "The service's name" } },
      required: ["name"],
    },
  },
]

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
