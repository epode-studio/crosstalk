// `crosstalk ui …`: what crosstalk's mod (mod/register.tsx) calls.
//
// A mod has no Node and no socket of its own; it reaches the world through
// Claude Code's $.process. So the mod runs these, and these talk to the daemon
// over its control socket, or, for the restore offer and with no daemon at
// all, to the store in src/uistate.ts directly.
//
//   crosstalk ui hello --session <id>      the mod is in this session (before SessionStart runs)
//   crosstalk ui watch --session <id>      one JSON line each time what is waiting changes
//   crosstalk ui list  --session <id>      what is waiting now, once
//   crosstalk ui act   --session <id> --id <item> --action <hand|answer|mute|later|raised> [--value <text>]
//
// Everything printed is for the mod alone. None of it is model context.

import { daemonRunning, request } from "./client.ts"
import * as restore from "./restore.ts"
import * as ui from "./uistate.ts"
import * as gather from "./gather.ts"
import * as cleanup from "./cleanup.ts"

type Out = Record<string, unknown>

function arg(argv: string[], f: string): string | undefined {
  const i = argv.indexOf(f)
  return i === -1 ? undefined : argv[i + 1]
}

const print = (o: Out): void => void process.stdout.write(JSON.stringify(o) + "\n")

/** What is waiting in one session: from the daemon when it runs (it syncs its queue first), else the store. */
async function waiting(session: string, mod: boolean): Promise<{ items: ui.UiItem[]; daemon: boolean; label?: string; threads?: string[]; threadNotes?: { id: string; text: string }[] }> {
  if (daemonRunning()) {
    try {
      const r = await request({ op: "ui", sessionId: session, mod }, 3000)
      if (r?.ok) return { items: r.items, daemon: true, label: r.label, threads: r.threads, ...(r.threadNotes?.length ? { threadNotes: r.threadNotes } : {}) }
    } catch {}
  }
  return { items: ui.openFor(ui.snapshot(), session), daemon: false }
}

/** The restore offer goes once the sessions are back, however that happened ("restore them" included). */
function settleRestore(session: string) {
  const id = ui.restoreId(session)
  const it = ui.snapshot()[id]
  if (!it || ui.FINAL.has(it.state)) return
  if (restore.lostSessions(restore.ctxNow(), session).length) return
  ui.withStore((items, now) => ui.settle(items, id, "answered", now))
}

/**
 * Sessions started before crosstalk: keep watching them (throttled across the
 * machine), offer once to bring them in, and let the offer go once nothing is
 * left to bring.
 */
function tendGather(session: string) {
  if (process.env.CROSSTALK_NO_GATHER) return
  gather.watchThrottled(session)
  const id = ui.gatherId(session)
  const it = ui.snapshot()[id]
  if (!it) {
    ui.gatherSurface(session, gather.offerOnce(session), true)
    return
  }
  if (ui.FINAL.has(it.state)) return
  const left = gather.candidates(restore.readAll(), { self: session, selfPids: gather.ancestors(), alive: restore.recAlive })
  if (!left.some((r) => r.gather?.state !== "queued" && r.gather?.state !== "restarting"))
    ui.withStore((items, now) => ui.settle(items, id, "answered", now))
}

async function watch(session: string, interval: number) {
  let last = ""
  let lastRestoreCheck = 0
  const parent = process.ppid
  for (;;) {
    // The session that started this is gone: so is the reason to run.
    try {
      process.kill(parent, 0)
    } catch {
      return
    }
    if (Date.now() - lastRestoreCheck > 10_000) {
      lastRestoreCheck = Date.now()
      try {
        settleRestore(session)
      } catch {}
      try {
        tendGather(session)
      } catch {}
      try {
        // Finished agent worktrees: offered once, checked at most every ten minutes.
        cleanup.surface(session, cleanup.offerOnce(), true)
      } catch {}
    }
    const w = { ...(await waiting(session, true)), note: gather.peekNote(session) ?? undefined }
    const line = JSON.stringify(w)
    if (line !== last) {
      last = line
      process.stdout.write(line + "\n")
    }
    await new Promise((r) => setTimeout(r, interval))
  }
}

function restoreAct(session: string, id: string, action: string, value: string | undefined, root: string): Out {
  if (action === "raised" || action === "later") return ui.withStore((items, now) => ui.act(items, id, action, now))
  const v = (value ?? "").trim()
  const want = action === "mute" || /^(not now|no|never|later)\b/i.test(v) ? "no" : /window/i.test(v) ? "windows" : "yes"
  const claim = ui.withStore((items, now) => ui.act(items, id, "answer", now, v || want))
  if (!claim.ok) return claim
  // Not now forgets nothing: "restore them" still brings them back.
  if (want === "no") return { ok: true, item: claim.item, text: `Left them closed for now. Say "restore them" any time.` }
  const out = restore.restore({ self: session, tabs: want !== "windows", userAction: true, root })
  return { ok: out.ok, item: claim.item, text: out.text, restored: out.restored.length }
}

function gatherAct(session: string, id: string, action: string, value: string | undefined, root: string): Out {
  if (action === "raised" || action === "later") return ui.withStore((items, now) => ui.act(items, id, action, now))
  const v = (value ?? "").trim()
  const no = action === "mute" || /^(not now|no|never|later)\b/i.test(v)
  const claim = ui.withStore((items, now) => ui.act(items, id, "answer", now, v || (no ? "Not now" : "Bring them in")))
  if (!claim.ok) return claim
  if (no) return { ok: true, item: claim.item, text: `Left them as they are. Say "bring my other sessions into crosstalk" any time.` }
  const out = gather.start({ self: session, root })
  return { ok: out.ok, item: claim.item, text: out.text, count: out.sessions.length }
}

export async function uiCmd(argv: string[], root: string): Promise<void> {
  const sub = argv[1]
  const session = arg(argv, "--session") ?? process.env.CLAUDE_CODE_SESSION_ID ?? ""
  if (!session) return print({ ok: false, error: "--session is needed" })
  switch (sub) {
    case "hello":
      ui.markModActive(session)
      ui.pruneMarkers()
      return print({ ok: true })
    case "list":
      return print({ ok: true, ...(await waiting(session, false)) })
    case "watch":
      return watch(session, Math.max(250, Number(arg(argv, "--interval") ?? 1000)))
    case "act": {
      const id = arg(argv, "--id") ?? ""
      const action = arg(argv, "--action") ?? ""
      const value = arg(argv, "--value")
      if (id.startsWith("restore:")) return print(restoreAct(session, id, action, value, root))
      if (id.startsWith("gather:")) return print(gatherAct(session, id, action, value, root))
      if (id.startsWith("cleanup:")) return print(cleanup.act(session, id, action, value))
      if (id.startsWith("gather-note:")) {
        const n = gather.takeNote(session, id)
        return print(n ? { ok: true, text: n.text } : { ok: false, error: "already shown" })
      }
      if (!daemonRunning()) return print({ ok: false, error: "the crosstalk daemon is not running" })
      try {
        return print(await request({ op: "ui_act", sessionId: session, id, action, value }, 30_000))
      } catch (e) {
        return print({ ok: false, error: (e as Error).message })
      }
    }
    default:
      return print({ ok: false, error: `unknown: crosstalk ui ${sub ?? ""}` })
  }
}
