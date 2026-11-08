// The session manager's MCP tools: close, find, resume, rename, move, pop out
// and send to the background, here or on another of the user's own machines.
// src/tools/ resolves an action of one of the eight tools to one of these names and calls callTool.
// Each is plain language for what the person asks; each that ends or changes
// a session is confirmed by them first (control.ts gate).

import * as C from "./control.ts"
import * as I from "./index.ts"
import * as W from "../attention/worker.ts"
import * as T from "./transcripts.ts"

const text = (out: { ok: boolean; text: string }) => ({ content: [{ type: "text" as const, text: out.text }], ...(out.ok ? {} : { isError: true }) })

/** The machine-targeted form of an action: gated here, then carried to that machine. */
async function remote(o: { sessionId: string; cwd: string }, machine: string, req: C.RemoteAct, d: C.Deps) {
  return text(await C.gate({ by: o.sessionId, cwd: o.cwd, action: { kind: "remote", machine, req } }, d))
}

/** The call, or null when the tool is not one of these. */
export async function callTool(name: string, a: any, o: { sessionId: string; cwd: string }, d: C.Deps = C.liveDeps()) {
  const machine = typeof a?.machine === "string" && a.machine.trim() ? a.machine.trim() : ""
  const target = async (ref: string | undefined) => {
    const lives = await C.liveSessions(d)
    if (!ref) {
      const self = lives.find((l) => l.id === o.sessionId)
      return self ? ({ ok: true, live: self } as const) : ({ ok: false, text: "◢ crosstalk: this session has no record yet; name it once it has run a turn." } as const)
    }
    return C.resolve(ref, lives)
  }
  switch (name) {
    case "crosstalk_close": {
      const services = a.services === "stop" ? "stop" : "keep"
      if (machine) return remote(o, machine, { kind: "close", session: String(a.session ?? ""), services }, d)
      const t = await target(String(a.session ?? ""))
      if (!t.ok) return text(t)
      if (t.live.id === o.sessionId) return text({ ok: false, text: "◢ crosstalk: that is this session. To end it, type /exit here." })
      return text(await C.gate({ by: o.sessionId, cwd: o.cwd, action: { kind: "close", session: t.live.id, services }, target: t.live }, d))
    }
    case "crosstalk_background": {
      if (machine) return remote(o, machine, { kind: "background", session: String(a.session ?? "") }, d)
      const t = await target(String(a.session ?? ""))
      if (!t.ok) return text(t)
      if (t.live.id === o.sessionId) return text({ ok: false, text: "◢ crosstalk: that is this session; ask from another one." })
      return text(await C.gate({ by: o.sessionId, cwd: o.cwd, action: { kind: "background", session: t.live.id }, target: t.live }, d))
    }
    case "crosstalk_find": {
      const q = String(a.query ?? "")
      if (machine) {
        const r = await d.ask({ op: "sessions_remote", sessionId: o.sessionId, machine, req: { op: "find", query: q } }, 15_000).catch((e) => ({ ok: false, error: e.message }))
        return text({ ok: !!r?.ok, text: r?.ok ? `On ${r.machine}:\n${r.text}`.replace(`Say "resume <id>"`, `Say "resume <id> on ${r.machine}"`) : `◢ crosstalk: ${r?.error ?? "no answer"}` })
      }
      return text({ ok: true, text: I.describeHits(I.find(q, I.all({ env: d.env }))) })
    }
    case "crosstalk_resume": {
      const ref = String(a.session ?? "")
      if (machine) return remote(o, machine, { kind: "resume", session: ref }, d)
      return text(await C.resume(ref, { by: o.sessionId || undefined, cwd: o.cwd }, d))
    }
    case "crosstalk_rename": {
      const t = await target(a.session ? String(a.session) : undefined)
      if (!t.ok) return text(t)
      if (t.live.id === o.sessionId) return text(await C.rename(t.live, String(a.name ?? ""), d))
      return text(await C.gate({ by: o.sessionId, cwd: o.cwd, action: { kind: "rename", session: t.live.id, name: String(a.name ?? "") }, target: t.live }, d))
    }
    case "crosstalk_move": {
      const t = await target(a.session ? String(a.session) : undefined)
      if (!t.ok) return text(t)
      return text(await C.gate({ by: o.sessionId, cwd: o.cwd, action: { kind: "move", session: t.live.id, thread: String(a.thread ?? "") }, target: t.live }, d))
    }
    case "crosstalk_tidy": {
      const names = Array.isArray(a.sessions) ? a.sessions.map(String).filter(Boolean).slice(0, 50) : []
      const plan = await C.tidyPlan({ by: o.sessionId, sessions: names.length ? names : undefined, d })
      const close = names.length ? plan.named : plan.offers
      const merge = a.merge === true && plan.windows > 1
      const action = {
        kind: "tidy" as const,
        sessions: close.map((x) => x.id),
        names: close.map((x) => x.name),
        folds: a.fold === false ? [] : plan.folds,
        tabs: a.tabs === false ? 0 : plan.tabs.length,
        merge,
      }
      const missing = plan.missing.length ? ` No open session called ${plan.missing.join(", ")}.` : ""
      if (!action.sessions.length && !action.folds.length && !action.tabs && !action.merge) {
        const hint = plan.windows > 1 && a.merge !== true ? ` Terminal has ${plan.windows} windows: say "merge my windows" to make them tabs of one.` : ""
        return text({ ok: true, text: `◢ crosstalk: nothing to tidy. No session has been idle for ${C.tidyIdleMin()} minutes or shares work with another, and no tab is left empty.${missing}${hint}` })
      }
      const out = await C.gate({ by: o.sessionId, cwd: o.cwd, action }, d)
      const why = plan.offers.length && !names.length ? `\nIdle: ${plan.offers.map((x) => `${x.name} (${x.why})`).join(", ")}.` : ""
      const folds = action.folds.length ? `\nSimilar: ${action.folds.map((f) => `${f.name} → ${f.intoName} (${f.why})`).join(", ")}.` : ""
      const win = plan.windows > 1 && !merge ? `\nTerminal has ${plan.windows} windows; with merge: true they become tabs of one, if your user wants that.` : ""
      return text({ ...out, text: `${out.text}${why}${folds}${win}${missing}` })
    }
    case "crosstalk_work_board": {
      const p = W.read()
      if (a.on === true && !p.on) {
        // Agents started by themselves: only on the person's own words, typed in this session.
        const said = T.lastPrompt(T.transcriptOf(o.sessionId, o.cwd, d.env))
        const fresh = !!said && d.now() - said.at < 15 * 60_000
        if (!fresh || !/\b(work|go|chew|get)\b[^.]*\b(tasks?|board|todos?|list)\b/i.test(said!.text))
          return text({ ok: false, text: `◢ crosstalk: working the board starts agents by themselves, so it needs your user's own words, typed here ("work through the open tasks"). Nothing was started.` })
      }
      if (typeof a.on === "boolean") {
        p.on = a.on
        if (a.on) {
          if (a.count) p.max = Math.max(1, Math.min(4, Number(a.count)))
          p.threads = a.thread ? [String(a.thread)] : undefined
          p.tried = []
        }
        W.write(p)
      }
      return text({ ok: true, text: W.describe(W.read()) })
    }
    case "crosstalk_popout":
      return text(C.popout({ name: String(a.name ?? ""), cwd: o.cwd, by: o.sessionId || undefined, env: d.env }))
    default:
      return null
  }
}

