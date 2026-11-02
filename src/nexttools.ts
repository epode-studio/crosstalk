// MCP tools for the main session, standing rules, conflicts between threads
// and first use in a repo. An action of one of
// the eight tools (src/tools/) resolves to one of these names. Each is plain language for something the mod
// also offers as a picker, so a session without the mod loses nothing.

import { ensureDaemon, request } from "./client.ts"
import * as firstuse from "./repotrust/firstuse.ts"
import { otherMachines } from "./sessions/tools.ts"

const ok = (o: unknown) => ({ content: [{ type: "text" as const, text: typeof o === "string" ? o : JSON.stringify(o, null, 2) }] })
const err = (m: string) => ({ content: [{ type: "text" as const, text: `crosstalk error: ${m}` }], isError: true })
const reply = (r: any) => (r?.ok ? ok(r.text ?? { ...r, ok: undefined }) : err(r?.error ?? r?.text ?? "no answer"))

/** The call, or null when the tool is not one of these. */
export async function callTool(name: string, a: any, o: { sessionId: string; cwd: string; root: string }) {
  const base = { sessionId: o.sessionId, cwd: o.cwd }
  switch (name) {
    case "crosstalk_main":
      return reply(await request({ op: "main", ...base, on: a.on !== false }))
    case "crosstalk_sessions": {
      const machine = typeof a.machine === "string" && a.machine.trim() ? a.machine.trim() : undefined
      const r = machine ? { ok: true } : await request({ op: "sessions", ...base })
      if (!r.ok) return err(r.error ?? "no answer")
      // The user's other machines, over the sealed relay (src/sessions/remote.ts).
      const others = await otherMachines({ sessionId: o.sessionId, machine })
      if (machine) return others.ok ? ok({ machines: others.machines }) : err(others.error ?? "no answer")
      return ok({ main: r.main, sessions: r.sessions, ...(others.machines?.length ? { otherMachines: others.machines } : {}) })
    }
    case "crosstalk_steer":
      return reply(await request({ op: "steer", ...base, session: a.session, text: a.text }))
    case "crosstalk_rule": {
      const r = await request({ op: "rule", ...base, accept: a.accept, decline: a.decline, remove: a.remove, repo: a.repo, public: a.public })
      return r.ok && !r.text ? ok({ rules: r.rules, offers: r.offers }) : reply(r)
    }
    case "crosstalk_conflict": {
      const r = await request({ op: "conflict", ...base, id: a.id, owner: a.owner, text: a.text })
      return r.ok && !a.id ? ok({ conflicts: r.conflicts }) : reply(r)
    }
    case "crosstalk_connect": {
      if (typeof a.confirm !== "boolean") return err("pass confirm: true for yes, false for not in this repo")
      const out = await firstuse.connect({ cwd: o.cwd, slug: a.repo ? String(a.repo).toLowerCase() : undefined, yes: a.confirm, ensureDaemon: () => ensureDaemon(o.root), request })
      return out.ok ? ok(out.text) : err(out.text)
    }
    default:
      return null
  }
}
