// Sessions and attention, plugged into the daemon: the service over the
// daemon's sessions, threads and rules, and the few things daemon.ts calls.

import path from "node:path"
import { P } from "../config.ts"
import type { ThreadService } from "../threads/service.ts"
import type { Coordinator } from "../coordinator.ts"
import { ruleKey, neverAuto, type Question } from "../rules/key.ts"
import * as spawn from "../spawn.ts"
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
    rule: (q: Question, repo) => {
      const c = o.coord()
      if (!c || !repo) return undefined
      const r = c.docs.match(repo, ruleKey(q))
      return r?.then && !neverAuto(q, r.then) ? r.then : undefined
    },
    answered: (q, answer, x) => void o.coord()?.answered(q, answer, x),
    spawn: (x) => {
      const r = spawn.spawnAgents({ task: x.task, name: x.name, cwd: x.cwd, by: x.by, background: x.background, thread: x.thread })
      // No way to run it out of sight here: a tab of the person's terminal instead.
      if (!r.ok && x.background && !r.agents.length && /background/i.test(r.text)) return spawn.spawnAgents({ task: x.task, name: x.name, cwd: x.cwd, by: x.by, background: false, thread: x.thread })
      return r
    },
    background: backgroundOf,
  })
}
