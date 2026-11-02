// The `crosstalk ui …` subcommands crosstalk's mod calls for what this
// directory adds (src/uicli.ts hands them here):
//
//   crosstalk ui pane   --session <id> [--thread <name>] [--watch]   the thread pane, as JSON
//   crosstalk ui at     --session <id> --text "@auth keep v1"        an @ shortcut, done
//   crosstalk ui digest --session <id> [--band]                      what happened, or the band's line
//
// and the answers to its invite and doctor pickers. Everything printed is for
// the mod alone; none of it is model context.

import { daemonRunning, ensureDaemon, request } from "../client.ts"
import * as restore from "../restore.ts"
import * as ui from "../uistate.ts"
import * as M from "../threads/model.ts"
import { matchOption, parseAt } from "./pure.ts"
import { pane, watchPane } from "./pane.ts"
import { findThread, readThreads } from "./threadfile.ts"
import { bandForSession, digest } from "./digest.ts"
import * as doctor from "./doctor.ts"
import { inviteAct } from "./people.ts"

type Out = Record<string, unknown>

function arg(argv: string[], f: string): string | undefined {
  const i = argv.indexOf(f)
  return i === -1 ? undefined : argv[i + 1]
}

/** The answer to one of this directory's pickers, or null when the id is not one of them. */
export function act(session: string, id: string, action: string, value: string | undefined): Out | null {
  if (id.startsWith("invite:")) return inviteAct(id, action, value)
  if (id.startsWith("doctor:")) return doctor.act(id, action, value)
  return null
}

const OPTION_KINDS = new Set(["ship", "rule", "conflict", "thread", "route", "team"])

/** What is open for a session, as its mod sees it (a main session's cross-cutting items included). */
async function openItems(session: string): Promise<ui.UiItem[]> {
  if (daemonRunning())
    try {
      const r = await request({ op: "ui", sessionId: session }, 3000)
      if (r?.ok) return r.items as ui.UiItem[]
    } catch {}
  return ui.openFor(ui.snapshot(), session)
}

export type AtOut = { handled: boolean; ok?: boolean; toast?: string; drop?: string }

/** `@main`, `@restore`, `@<thread> <text>`: done here, before any of it is a prompt. */
export async function at(session: string, text: string, root: string): Promise<AtOut> {
  const a = parseAt(text)
  if (!a) return { handled: false }
  if (a.kind === "main") {
    if (!(await ensureDaemon(root))) return { handled: true, ok: false, toast: "the crosstalk daemon would not start", drop: "crosstalk: main" }
    const r = await request({ op: "main", sessionId: session, on: a.on })
    return { handled: true, ok: !!r.ok, toast: oneLine(r.text ?? r.error ?? (a.on ? "this is your main session" : "this is a working session again")), drop: "crosstalk: main session" }
  }
  if (a.kind === "restore") {
    const out = a.want === "no" ? restore.forget(session) : restore.restore({ self: session, tabs: a.want !== "windows", userAction: true, root })
    ui.withStore((items, now) => ui.settle(items, ui.restoreId(session), "answered", now))
    return { handled: true, ok: out.ok, toast: oneLine(out.text.replace(/^◢ crosstalk: /, "")), drop: "crosstalk: restore" }
  }
  const name = a.name
  const drop = `crosstalk: answer sent to ${name}`
  const open = await openItems(session)
  const about = open.filter((i) => (i.thread ?? "").toLowerCase() === name)
  const from = open.filter((i) => (i.from ?? "").toLowerCase() === name && (i.kind === "message" || i.kind === "ask"))
  const card = [...about, ...from].find((i) => i.kind === "ask") ?? [...about, ...from].find((i) => i.kind === "message")
  const choice = about.find((i) => OPTION_KINDS.has(i.kind) && i.options?.length)
  if (card) {
    const r = await request({ op: "ui_act", sessionId: session, id: card.id, action: "answer", value: a.text }, 60_000).catch((e) => ({ ok: false, error: (e as Error).message }))
    return { handled: true, ok: !!r.ok, toast: r.ok ? `${card.kind === "ask" ? "answered" : "replied to"} ${card.from}${card.thread ? ` · ${card.thread}` : ""}` : `not sent: ${r.error ?? "no answer"}`, drop }
  }
  if (choice) {
    const pick = matchOption(a.text, choice.options!)
    if (!pick) return { handled: true, ok: false, toast: `${name}: answer with one of ${choice.options!.join(" / ")}`, drop }
    const r = await request({ op: "ui_act", sessionId: session, id: choice.id, action: "answer", value: pick }, 60_000).catch((e) => ({ ok: false, error: (e as Error).message }))
    return { handled: true, ok: !!r.ok, toast: oneLine(r.ok ? `${name}: ${pick}${r.text ? ` · ${String(r.text).replace(/^◢ crosstalk: /, "")}` : ""}` : `not answered: ${r.error ?? r.text ?? "no answer"}`), drop }
  }
  // A question in the thread itself, the blocking ones first.
  const t = findThread(readThreads(), name, session)
  const q = t
    ? M.live(t, "questions")
        .filter((x) => !x.answer)
        .sort((x, y) => Number(!!y.blocking) - Number(!!x.blocking) || x.at - y.at)[0]
    : undefined
  if (t && q) {
    if (!(await ensureDaemon(root))) return { handled: true, ok: false, toast: "the crosstalk daemon would not start", drop }
    const r = await request({ op: "thread", sessionId: session, thread: t.id, answer: { id: q.id, text: a.text } })
    return { handled: true, ok: !!r.ok, toast: r.ok ? `answered "${cut(q.text, 60)}" in ${t.meta.value.name}` : `not answered: ${r.error ?? "no answer"}`, drop }
  }
  return { handled: false }
}

const oneLine = (s: string) => s.replace(/\s+/g, " ").trim()
const cut = (s: string, n: number) => (s.length > n ? s.slice(0, n - 1) + "…" : s)

export async function uiExtraCmd(sub: string | undefined, argv: string[], session: string, root: string, print: (o: Out) => void): Promise<boolean> {
  switch (sub) {
    case "pane": {
      const thread = arg(argv, "--thread") || undefined
      if (argv.includes("--watch")) await watchPane({ sessionId: session, thread, interval: Number(arg(argv, "--interval") ?? 1000) })
      else print(pane({ sessionId: session, thread }))
      return true
    }
    case "at":
      print(await at(session, arg(argv, "--text") ?? "", root))
      return true
    case "digest": {
      if (argv.includes("--band")) print({ ok: true, line: bandForSession(session) ?? undefined })
      else print({ ok: true, text: digest().text })
      return true
    }
    default:
      return false
  }
}
