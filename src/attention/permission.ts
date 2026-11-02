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
//             permission_suggestions as updatedPermissions, each one kept to
//             destination "session", so it is not asked again this session
//             and no settings file is written. Only the exact options count:
//             any other answer denies
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

/** Longest preview shown whole; a longer one shows its head and tail and says it was cut. */
export const PREVIEW_MAX = 2000
const HEAD = 1400
const TAIL = 400

/**
 * Control characters shown, not obeyed: a newline is `\n`, so a second
 * line is visible as one, and nothing can redraw or hide the rest of the
 * question. Whitespace is never collapsed: what is shown is what runs.
 */
const visible = (s: string) =>
  s.replace(/[\u0000-\u001f\u007f-\u009f\u2028\u2029\u200b-\u200f\u202a-\u202e\u2066-\u2069]/g, (c) =>
    c === "\n" ? "\\n" : c === "\t" ? "\\t" : c === "\r" ? "\\r" : `\\u${c.charCodeAt(0).toString(16).padStart(4, "0")}`,
  )

const fit = (s: string): { text: string; truncated: boolean } => {
  const v = visible(s)
  if (v.length <= PREVIEW_MAX) return { text: v, truncated: false }
  return { text: `${v.slice(0, HEAD)} … [${v.length - HEAD - TAIL} characters not shown] … ${v.slice(-TAIL)} (truncated: ${v.length} characters in all)`, truncated: true }
}

/**
 * What the tool wants to do: a command whole; anything else, the path it
 * acts on followed by every other input (a Write's content, an Edit's
 * strings), so nothing it will do is left out of the question.
 */
export function previewOf(tool: string, input: unknown): { text: string; truncated: boolean } {
  const i = (input && typeof input === "object" ? input : {}) as Record<string, unknown>
  if (typeof i.command === "string") return fit(i.command)
  const target = ["file_path", "notebook_path", "url", "path"].find((k) => typeof i[k] === "string")
  const rest = Object.fromEntries(Object.entries(i).filter(([k]) => k !== target))
  let json = ""
  try {
    json = target ? (Object.keys(rest).length ? JSON.stringify(rest) : "") : (JSON.stringify(input) ?? "")
  } catch {}
  return fit([target ? (i[target] as string) : "", json].filter(Boolean).join(" "))
}

export const preview = (tool: string, input: unknown): string => previewOf(tool, input).text

/** A preview cut short is only ever allowed once: "for this session" would cover what was not shown. */
export const optionsFor = (tool: string, input: unknown): string[] => (previewOf(tool, input).truncated ? [ALLOW, DENY] : OPTIONS)

export function question(agent: string, tool: string, input: unknown): string {
  const p = preview(tool, input)
  return `${agent} (in the background) wants to use ${tool}${p ? `: ${p}` : ""}. Allow it?`
}

export type Decision = { behavior: "allow"; updatedPermissions?: unknown[] } | { behavior: "deny"; message?: string }

/**
 * Claude Code's permission_suggestions, kept to this session: a suggestion
 * may name localSettings, projectSettings or userSettings, which would write
 * a rule that outlives the session the person said yes for. Each one is
 * rewritten to destination "session"; anything that is not a plain object is
 * dropped.
 */
export function sessionOnly(suggestions: unknown): unknown[] {
  if (!Array.isArray(suggestions)) return []
  return suggestions.filter((x) => x && typeof x === "object" && !Array.isArray(x)).map((x) => ({ ...(x as Record<string, unknown>), destination: "session" }))
}

/**
 * The person's pick, as Claude Code's PermissionRequest decision. Only the
 * exact options allow; anything else ("Deny for this session", "no, not
 * always", "yes please don't") is a deny.
 */
export function decisionFor(answer: string, suggestions?: unknown): Decision {
  const a = answer.trim()
  if (a === ALLOW_SESSION) {
    const s = sessionOnly(suggestions)
    return { behavior: "allow", ...(s.length ? { updatedPermissions: s } : {}) }
  }
  if (a === ALLOW) return { behavior: "allow" }
  return { behavior: "deny", message: "The user denied this through crosstalk." }
}

/** What the hook prints. */
export const hookOutput = (d: Decision) => ({
  hookSpecificOutput: {
    hookEventName: "PermissionRequest",
    // Whatever came back, nothing it allows outlives this session.
    decision: d.behavior === "allow" && d.updatedPermissions ? { ...d, updatedPermissions: sessionOnly(d.updatedPermissions) } : d,
  },
})

/** Whether this hook runs in a session crosstalk started in the background. */
export const backgroundAgent = (env: NodeJS.ProcessEnv) => (env.CROSSTALK_BG_AGENT ?? "").trim()
