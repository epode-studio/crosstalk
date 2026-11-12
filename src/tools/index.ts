// crosstalk's MCP tools: four, one per thing a person holds in their head
// (src/tools/four.ts). Every definition here is loaded into every session on
// every turn, so they stay short; the work is done by the handlers in
// legacy.ts, which each action resolves to.
//
//   sessions  the user's Claude Code sessions: spawn, show, close, restore, services
//   work      a piece of work: notes, tasks, what it runs, shipping it
//   inbox     the user's answers to crosstalk's questions; how crosstalk is doing
//   people    the people the user works with, and talking to them
//
// The eight earlier tools (thread, say, work, look, ship, people, answer,
// doctor) still resolve by name, for sessions started on an older crosstalk.
// Where a name is both (crosstalk_work, crosstalk_people), the new tool's
// actions come first and the earlier tool's still answer.

import { callLegacy, type Ctx, type Result } from "./legacy.ts"
import type { Args, Route, Tool } from "./kit.ts"
import { FOUR, EARLIER } from "./four.ts"

const BY_NAME = new Map<string, Tool[]>()
for (const t of [...FOUR, ...EARLIER]) BY_NAME.set(t.def.name, [...(BY_NAME.get(t.def.name) ?? []), t])

export const TOOLS = FOUR.map((t) => t.def)

/** The handler a call resolves to, or why it does not. */
export function resolve(tool: string, a: Args): Route {
  const ts = BY_NAME.get(tool)
  if (!ts) return { error: `unknown tool ${tool}` }
  const t = ts.find((x) => typeof a.action === "string" && x.actions.includes(a.action))
  if (!t) return { error: `${tool} needs an action: one of ${ts[0]!.actions.join(", ")}` }
  return t.route(a)
}

const err = (m: string): Result => ({ content: [{ type: "text", text: `crosstalk error: ${m}` }], isError: true })

export async function callTool(tool: string, a: Args, o: Ctx): Promise<Result> {
  const r = resolve(tool, a ?? {})
  if ("error" in r) return err(r.error)
  return (await callLegacy(r.name, r.args, o)) ?? err(`unknown tool ${tool}`)
}
