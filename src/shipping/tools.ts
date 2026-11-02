// Shipping's MCP tools. Each is one `ship` request to the daemon; the daemon's
// engine (src/shipping/engine.ts) does the work. src/server.ts lists TOOLS and
// hands any call it does not know to callTool.

import { request } from "../client.ts"

const feature = { type: "string", description: "The feature's name, as declared with crosstalk_feature" }
const thread = { type: "string", description: "Which thread; defaults to this session's" }

export const TOOLS = [
  {
    name: "crosstalk_feature",
    description:
      "Declare a shippable feature of this session's thread, or change it. Call it when you start a distinct piece of work that will ship (name it in a few plain words), and set risk: \"risky\" with a why whenever the change could hurt users, data, money or security; crosstalk also makes it risky by itself when the branch touches a path listed in .crosstalk/risk. A risky feature gets an adversarial reviewer and a security pass, needs evidence of behaviour, and ships behind a flag (named for you unless you pass one): keep the new behaviour off unless that flag is on. You can never make a feature everyday again yourself: asking for risk: \"everyday\" puts that question to a person.",
    inputSchema: {
      type: "object",
      properties: {
        name: { type: "string", description: "A few plain words, e.g. \"login with passkeys\"" },
        thread,
        risk: { type: "string", enum: ["everyday", "risky"] },
        why: { type: "string", description: "Why it is risky (or why it should not be), in plain words" },
        flag: { type: "string", description: "The flag the new behaviour sits behind" },
        branch: { type: "string", description: "The branch the work is on; defaults to this session's" },
      },
      required: ["name"],
    },
  },
  {
    name: "crosstalk_ready",
    description:
      "Say a feature's work is ready: committed on its branch, done as far as you can tell. crosstalk then starts fresh reviewer agents on a copy of the branch (they never see this conversation), runs the repo's checks, and merges it into the default branch by itself when it is everyday; a risky one also needs evidence (crosstalk_evidence) and a person's yes. Findings come back to this session as a crosstalk message: fix what you agree with, commit, and call this again with a response saying what you changed and what you disagree with and why. Do not merge or push the branch yourself.",
    inputSchema: {
      type: "object",
      properties: { feature, thread, response: { type: "string", description: "After a review: what you changed, and what you disagree with and why" } },
      required: ["feature"],
    },
  },
  {
    name: "crosstalk_review",
    description:
      "Only for a reviewer crosstalk started: hand in the verdict for the review run named in your instructions. verdict \"approve\" when nothing must change before it ships, \"changes\" otherwise; findings in plain language for the author.",
    inputSchema: {
      type: "object",
      properties: { run: { type: "string" }, verdict: { type: "string", enum: ["approve", "changes"] }, findings: { type: "string" } },
      required: ["run", "verdict", "findings"],
    },
  },
  {
    name: "crosstalk_evidence",
    description:
      "Attach evidence of behaviour to a feature: what the software now does differently, in plain language, with proof. Never a diff or code. A risky feature cannot merge without it, and each step of its flag (internal, a percentage, everyone) is asked on the evidence from the step before; pass stage for evidence gathered at a flag stage. Proof is any of: tests (what they check and that they pass), evals, before and after descriptions, screenshot paths or URLs.",
    inputSchema: {
      type: "object",
      properties: {
        feature,
        thread,
        summary: { type: "string", description: "What changed in behaviour, in a sentence or two" },
        tests: { type: "array", items: { type: "string" } },
        evals: { type: "array", items: { type: "string" } },
        before_after: { type: "array", items: { type: "object", properties: { before: { type: "string" }, after: { type: "string" } }, required: ["before", "after"] } },
        screenshots: { type: "array", items: { type: "string" } },
        stage: { type: "string", description: "The flag stage this was gathered at (off, internal, N%); omit before the merge" },
      },
      required: ["feature", "summary"],
    },
  },
  {
    name: "crosstalk_flag",
    description:
      "Move a feature's flag. stage \"off\" works at once, from any agent, at any time: do it on any regression and say so; no question is needed. Turning a risky feature's flag up (internal, N%, on) is a question crosstalk puts to a person with the evidence from the step before; an everyday feature's flag moves at once.",
    inputSchema: {
      type: "object",
      properties: { flag: { type: "string" }, feature, thread, stage: { type: "string", description: "off, internal, a percentage like 10%, or on" }, why: { type: "string" } },
      required: ["stage"],
    },
  },
  {
    name: "crosstalk_incident",
    description:
      "Report something wrong in production, from an alert, an error tracker or the user. crosstalk reopens the thread that shipped it when the flag, commit or files point clearly at one (its agents have the context), else starts an incident thread to find the cause. Naming the flag of a risky feature turns that flag off at once. When an incident thread finds its cause, call this with link: {incident, cause} to tie it to the thread that shipped it.",
    inputSchema: {
      type: "object",
      properties: {
        source: { type: "string", description: "Where it came from: sentry, pagerduty, a user…" },
        title: { type: "string" },
        details: { type: "string" },
        flag: { type: "string" },
        files: { type: "array", items: { type: "string" } },
        sha: { type: "string", description: "The deployed commit, when known" },
        link: { type: "object", properties: { incident: { type: "string" }, cause: { type: "string" } }, required: ["incident", "cause"] },
      },
    },
  },
  {
    name: "crosstalk_ship_status",
    description:
      "Where this session's features stand: risk, review round, who signed off, evidence, merged or not, flag stage, and the questions waiting on people. Read-only.",
    inputSchema: { type: "object", properties: { thread } },
  },
]

const ACTIONS: Record<string, string> = {
  crosstalk_feature: "feature",
  crosstalk_ready: "ready",
  crosstalk_review: "review",
  crosstalk_evidence: "evidence",
  crosstalk_flag: "flag",
  crosstalk_incident: "incident",
  crosstalk_ship_status: "status",
}

/** The call, or null when the tool is not one of these. */
export async function callTool(name: string, a: any, o: { sessionId: string; cwd: string }) {
  const action = ACTIONS[name]
  if (!action) return null
  // Never `person`: an agent's call cannot answer a person's question.
  const { person: _p, ...args } = a ?? {}
  const r = await request({ ...args, op: "ship", action, sessionId: o.sessionId, cwd: o.cwd }, 60_000)
  const { ok, text, error: _e, ...rest } = r ?? {}
  const body = Object.keys(rest).length ? `${text ?? ""}\n\n${JSON.stringify(rest, null, 2)}` : String(text ?? r?.error ?? "no answer")
  return { content: [{ type: "text" as const, text: body }], ...(ok ? {} : { isError: true }) }
}
