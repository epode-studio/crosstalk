// Background agents' permission prompts, as questions.
//
// A session crosstalk starts in the background (tmux -L crosstalk, or
// `claude --bg`) draws its permission dialog where nobody is looking. So each
// one is started with CROSSTALK_BG_AGENT=<name> in its environment, and
// crosstalk's own PermissionRequest hook (hooks/hooks.json) sees it there:
//
//   hook      PermissionRequest {tool_name, tool_input} → the daemon's
//             attn_permission op, and waits (the hook's timeout in hooks.json
//             is an hour)
//   daemon    a question in the person's current session (the main one, else
//             the one in front, else the one typed in last), with a desktop
//             notification and, when they are away, the phone
//   answer    Allow / Allow for this session / Deny goes back to the waiting
//             hook, which returns `hookSpecificOutput.decision` {behavior};
//             "Allow for this session" also returns Claude Code's own
//             permission_suggestions as updatedPermissions, so it is not
//             asked again
//
// Sessions the person runs themselves are never relayed: their dialog is in
// front of them. Nothing answered in time leaves the dialog where it was, so
// "show me <name>" can still answer it.
//
// The channels permission relay (`permission_request {request_id, tool_name,
// description, input_preview}` answered by `{request_id, behavior}`) does the
// same over a development channel, which needs a flag on the command line;
// the hook needs none, and waits fine on 2.1.316 (docs/attention.md).

export const ALLOW = "Allow"
export const ALLOW_SESSION = "Allow for this session"
export const DENY = "Deny"
export const OPTIONS = [ALLOW, ALLOW_SESSION, DENY]

/** How long the daemon holds a request open, a little under the hook's own timeout. */
export const waitMs = (env: NodeJS.ProcessEnv = process.env) => {
  const n = Number(env.CROSSTALK_PERMISSION_WAIT_MS)
  return n > 0 ? n : 55 * 60_000
}

const oneLine = (s: string) => s.replace(/\s+/g, " ").trim()
const cut = (s: string, n: number) => (s.length > n ? s.slice(0, n - 1) + "…" : s)

/** What the tool wants to do, short: the command, the file, the URL, else its input. */
export function preview(tool: string, input: unknown): string {
  const i = (input && typeof input === "object" ? input : {}) as Record<string, unknown>
  const s = (k: string) => (typeof i[k] === "string" ? (i[k] as string) : "")
  const pick = s("command") || s("file_path") || s("notebook_path") || s("url") || s("pattern") || s("path") || s("query") || s("prompt")
  if (pick) return cut(oneLine(pick), 160)
  try {
    return cut(oneLine(JSON.stringify(input) ?? ""), 160)
  } catch {
    return ""
  }
}

export function question(agent: string, tool: string, input: unknown): string {
  const p = preview(tool, input)
  return `${agent} (in the background) wants to use ${tool}${p ? `: ${p}` : ""}. Allow it?`
}

export type Decision = { behavior: "allow"; updatedPermissions?: unknown[] } | { behavior: "deny"; message?: string }

/** The person's pick, as Claude Code's PermissionRequest decision. */
export function decisionFor(answer: string, suggestions?: unknown): Decision {
  const a = answer.trim().toLowerCase()
  if (a === ALLOW_SESSION.toLowerCase() || /for (this|the) session|always/.test(a))
    return { behavior: "allow", ...(Array.isArray(suggestions) && suggestions.length ? { updatedPermissions: suggestions } : {}) }
  if (a === ALLOW.toLowerCase() || /^(allow|yes|y|ok|approve)\b/.test(a)) return { behavior: "allow" }
  return { behavior: "deny", message: "The user denied this through crosstalk." }
}

/** What the hook prints. */
export const hookOutput = (d: Decision) => ({ hookSpecificOutput: { hookEventName: "PermissionRequest", decision: d } })

/** Whether this hook runs in a session crosstalk started in the background. */
export const backgroundAgent = (env: NodeJS.ProcessEnv) => (env.CROSSTALK_BG_AGENT ?? "").trim()
