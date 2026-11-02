// Disk, team install, measurements and leaving a thread, plugged into the
// daemon. Each lives in its own module; this only gives them the daemon's
// threads, sessions, pickers and digest, and answers their ops:
//
//   disk            src/disk: the budget question, crosstalk_disk
//   team_install    src/install/team.ts: "Turn crosstalk on for everyone…"
//   stats           src/metrics: crosstalk_stats, and a weekly digest line
//   thread_person   src/threads/rekey.ts: take someone out, or leave; re-keys
//
// Cross-repo heads-ups are the coordinator's (they ride on the `edited` op).

import fs from "node:fs"
import path from "node:path"
import { ROOT, loadPeers } from "./config.ts"
import * as ui from "./uistate.ts"
import type { ThreadService } from "./threads/service.ts"
import * as M from "./threads/model.ts"
import * as Disk from "./disk/scan.ts"
import * as B from "./disk/budget.ts"
import { Budget } from "./disk/budget.ts"
import { git as liveGit } from "./terminal/repo.ts"
import * as Team from "./install/team.ts"
import * as Log from "./metrics/log.ts"
import * as Stats from "./metrics/stats.ts"
import { firstEditOf, transcriptFor } from "./metrics/transcripts.ts"
import { readRegistry } from "./gather.ts"
import * as R from "./restore.ts"
import { readSpawned, writeSpawned } from "./spawn.ts"
import { findRepo } from "./repotrust/gitref.ts"
import * as firstuse from "./repotrust/firstuse.ts"

export type ExtrasDeps = {
  threads: ThreadService
  log: (...a: unknown[]) => void
  /** Where a question goes when nothing more specific is known: main, else the latest session. */
  fallbackSession: () => string | undefined
  modLive: (sessionId: string) => boolean
  /** A line for the digest (the coordinator's), shown once by whichever session asks first. */
  digest: (id: string, text: string) => void
}

const HOUR = 60 * 60_000