/** crosstalk_work action "spawn" on another machine (src/terminal/tools.ts hands it here when `machine` is set). */
export async function spawnOn(machine: string, a: any, o: { sessionId: string; cwd: string }, d: C.Deps = C.liveDeps()) {
  return remote(o, machine, { kind: "spawn", task: String(a.task ?? ""), ...(a.name ? { name: String(a.name) } : {}), ...(a.repo ? { repo: String(a.repo) } : {}), ...(a.count ? { count: Number(a.count) } : {}) }, d)
}

/** Other machines' sessions, for crosstalk_work action "sessions": every own machine, or the one named. */
export async function otherMachines(o: { sessionId: string; machine?: string }, d: C.Deps = C.liveDeps()): Promise<{ ok: boolean; machines?: unknown[]; error?: string }> {
  try {
    const r = await d.ask({ op: "sessions_remote", sessionId: o.sessionId, ...(o.machine ? { machine: o.machine } : {}), req: { op: "list" } }, 15_000)
    if (!r?.ok && o.machine) return { ok: false, error: r?.error ?? "no answer" }
    const list = o.machine ? [r] : (r?.machines ?? [])
    return { ok: true, machines: list.map((m: any) => (m.ok ? { machine: m.machine, sessions: m.sessions } : { machine: m.machine, unreachable: m.error })) }
  } catch (e) {
    return { ok: false, error: (e as Error).message }
  }
}
