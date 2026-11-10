// Sessions and attention, plugged into the daemon: the service over the
// daemon's sessions and threads, and the few things daemon.ts calls.

import fs from "node:fs"
import path from "node:path"
import { P } from "../config.ts"
import { pluginVersion } from "../client.ts"
import * as R from "../restore.ts"
import * as Main from "../main.ts"
import type { ThreadService } from "../threads/service.ts"
import type { Coordinator } from "../coordinator.ts"
import * as spawn from "../spawn.ts"
import * as Park from "./park.ts"
import * as Ctl from "../sessions/control.ts"
import * as G from "../gather.ts"
import { AttentionService, type Reg } from "./service.ts"

export function createAttention(o: {
  threads: ThreadService
  coord: () => Coordinator | undefined
  root: string
  log: (...a: unknown[]) => void
  sessions: () => Map<string, Reg & { footprint?: { paths: Record<string, number> } }>
  status: (sid: string) => string
  modLive: (sid: string) => boolean
  repoOf: (sid: string) => string | undefined
}): AttentionService {
  const backgroundOf = (sid: string): string | undefined => {
    try {
      const r = spawn.readSpawned().find((x) => x.sessionId === sid && x.background && !x.removedAt)
      return r?.name
    } catch {
      return undefined
    }
  }
  return new AttentionService({
    threads: o.threads,
    log: o.log,
    file: path.join(P.root, "attention-state.json"),
    root: o.root,
    sessions: o.sessions,
    status: o.status,
    mainId: () => o.coord()?.mainId(),
    modLive: o.modLive,
    touched: (sid) => o.sessions().get(sid)?.footprint?.paths,
    repoOf: o.repoOf,
    // No rule lookup: the one standing rule here (starting fresh) ends the
    // person's own sessions, so it is theirs, kept in the service's own state,
    // never the repo's shared RULES.md.
    spawn: (x) => {
      const r = spawn.spawnAgents({ task: x.task, name: x.name, cwd: x.cwd, by: x.by, background: x.background, thread: x.thread, noQueue: true })
      // No way to run it out of sight here: a tab of the person's terminal instead.
      if (!r.ok && x.background && !x.noTab && !r.agents.length && /background/i.test(r.text)) return spawn.spawnAgents({ task: x.task, name: x.name, cwd: x.cwd, by: x.by, background: false, thread: x.thread })
      return r
    },
    background: backgroundOf,
    version: pluginVersion(o.root) || undefined,
    installedAt: firstRun(pluginVersion(o.root)),
    // Main onto the new version: closed (archived) and resumed in a new tab, the same session and
    // conversation, made main again once it is back.
    handover: async (sid) => {
      const d = Ctl.liveDeps()
      const l = (await Ctl.liveSessions(d)).find((x) => x.id === sid)
      if (!l) return { ok: false, text: "main is not open" }
      // Never closed unless it can be opened again from here: a terminal crosstalk can open tabs in.
      const kind = R.kindOf(l.terminal)
      if (!kind || !R.canDrive(kind, R.liveEnv(process.env, true), l.terminal)) return { ok: false, text: "its terminal cannot open a tab for crosstalk" }
      const c = await Ctl.close(l, { services: "keep" }, d)
      if (!c.ok) return c
      const r0 = await Ctl.resume(sid, { cwd: l.cwd }, d)
      // "Run this to resume it" means nothing was opened: a failure, said in main.
      const r = r0.ok && /cannot open a tab|To resume it yourself/.test(r0.text) ? { ...r0, ok: false } : r0
      if (r.ok)
        void (async () => {
          for (let i = 0; i < 60; i++) {
            await new Promise((res) => setTimeout(res, 2000))
            const rec = R.readOne(sid)
            if (rec && rec.pid !== l.pid && R.recAlive(rec)) {
              Main.setMain(true, { sessionId: sid, name: l.name, pid: rec.pid })
              return
            }
          }
        })()
      return r
    },
    drainQueue: () => {
      const working = spawn.readSpawned().filter((r) => r.background && !r.removedAt && !!r.tmux && spawn.tmuxHas(r.tmux)).length
      const started = Park.drain(working, (x) => spawn.spawnAgents({ task: x.task, name: x.name, cwd: x.cwd, by: x.by, background: true, thread: x.thread as any, noQueue: true }).agents.length > 0, {
        threadOf: (x) => (x.thread as { name?: string } | undefined)?.name,
      })
      return started.map((x) => x.name ?? x.task.slice(0, 40))
    },
    agentAlive: (name) => spawn.tmuxHas(name),
    // Closing on crosstalk's own judgment: the same close a person's "close billing" makes (archived, resumable).
    closeSession: async (sid) => {
      const d = Ctl.liveDeps()
      const lives = await Ctl.liveSessions(d)
      const l = lives.find((x) => x.id === sid)
      if (!l) return { ok: false, text: "gone" }
      return Ctl.close(l, { services: "keep" }, d)
    },
    running: (sid) => {
      const r = o.sessions().get(sid)
      if (!r?.pid) return false
      try {
        return (G.liveSys().activity?.(r.pid) ?? []).length > 0
      } catch {
        return false
      }
    },
  })
}

/** When this version of crosstalk first ran here: sessions started before it run an older one. */
export function firstRun(version: string, now = Date.now()): number | undefined {
  if (!version) return undefined
  const f = path.join(P.root, "versions.json")
  let seen: Record<string, number> = {}
  try {
    seen = JSON.parse(fs.readFileSync(f, "utf8"))
  } catch {}
  if (typeof seen[version] === "number") return seen[version]
  // A minute's grace: the session whose hook started this daemon began just before it.
  seen[version] = now - 60_000
  try {
    fs.mkdirSync(P.root, { recursive: true, mode: 0o700 })
    fs.writeFileSync(f, JSON.stringify(seen), { mode: 0o600 })
  } catch {}
  return seen[version]
}
