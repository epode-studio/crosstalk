// The classic hook's part in sessions and attention, kept here so src/hook.ts
// only calls it. Claude Code only.
//
//   UserPromptSubmit    the person typed here, now (activity.ts)
//   Stop                the daemon recaps the session if its placement is
//                       unsure, and reads how much context is spent
//   PreCompact          the daemon may start a fresh session from the thread
//                       instead; then the compaction is blocked
//   PermissionRequest   in a background agent only: held until the person
//                       answers it as a question, then the decision returned
//   SessionStart,       without the mod, receipts and questions as one
//   UserPromptSubmit    systemMessage line each, shown to the person alone

import { isCrosstalkPrompt } from "./openitems.ts"
import { request } from "../client.ts"
import * as A from "./activity.ts"
import * as Pm from "./permission.ts"

export type Out = { exit?: Record<string, unknown>; systemMessage?: string }

export async function fromHook(o: { event: string; sessionId: string; cwd: string; hook: any; env: NodeJS.ProcessEnv; mod: boolean }): Promise<Out> {
  if (o.env.CROSSTALK_NO_ATTENTION === "1") return {}
  const { event, sessionId, hook } = o
  const out: Out = {}
  try {
    const agent = Pm.backgroundAgent(o.env)
    // A background agent: nobody is looking at it, so it is never asked anything itself.
    if (agent && /^(SessionStart|Stop)$/.test(event)) await request({ op: "attn_bg", sessionId, agent }, 3000).catch(() => null)
    // Only the person types; a background agent's first prompt is crosstalk's.
    if (event === "UserPromptSubmit" && !agent && !isCrosstalkPrompt(String(hook.prompt ?? ""))) A.noteTyped(sessionId)
    if (event === "Stop" && !hook.stop_hook_active) {
      await request({ op: "attn_stop", sessionId, cwd: o.cwd, transcript: hook.transcript_path }, 5000).catch(() => null)
    }
    if (event === "PreCompact") {
      const r = await request({ op: "attn_precompact", sessionId, cwd: o.cwd, trigger: hook.trigger ?? "auto" }, 10_000).catch(() => null)
      if (r?.block) out.exit = { decision: "block", reason: String(r.block) }
    }
    if (event === "PermissionRequest") {
      if (!agent) return out
      const r = await request(
        { op: "attn_permission", sessionId, cwd: o.cwd, agent, tool: hook.tool_name, input: hook.tool_input, suggestions: hook.permission_suggestions },
        Pm.waitMs(o.env) + 30_000,
      ).catch(() => null)
      // No answer: nothing printed, so Claude Code's own dialog stays up for "show me".
      out.exit = r?.decision ? Pm.hookOutput(r.decision) : {}
    }
    if (!o.mod && /^(SessionStart|UserPromptSubmit)$/.test(event)) {
      const r = await request({ op: "attn_notes", sessionId }, 3000).catch(() => null)
      if (r?.systemMessage) out.systemMessage = String(r.systemMessage)
    }
  } catch {}
  return out
}
