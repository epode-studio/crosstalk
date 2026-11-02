// crosstalk's MCP tools: eight, each with an action, in place of one per
// feature (docs/design/next-generation.md, "Three nouns"). Every definition
// here is loaded into every session on every turn, so they stay short; the
// work is done by the handlers in legacy.ts, which each action resolves to.
//
//   thread  read a thread; notes; a feature or its status; move, leave, pick
//   say     tell, ask, reply, hand off, read what peers said
//   work    sessions and workers, restore and gather, services, cleanup
//   look    URLs, screenshots, sharing, QR, history, the pane
//   ship    features, review, evidence, flags, incidents
//   people  peers, the team, rooms and words, trust, mute, link, repo questions
//   answer  the user's answer to one of crosstalk's questions
//   doctor  what is wrong, and stats

import { callLegacy, type Ctx, type Result } from "./legacy.ts"
import type { Args, Route, Tool } from "./kit.ts"
import { thread } from "./thread.ts"
import { say } from "./say.ts"
import { work } from "./work.ts"
import { look } from "./look.ts"
import { ship } from "./ship.ts"
import { people } from "./people.ts"
import { answer } from "./answer.ts"
import { doctor } from "./doctor.ts"

const ALL: Tool[] = [thread, say, work, look, ship, people, answer, doctor]
const BY_NAME = new Map(ALL.map((t) => [t.def.name, t]))

export const TOOLS = ALL.map((t) => t.def)

/** The handler a call resolves to, or why it does not. */
export function resolve(tool: string, a: Args): Route {
  const t = BY_NAME.get(tool)
  if (!t) return { error: `unknown tool ${tool}` }
  if (typeof a.action !== "string" || !t.actions.includes(a.action)) return { error: `${tool} needs an action: one of ${t.actions.join(", ")}` }
  return t.route(a)
}

const err = (m: string): Result => ({ content: [{ type: "text", text: `crosstalk error: ${m}` }], isError: true })

export async function callTool(tool: string, a: Args, o: Ctx): Promise<Result> {
  const r = resolve(tool, a ?? {})
  if ("error" in r) return err(r.error)
  return (await callLegacy(r.name, r.args, o)) ?? err(`unknown tool ${tool}`)
}
