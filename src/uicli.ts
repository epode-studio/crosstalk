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

import { daemonRunning, ensureDaemon, request } from "./client.ts"
import * as openItems from "./attention/openitems.ts"
import * as firstuse from "./repotrust/firstuse.ts"
import * as restore from "./restore.ts"
import * as ui from "./uistate.ts"
import * as gather from "./gather.ts"
import * as cleanup from "./cleanup.ts"
import * as Urls from "./urls/index.ts"
import { running } from "./threads/running.ts"
import { runningSummary } from "./ui-extra/pure.ts"
import * as extra from "./ui-extra/uicli.ts"
import * as sessionCtl from "./sessions/control.ts"
import * as envTools from "./env/tools.ts"

type Out = Record<string, unknown>

/** Run from an agent's tool call (as src/shipping/cli.ts reads it). */
const insideAgent = () => !!(process.env.CLAUDECODE || process.env.CODEX_SANDBOX || process.env.CROSSTALK_AS_AGENT)

function arg(argv: string[], f: string): string | undefined {
  const i = argv.indexOf(f)
  return i === -1 ? undefined : argv[i + 1]
}

const print = (o: Out): void => void process.stdout.write(JSON.stringify(o) + "\n")

/** What is waiting in one session: from the daemon when it runs (it syncs its queue first), else the store. */
export async function waiting(session: string, mod: boolean): Promise<{ items: ui.UiItem[]; daemon: boolean; label?: string; threads?: string[]; threadNotes?: { id: string; text: string }[]; main?: unknown; push?: unknown }> {
  if (daemonRunning()) {
    try {
      const r = await request({ op: "ui", sessionId: session, mod }, 3000)
      // push is taken from the daemon when it is read: dropping it here loses it.
      if (r?.ok)
        return {
          items: r.items,
          daemon: true,
          label: r.label,
          threads: r.threads,
          ...(r.threadNotes?.length ? { threadNotes: r.threadNotes } : {}),
          ...(r.main ? { main: r.main } : {}),
          ...(r.push ? { push: r.push } : {}),
        }
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
  let where: string | undefined
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
      // The mod is up for as long as its watch runs: keep saying so, or after
      // ten minutes every yes would have to be typed instead of picked.
      try {
        ui.markModActive(session)
      } catch {}
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
      // What runs, for the status line: the thread's Running (src/threads/running.ts),
      // said as its one server's name (`auth.localhost:1355`) or how many run.
      try {
        where = runningSummary(running(Urls.threadOfSession(session), { sessionId: session })) || undefined
      } catch {}
    }
    const w = { ...(await waiting(session, true)), note: gather.peekNote(session) ?? undefined, ...(where ? { where } : {}) }
    const line = JSON.stringify(w)
    if (line !== last) {
      last = line
      process.stdout.write(line + "\n")
    }
    await new Promise((r) => setTimeout(r, interval))
  }
}

/**
 * The restore offer's answer: its options word for word ("Restore", "Open as
 * windows"); anything else, "nope", "not yet", "don't", is not now.
 */
export function restoreWant(action: string, value: string | undefined): "yes" | "windows" | "no" {
  const v = (value ?? "").trim()
  if (action !== "answer") return "no"
  return v === "Restore" ? "yes" : v === "Open as windows" ? "windows" : "no"
}

/** The gather offer's answer: only its own yes, word for word, brings them in. */
export const gatherYes = (action: string, value: string | undefined) => action === "answer" && (value ?? "").trim() === ui.GATHER_OPTIONS[0]

