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
//   services   on a session start, which crosstalk services still run in this
//              worktree (the person's systemMessage, and a line for the agent
//              as data) and the worktree's own ports; their ports after the
//              session's title, `auth · :4100` (docs/services.md), or the
//              worktree's name through crosstalk's proxy while it is up,
//              `auth · auth.localhost:1355` (docs/urls.md)

import * as S from "./status.ts"
import * as ui from "../uistate.ts"
import * as spawn from "../spawn.ts"
import * as cleanup from "../cleanup.ts"
import * as Svc from "../services/service.ts"
import * as Pt from "../services/ports.ts"
import * as Urls from "../urls/index.ts"
import { readState } from "../urls/proxy.ts"

export type Chrome = {
  terminalSequence?: string
  sessionTitle?: string
  systemMessage?: string
  /** For the agent, at SessionStart: the worktree's ports and its running services, as data. */
  context?: string
  /** The ports of this worktree's running services, `:4100`, or its proxy name, `auth.localhost:1355`, for after the title. */
  badge?: string
}

/** What a badge may hold: ports, or a host name and port. Nothing that could be an escape sequence. */
export const badgeText = (b: string) => b.replace(/[^a-z0-9.:\- …]/gi, "").slice(0, 80)

/** `auth · :4100` or `auth · auth.localhost:1355`: a title with where its services are after it. */
export const withBadge = (title: string | undefined, badge: string | undefined) => (title && badge ? `${title} · ${badgeText(badge)}` : title)

/**
 * A coloured dot per thread, at the front of its sessions' titles, so tabs on
 * the same work go together at a glance in any terminal: Terminal.app can only
 * colour a whole background, which crosstalk leaves alone. The same thread
 * always gets the same colour. CROSSTALK_NO_TITLE_DOT=1 leaves titles plain.
 */
export { DOTS, dotFor } from "../ui-extra/pure.ts"
import { DOTS, dotFor } from "../ui-extra/pure.ts"
export const withDot = (title: string | undefined, thread: string | undefined, env: NodeJS.ProcessEnv = process.env) =>
  title && thread && !env.CROSSTALK_NO_TITLE_DOT && !DOTS.some((d) => title.startsWith(d)) ? `${dotFor(thread)} ${title}` : title

/** The worktree's proxy name while the proxy is up and a service runs here, else the ports. */
function named(cwd: string, ports: string | undefined): string | undefined {
  if (!ports) return ports
  try {
    const s = readState()
    return (s && Urls.badge(Pt.rootOf(cwd), s)) || ports
  } catch {
    return ports
  }
}

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
    const tab = S.readTab(o.sessionId)
    const current = tab?.base ?? tab?.want
    const state = S.stateForEvent({
      event: o.event,
      pending: /^(Stop|Notification)$/.test(o.event) ? S.pendingFor(o.sessionId, ui.snapshot) : 0,
      current,
      notificationType: o.hook?.notification_type,
      message: o.hook?.message,
    })
    if (state) {
      S.want({ sessionId: o.sessionId, state, root: o.root })
      // A broken service of this session's (src/urls/health/) shows over done and waiting.
      if (S.drawsProgress(o.env) && o.event !== "SessionEnd") out.terminalSequence = S.progressSequence(S.shownState(o.sessionId, state))
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
  if (o.isSessionStart && !o.env.CROSSTALK_NO_SERVICES) {
    try {
      const b = Svc.brief(o.cwd)
      // After a compaction or /clear the agent has lost the line; the person was told already.
      if (b.systemMessage && !/^(clear|compact)$/.test(String(o.hook?.source ?? ""))) out.systemMessage = [out.systemMessage, b.systemMessage].filter(Boolean).join("\n")
      if (b.context) out.context = b.context
      if (b.badge) out.badge = named(o.cwd, b.badge)
    } catch {}
  } else if (/^UserPromptSubmit$/.test(o.event) && !o.env.CROSSTALK_NO_SERVICES) {
    try {
      // Cheap: a readdir, and one git and one tmux call only when crosstalk runs services at all.
      if (Svc.readAll().some((s) => !s.stoppedAt)) {
        const b = Svc.badge(Svc.running(Pt.rootOf(o.cwd)))
        if (b) out.badge = named(o.cwd, b)
      }
    } catch {}
  }
  return out
}