export function createExtras(d: ExtrasDeps) {
  const ask = (o: { id: string; question: string; options: string[]; kind: "disk" | "install"; sessionId?: string; thread?: string; say: string }) => {
    const sid = o.sessionId ?? d.fallbackSession()
    if (sid && d.modLive(sid)) {
      try {
        ui.withStore((items, now) => ui.upsert(items, { id: o.id, kind: o.kind, sessionId: sid, question: o.question, options: o.options, ...(o.thread ? { thread: o.thread } : {}), ts: now }, now))
        return
      } catch (e) {
        d.log(`${o.kind}: picker not stored: ${(e as Error).message}`)
      }
    }
    d.digest(o.id, `◢ crosstalk: ${o.question} ${o.say}`)
  }

  const scanNow = () =>
    Disk.scan({
      claudeDir: Disk.defaultClaudeDir(),
      now: Date.now(),
      git: liveGit,
      liveCwds: Disk.liveCwds({ registry: readRegistry(), records: R.readAll().filter((r) => !r.endedAt && R.recAlive(r)) }),
      repos: Object.values(d.threads.roots()),
      sizeKb: Disk.duKb,
      threadOf: (_root, branch) => d.threads.all().find((t) => !!t.branches[branch] && !t.branches[branch].gone)?.meta.value.name,
    })

  const budget = new Budget({
    scan: () => scanNow(),
    free: (confirmed, fresh) => {
      const out = Disk.free(confirmed, fresh)
      // A worktree crosstalk spawned is done with too.
      const gone = new Set(out.filter((f) => f.ok).map((f) => path.resolve(f.path)))
      for (const r of readSpawned()) if (!r.removedAt && gone.has(path.resolve(r.worktree))) writeSpawned({ ...r, removedAt: Date.now() })
      return out
    },
    ask: (o) => ask({ ...o, kind: "disk", say: `Say "free it", "show me" or "not now"; the agent answers with crosstalk_disk.` }),
    settle: (id) => ui.withStore((items, now) => ui.settle(items, id, "answered", now)),
    digest: d.digest,
    log: d.log,
  })

  async function offerInstalls() {
    for (const [repo, root] of Object.entries(d.threads.roots())) {
      if (!fs.existsSync(root)) continue
      const ids = d.threads.all().filter((t) => t.meta.value.repo === repo).map((t) => t.id)
      if (!ids.length) continue
      const r = await findRepo(root).catch(() => null)
      if (!r) continue
      if (!Team.shouldOffer({ slug: r.slug, root: r.top, inUse: true, connected: firstuse.consent(r.slug) === "yes" })) continue
      Team.markAsked(r.slug, r.top)
      ask({
        id: Team.installId(r.slug),
        kind: "install",
        question: Team.questionText(r.slug),
        options: [Team.YES, Team.NO],
        sessionId: d.threads.sessionsIn(ids)[0],
        thread: r.slug,
        say: `Say "turn crosstalk on for everyone" or "not now"; the agent answers with crosstalk_team_install.`,
      })
      d.log(`team install: asked about ${r.slug}`)
    }
  }

  const statsNow = (weeks?: number) =>
    Stats.compute({
      events: Log.read(),
      threads: d.threads.all(),
      weeks,
      firstEdit: (sid, hint) => {
        const f = transcriptFor(sid, hint)
        return f ? firstEditOf(f) : null
      },
    })

  const weeklyFile = () => path.join(process.env.CROSSTALK_HOME ?? ROOT, "metrics-digest.json")
  function weekly() {
    const week = Stats.weekOf(Date.now())
    let last: string | undefined
    try {
      last = JSON.parse(fs.readFileSync(weeklyFile(), "utf8")).week
    } catch {}
    if (last === week) return
    const events = Log.read()
    // A digest of nothing says nothing: only once something was measured.
    if (events.length) d.digest(`stats:${week}`, Stats.weeklyLine(statsNow(2)))
    fs.writeFileSync(weeklyFile(), JSON.stringify({ week }), { mode: 0o600 })
  }

  async function tick() {
    for (const [name, fn] of [
      ["disk", () => budget.check()],
      ["team install", () => offerInstalls()],
      ["stats", () => weekly()],
    ] as const)
      try {
        await fn()
      } catch (e) {
        d.log(`${name}: ${(e as Error).message}`)
      }
  }
  if (process.env.CROSSTALK_NO_EXTRAS_TICK !== "1") {
    const first = setTimeout(() => void tick(), Number(process.env.CROSSTALK_EXTRAS_FIRST_MS ?? 2 * 60_000))
    first.unref?.()
    const every = setInterval(() => void tick(), Number(process.env.CROSSTALK_EXTRAS_EVERY_MS ?? HOUR))
    every.unref?.()
  }

  /** The daemon's ops for these, or undefined when the op is someone else's. */
  async function handle(req: Record<string, any>, sessionId: string | undefined): Promise<unknown> {
    switch (req.op) {
      case "disk": {
        if (typeof req.rule === "boolean") return { ok: true, text: budget.setRule(req.rule) }
        if (req.confirm === true) return budget.freeNow()
        if (req.confirm === false) return budget.answer("disk:tool", "Not now")
        // What was listed is what a later "free it" frees.
        const r = await scanNow()
        B.save({ ...B.load(), report: r })
        return { ok: true, text: B.listing(r), usedKb: r.usedKb, reclaimKb: r.reclaimKb, groups: r.groups }
      }
      case "stats": {
        const s = statsNow(Number(req.weeks) || undefined)
        return { ok: true, text: Stats.render(s), stats: req.json ? s : undefined }
      }
      case "team_install": {
        if (typeof req.confirm !== "boolean") return { ok: false, error: "pass confirm: true to turn crosstalk on for the repo, false for not now" }
        const cwd = String(req.cwd ?? "")
        const r = cwd ? await findRepo(cwd).catch(() => null) : null
        const slug = req.repo ? String(req.repo).toLowerCase() : r?.slug
        const out = Team.answer(slug, req.confirm, { root: r?.top })
        if (slug) ui.withStore((items, now) => ui.settle(items, Team.installId(slug), "answered", now))
        return { ok: out.ok, text: out.text, ...(out.ok ? {} : { error: out.text }) }
      }
      case "thread_person": {
        const t = d.threads.find(sessionId, req.thread ? String(req.thread) : undefined)
        if (!t) return { ok: false, error: req.thread ? `no thread called "${req.thread}"` : "this session is in no thread" }
        const who = String(req.person ?? "").trim()
        let fp: string | undefined
        if (!who || who === "me") fp = d.threads.me
        else {
          const want = who.toLowerCase()
          fp = M.live(t, "people").find((p) => p.id === who || p.label.toLowerCase() === want)?.id ?? Object.values(loadPeers()).find((p) => p.label.toLowerCase() === want)?.fingerprint
        }
        if (!fp) return { ok: false, error: `nobody called "${who}" is in ${t.meta.value.name}. People: ${M.live(t, "people").map((p) => p.label).join(", ")}` }
        const label = fp === d.threads.me ? "you" : (M.live(t, "people").find((p) => p.id === fp)?.label ?? who)
        const r = d.threads.removePerson(t.id, fp)
        if (!r.ok) return r
        return {
          ok: true,
          text:
            fp === d.threads.me
              ? `◢ crosstalk: you left ${r.thread}. Its people get a new key, so nothing written there from now on opens for you; what you could read before stays readable to you.`
              : `◢ crosstalk: took ${label} out of ${r.thread}${r.rekeyed ? " and gave everyone left a new key" : ""}. Nothing written from now on opens for ${label}; old commits on the ref stay readable to whoever already had them.`,
        }
      }
      default:
        return undefined
    }
  }

  /** The mod's picker answered a disk or install question. */
  async function uiAct(it: ui.UiItem, value: string): Promise<Record<string, unknown> | undefined> {
    if (it.kind !== "disk" && it.kind !== "install") return undefined
    const claim = ui.withStore((items, now) => ui.act(items, it.id, "answer", now, value))
    if (!claim.ok) return claim
    if (it.kind === "disk") return { ...(await budget.answer(it.id, value)), item: claim.item }
    const slug = it.id.slice("install:".length)
    const out = Team.answer(slug, value === Team.YES)
    return { ok: out.ok, text: out.text, ...(out.ok ? {} : { error: out.text }), item: claim.item }
  }

  return { handle, uiAct, tick, budget, stats: statsNow }
}
