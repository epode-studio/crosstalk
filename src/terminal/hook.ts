// The classic hook's part in the terminal workspace, kept here so src/hook.ts
// only calls it. Everything is cheap: a small file read and write, and a fork
// for the applier only when the tab's state changes.
//
//   status     UserPromptSubmit working, Stop done (or waiting when crosstalk
//              has something pending for the session), Notification waiting,
//              SessionEnd off; OSC 9;4 through `terminalSequence` where the
//              terminal draws it
//   name       a spawned agent's session takes its name, through sessionTitle,
//              never the terminal title
//   cleanup    on a session start, the offer to remove finished worktrees

import * as S from "./status.ts"
import * as ui from "../uistate.ts"
import * as spawn from "../spawn.ts"
import * as cleanup from "../cleanup.ts"

export type Chrome = { terminalSequence?: string; sessionTitle?: string; systemMessage?: string }

/**
 * A spawned agent's title, `auth · auth-2`. Control characters are stripped
 * here: nothing says Claude Code strips them from sessionTitle before it
 * reaches the terminal's title, and a thread name can come from a peer, so an
 * escape sequence in one could otherwise rewrite the person's terminal.
 */
export const titleOf = (rec: { name: string; thread?: string }) =>
  (rec.thread ? `${rec.thread} · ${rec.name}` : rec.name).replace(/[\u0000-\u001f\u007f-\u009f]/g, "")

export function fromHook(o: { event: string; sessionId: string; cwd: string; hook: any; env: NodeJS.ProcessEnv; root: string; isSessionStart: boolean }): Chrome {
  const out: Chrome = {}
  if (o.env.CROSSTALK_NO_TERM) return out
  try {
    const current = S.readTab(o.sessionId)?.want
    const state = S.stateForEvent({
      event: o.event,
      pending: /^(Stop|Notification)$/.test(o.event) ? S.pendingFor(o.sessionId, ui.snapshot) : 0,
      current,
      notificationType: o.hook?.notification_type,
      message: o.hook?.message,
    })
    if (state) {
      S.want({ sessionId: o.sessionId, state, root: o.root })
      if (S.drawsProgress(o.env) && o.event !== "SessionEnd") out.terminalSequence = S.progressSequence(state)
    }
  } catch {}
  if (o.isSessionStart && !/^(clear|compact)$/.test(String(o.hook?.source ?? ""))) {
    try {
      const rec = spawn.claim(o.sessionId, o.cwd)
      // `auth · auth-2`: its thread before its name, as threads title every session.
      if (rec) out.sessionTitle = titleOf(rec)
    } catch {}
    try {
      out.systemMessage = cleanup.surface(o.sessionId, cleanup.offerOnce()).systemMessage
    } catch {}
  }
  return out
}
