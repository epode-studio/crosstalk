// crosstalk_env, the picker's answer, and the hook's SessionStart, for the
// local files a new worktree gets (index.ts). Results name files, never what
// is in them.

import path from "node:path"
import * as ui from "../uistate.ts"
import { readSpawned } from "../spawn.ts"
import * as E from "./index.ts"
import { settle, surface } from "./offer.ts"

export const TOOLS = [
  {
    name: "crosstalk_env",
    description:
      'The gitignored local files (.env, .env.*, .dev.vars, config/*.local.*, and patterns in the repo\'s .crosstalk/env) that crosstalk copies from the main checkout into new worktrees, so their dev servers start. Asked once per repository; pass confirm true when the user says "copy them" / yes, false for "not in this repo" / no. Without confirm it says what would be copied and what the user decided. Only file names are ever returned: their contents stay on this machine and must never be read into a thread, a message or a commit.',
    inputSchema: {
      type: "object",
      properties: {
        confirm: { type: "boolean", description: "The user's answer: true copies them into new worktrees of this repo (and the current one), false never" },
      },
    },
  },
]

/** The worktrees a yes copies into: this one, and the ones crosstalk made of the repo. */
function worktreesOf(main: string, here?: string): string[] {
  const key = E.keyOf(main)
  const out = here ? [here] : []
  for (const r of readSpawned()) if (!r.removedAt && E.keyOf(r.repo) === key) out.push(r.worktree)
  return out
}

export function envTool(a: { confirm?: unknown }, o: { cwd: string }): { ok: boolean; text: string } {
  if (E.off()) return { ok: false, text: "◢ crosstalk: copying local files into worktrees is turned off here (CROSSTALK_NO_ENV_COPY)." }
  let w = o.cwd ? E.where(o.cwd) : null
  let main = w?.main
  // Asked from somewhere else (the main session, a folder outside git): the open question.
  if (!main) main = E.openAsks()[0]
  if (!main) return { ok: false, text: "◢ crosstalk: this is not a git repository, so there is no main checkout to copy local files from." }
  if (typeof a.confirm !== "boolean") return { ok: true, text: E.status(main) }
  const r = E.answer({ main, yes: a.confirm, worktrees: worktreesOf(main, w?.linked ? w.top : undefined) })
  settle(E.envId(main))
  return { ok: r.ok, text: r.text }
}

/** The mod's picker answered (`crosstalk ui act --id env:…`). Runs in the person's own process. */
export function uiAct(sessionId: string, id: string, action: string, value: string | undefined): Record<string, unknown> {
  if (action === "raised" || action === "later") return ui.withStore((items, now) => ui.act(items, id, action, now))
  const main = E.mainForId(id)
  if (!main) return { ok: false, error: "that question is gone" }
  const claim = ui.withStore((items, now) => ui.act(items, id, "answer", now, value))
  if (!claim.ok) return claim
  const yes = action !== "mute" && (value ?? "").trim() === E.YES
  const asked = E.load().repos[E.keyOf(main)]?.cwd
  const w = asked ? E.where(asked) : null
  const r = E.answer({ main, yes, worktrees: worktreesOf(main, w?.linked ? w.top : undefined) })
  return { ok: r.ok, text: r.text, item: claim.item }
}

/**
 * A session starting in a worktree of a repo: what it is missing, copied in
 * on a standing yes; the question, the first time. A line for the person
 * either way, or nothing.
 */
export function atSessionStart(o: { cwd: string; sessionId: string }): { systemMessage?: string } {
  if (E.off() || !o.cwd) return {}
  const w = E.where(o.cwd)
  if (!w?.linked) return {}
  const r = E.prepare({ main: w.main, worktree: w.top, sessionId: o.sessionId, cwd: o.cwd })
  if (r.copied.length) return { systemMessage: `◢ crosstalk: copied ${E.names(r.copied)} into this worktree from ${path.basename(w.main)}'s main checkout (gitignored; they stay on this machine).` }
  if (r.offer) return surface(r.offer, o.sessionId)
  return {}
}

const text = (out: { ok: boolean; text: string }) => ({ content: [{ type: "text" as const, text: out.text }], ...(out.ok ? {} : { isError: true }) })

export async function callTool(name: string, a: any, o: { sessionId: string; cwd: string }) {
  if (name !== "crosstalk_env") return null
  return text(envTool(a ?? {}, o))
}