function restoreAct(session: string, id: string, action: string, value: string | undefined, root: string): Out {
  if (action === "raised" || action === "later") return ui.withStore((items, now) => ui.act(items, id, action, now))
  const v = (value ?? "").trim()
  const want = restoreWant(action, value)
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
  const no = !gatherYes(action, value)
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
    case "bg-later": {
      // A move to the background the person said yes to, waiting for what the
      // session started to stop (src/sessions/control.ts waitThenBackground).
      if (insideAgent()) return print({ ok: false, error: "this is crosstalk's own waiter" })
      return print(await sessionCtl.backgroundLater(session, arg(argv, "--id") ?? ""))
    }
    case "act": {
      const id = arg(argv, "--id") ?? ""
      const action = arg(argv, "--action") ?? ""
      const value = arg(argv, "--value")
      if (id.startsWith("restore:")) return print(restoreAct(session, id, action, value, root))
      if (id.startsWith("gather:")) return print(gatherAct(session, id, action, value, root))
      if (id.startsWith("cleanup:")) return print(cleanup.act(session, id, action, value))
      // Close, background, rename, move, and actions from your other machines (src/sessions/control.ts):
      // run from here, the mod's own process, and only on the person's pick, never an agent's shell.
      if (id.startsWith("sess:")) {
        if (action === "answer" && insideAgent()) return print({ ok: false, error: "this is for a person: answer it in crosstalk's picker" })
        return print(await sessionCtl.act(session, id, action, value))
      }
      // First use in a repo works with no identity and no daemon: a yes makes both.
      if (id.startsWith("connect:")) {
        if (action === "raised" || action === "later") return print(ui.withStore((items, now) => ui.act(items, id, action, now)))
        const yes = action !== "mute" && (value ?? "").trim() === firstuse.CONNECT
        const out = await firstuse.connect({ slug: id.slice("connect:".length), yes, ensureDaemon: () => ensureDaemon(root), request })
        return print({ ok: out.ok, text: out.text, item: ui.snapshot()[id] })
      }
      // "Tackle all open" (src/attention/openitems.ts): the person's pick starts the turn, from the mod.
      if (id.startsWith("open:")) {
        if (action === "raised" || action === "later") return print(ui.withStore((items, now) => ui.act(items, id, action, now)))
        if (action === "answer" && insideAgent()) return print({ ok: false, error: "this is for a person: answer it in crosstalk's picker" })
        const v = (value ?? "").trim()
        const claim = ui.withStore((items, now) => ui.act(items, id, "answer", now, v || openItems.NOT_NOW))
        if (!claim.ok) return print({ ok: false, error: claim.error })
        const list = claim.item?.names ?? []
        if (v === openItems.ALWAYS) openItems.setAlways(true)
        if ((v === openItems.TACKLE || v === openItems.ALWAYS) && list.length)
          return print({ ok: true, item: claim.item, prompt: openItems.tacklePrompt(list), text: v === openItems.ALWAYS ? "tackling them, and from now on by itself" : "tackling them" })
        return print({ ok: true, item: claim.item, text: "left them as tasks" })
      }
      // Copying a repo's gitignored local files into new worktrees (src/env/): no daemon needed.
      if (id.startsWith("env:")) return print(envTools.uiAct(session, id, action, value))
      const done = extra.act(session, id, action, value)
      if (done) return print(done)
      if (id.startsWith("gather-note:")) {
        const n = gather.takeNote(session, id)
        return print(n ? { ok: true, text: n.text } : { ok: false, error: "already shown" })
      }
      // A shipping picker's answer counts as a person's (the daemon answers it
      // with person: true), so like `crosstalk ship answer` it is refused from
      // inside an agent: an agent's shell cannot press the picker for them.
      if (id.startsWith("ship:") && insideAgent())
        return print({ ok: false, error: "this question is for a person: answer it in crosstalk's picker, or run `crosstalk ship answer` yourself in a terminal" })
      if (!daemonRunning()) return print({ ok: false, error: "the crosstalk daemon is not running" })
      try {
        return print(await request({ op: "ui_act", sessionId: session, id, action, value }, 30_000))
      } catch (e) {
        return print({ ok: false, error: (e as Error).message })
      }
    }
    default:
      // The pane, @ shortcuts and the digest: src/ui-extra/uicli.ts.
      if (await extra.uiExtraCmd(sub, argv, session, root, print)) return
      return print({ ok: false, error: `unknown: crosstalk ui ${sub ?? ""}` })
  }
}
