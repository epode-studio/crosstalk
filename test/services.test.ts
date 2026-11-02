// Long-running processes that outlive Claude sessions (docs/services.md):
// port blocks, what a session started, postponing an end, cleanup refusing
// what is in use, and the service records themselves.
//
//   bun test test/services.test.ts
//
// Real tmux, a real HTTP server and a stub claude are test/services.sh.

import { afterAll, describe, expect, test } from "bun:test"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { spawn, spawnSync } from "node:child_process"

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), "ct-svc-"))
process.env.CROSSTALK_HOME = path.join(TMP, "home")
fs.mkdirSync(process.env.CROSSTALK_HOME, { recursive: true })
const kids: number[] = []
afterAll(() => {
  for (const p of kids)
    try {
      process.kill(-p, "SIGKILL")
    } catch {}
  fs.rmSync(TMP, { recursive: true, force: true })
})

const Pt = await import("../src/services/ports.ts")
const Pr = await import("../src/services/procs.ts")
const Svc = await import("../src/services/service.ts")
const PP = await import("../src/services/postpone.ts")
const G = await import("../src/gather.ts")
const R = await import("../src/restore.ts")
const D = await import("../src/attention/dispose.ts")
const C = await import("../src/cleanup.ts")
const S = await import("../src/attention/service.ts")
const TH = await import("../src/terminal/hook.ts")
const { ThreadService } = await import("../src/threads/service.ts")
const { newIdentity } = await import("../src/crypto.ts")
type Rec = import("../src/restore.ts").Rec

describe("ports", () => {
  test("the first free block, skipping blocks given out and blocks with a port in use", () => {
    expect(Pt.pickBase({ taken: [], inUse: new Set(), start: 4100 })).toBe(4100)
    expect(Pt.pickBase({ taken: [4100], inUse: new Set(), start: 4100 })).toBe(4110)
    expect(Pt.pickBase({ taken: [4100], inUse: new Set([4115]), start: 4100 })).toBe(4120)
    // A block given out under another start still counts: no overlap at all.
    expect(Pt.pickBase({ taken: [4105], inUse: new Set(), start: 4100 })).toBe(4120)
    expect(Pt.pickBase({ taken: [], inUse: new Set([4100]), start: 4100, max: 4109 })).toBeNull()
  })

  test("stable per worktree, unique across worktrees, and avoids ports in use", () => {
    const a = path.join(TMP, "wa")
    const b = path.join(TMP, "wb")
    const c = path.join(TMP, "wc")
    for (const d of [a, b, c]) fs.mkdirSync(d)
    const first = Pt.blockFor(a, { inUse: () => new Set() })!
    expect(first.ports.length).toBe(10)
    expect(Pt.blockFor(a, { inUse: () => new Set([first.base]) })!.base).toBe(first.base)
    const second = Pt.blockFor(b, { inUse: () => new Set() })!
    expect(second.base).not.toBe(first.base)
    expect(Math.abs(second.base - first.base)).toBeGreaterThanOrEqual(10)
    const third = Pt.blockFor(c, { inUse: () => new Set(Pt.range(second.base + 10)) })!
    expect(third.base).toBe(second.base + 20)
    expect(Pt.portEnv(first)).toEqual({ PORT: String(first.base), CROSSTALK_PORT_BASE: String(first.base), CROSSTALK_PORTS: first.ports.join(",") })
    // A worktree that is gone gives its block back to the next one.
    fs.rmSync(b, { recursive: true })
    const d = path.join(TMP, "wd")
    fs.mkdirSync(d)
    expect(Pt.blockFor(d, { inUse: () => new Set() })!.base).toBe(second.base)
    Pt.release(d)
    expect(Pt.blockOf(d)).toBeNull()
  })
})

describe("what is running", () => {
  test("ss and lsof, parsed", () => {
    expect(Pr.parseSs(`LISTEN 0 511 0.0.0.0:3001 0.0.0.0:* users:(("bun",pid=123,fd=12))\nLISTEN 0 4096 [::]:8080 [::]:* users:(("node",pid=7,fd=3),("node",pid=8,fd=3))`)).toEqual([
      { pid: 123, port: 3001 },
      { pid: 7, port: 8080 },
      { pid: 8, port: 8080 },
    ])
    expect(Pr.parseLsof("p123\nf12\nn*:3001\np9\nn127.0.0.1:5173\nn[::1]:5173\n")).toEqual([
      { pid: 123, port: 3001 },
      { pid: 9, port: 5173 },
      { pid: 9, port: 5173 },
    ])
    expect([...Pr.parseLsofCwd("p1\nfcwd\nn/a b/c\np2\nn/d\n")]).toEqual([
      [1, "/a b/c"],
      [2, "/d"],
    ])
    expect(Pr.parsePs("  1     0 /sbin/init\n 42  1 bun x.ts --port 3\n")).toEqual([
      { pid: 1, ppid: 0, args: "/sbin/init" },
      { pid: 42, ppid: 1, args: "bun x.ts --port 3" },
    ])
  })

  const table: import("../src/services/procs.ts").Proc[] = [
    { pid: 100, ppid: 1, args: "claude" },
    { pid: 101, ppid: 100, args: "node /mcp/server.js" }, // an MCP server: Claude Code's own
    { pid: 102, ppid: 101, args: "bun child-of-mcp.ts" },
    { pid: 103, ppid: 100, args: "/bin/zsh -c source snap && eval 'npm run dev'" }, // its Bash tool
    { pid: 104, ppid: 103, args: "npm run dev" },
    { pid: 105, ppid: 104, args: "node vite" },
    { pid: 106, ppid: 100, args: "/bin/bash" }, // a shell with nothing in it
    { pid: 107, ppid: 100, args: "sh -c bun /plugin/src/cli.ts ui watch" }, // crosstalk's own watch
    { pid: 108, ppid: 107, args: "bun /plugin/src/cli.ts ui watch" },
    { pid: 109, ppid: 100, args: "bash -c tail -f x" }, // started by the agent, a crosstalk service
    { pid: 110, ppid: 109, args: "tail -f x" },
  ]

  test("descendants and trees", () => {
    expect(Pr.descendants(103, table).map((p) => p.pid)).toEqual([104, 105])
    expect(Pr.tree(100, table).sort((a, b) => a - b)).toEqual(table.map((p) => p.pid).sort((a, b) => a - b))
  })

  test("what a session started: below its shells, not its MCP servers, crosstalk's own, or services", () => {
    const got = Pr.activity(100, { table, listeners: [{ pid: 105, port: 5173 }, { pid: 102, port: 9000 }], exclude: new Set([109, 110]), ours: Pr.oursBy("/plugin") })
    expect(got).toEqual([
      { pid: 104, args: "npm run dev", ports: [] },
      { pid: 105, args: "node vite", ports: [5173] },
    ])
    // Nothing running below a shell: nothing.
    expect(Pr.activity(100, { table: table.filter((p) => ![104, 105].includes(p.pid)), listeners: [], exclude: new Set([109, 110]), ours: Pr.oursBy("/plugin") })).toEqual([])
  })

  test("the live look finds a real child below a real shell, and lets it go when it exits", async () => {
    // This test process stands in for claude: a shell child running sleep.
    const sh = spawn("sh", ["-c", "sleep 30; true"], { stdio: "ignore", detached: true })
    kids.push(sh.pid!)
    await new Promise((r) => setTimeout(r, 200))
    const busy = PP.liveActivity(process.pid)
    expect(busy.some((a) => a.args.startsWith("sleep 30"))).toBe(true)
    process.kill(-sh.pid!, "SIGTERM")
    await new Promise((r) => setTimeout(r, 300))
    expect(PP.liveActivity(process.pid).some((a) => a.args.startsWith("sleep 30"))).toBe(false)
  })
})

describe("postponing an end", () => {
  const NOW = 1_800_000_000_000
  const sysWith = (busy: () => boolean) => {
    const signals: [number, string][] = []
    const procs: Record<number, boolean> = { 60: true }
    const sys: import("../src/gather.ts").Sys = {
      platform: "linux",
      now: () => NOW,
      ps: (pid, f) => (!procs[pid] ? (pid === 900 && f === "comm" ? "-zsh" : null) : f === "lstart" ? "start-60" : f === "args" ? "claude" : f === "ppid" ? "900" : f === "etime" ? "05:00" : null),
      alive: (pid) => !!procs[pid],
      env: () => null,
      tmuxPanes: () => [],
      appleLocate: () => null,
      kill: (pid, sig) => {
        signals.push([pid, sig])
        delete procs[pid]
      },
      run: () => ({ ok: true, out: "" }),
      sleep: async () => {},
      activity: () => (busy() ? [{ pid: 61, args: "node server.js", ports: [4100] }] : []),
    }
    return { sys, signals }
  }

  test("gather: an idle session running a server it started waits, then restarts once it stops", async () => {
    R.writeRec({ sessionId: "pp-1", pid: 60, pidStart: "start-60", adopted: "watched", interactive: true, terminal: { tmux: { pane: "%1" } }, cwd: "/w", client: "claude", startedAt: NOW - 1000, seenAt: NOW - 1000 })
    let busy = true
    const { sys, signals } = sysWith(() => busy)
    const reg = [{ pid: 60, sessionId: "pp-1", cwd: "/w", status: "idle", startedAt: NOW - 5 * 60_000 }]
    expect(await G.restartOne("pp-1", { selfPids: [], sys, registry: reg, reopen: () => false })).toBe("wait")
    expect(signals).toEqual([])
    busy = false
    expect(await G.restartOne("pp-1", { selfPids: [], sys, registry: reg, reopen: () => false })).toBe("done")
    expect(signals).toEqual([[60, "SIGTERM"]])
  })

  test("dispose: restart says wait and ends nothing while something it started runs", async () => {
    const rec: Rec = { sessionId: "pp-2", pid: 60, pidStart: "start-60", terminal: { tmux: { pane: "%1" } }, cwd: "/w", client: "claude", startedAt: 0, seenAt: 0 }
    R.writeRec(rec)
    const { sys, signals } = sysWith(() => true)
    const r = await D.restart({ rec, cmd: "claude x", sys })
    expect(r.ok).toBe(false)
    expect(r.wait).toBe(true)
    expect(signals).toEqual([])
    expect(R.readOne("pp-2")!.endedAt).toBeUndefined()
  })

  function world(o: { rule?: boolean; busy: () => boolean; env?: NodeJS.ProcessEnv }) {
    const threads = new ThreadService({ identity: newIdentity("ana"), peers: () => ({}), send: () => {}, log: () => {}, file: path.join(TMP, `threads-${Math.random()}.json`), network: false })
    const sessions = new Map<string, import("../src/attention/service.ts").Reg>()
    const restarted: any[] = []
    const rec: Rec = { sessionId: "s1", cwd: "/w/s1", client: "claude", pid: 100, startedAt: 0, seenAt: 0, terminal: { tmux: { pane: "%1" } }, name: "s1" }
    const svc = new S.AttentionService({
      threads,
      log: () => {},
      file: path.join(TMP, `attn-${Math.random()}.json`),
      root: "/plugin",
      sessions: () => sessions,
      status: () => "idle",
      mainId: () => undefined,
      modLive: () => true,
      touched: () => ({}),
      repoOf: () => "github.com/acme/api",
      spawn: () => ({ ok: true, text: "", agents: [] }),
      background: () => undefined,
      restart: async (x) => (o.busy() ? { ok: false, wait: true, text: "something it started is still running (1 process)" } : (restarted.push(x), { ok: true, text: "ok" })),
      busy: () => o.busy(),
      readRecs: () => [rec],
      recAlive: () => true,
      lastCommitAt: () => undefined,
      env: { CROSSTALK_STAFF_EVERY_MS: "0", ...o.env },
    })
    if (o.rule) svc.setDisposeRule(true)
    sessions.set("s1", { sessionId: "s1", name: "s1", cwd: "/w/s1", seenAt: Date.now() })
    threads.observe({ sessionId: "s1", name: "s1", cwd: "/w/s1", repo: "github.com/acme/api", branch: "main", paths: ["src/auth/a.ts", "src/auth/b.ts", "src/auth/c.ts"] })
    return { svc, restarted }
  }

  test("a yes to start fresh waits silently, then starts it once what it started stops", async () => {
    process.env.CROSSTALK_POSTPONE_POLL_MS = "30"
    let busy = true
    const w = world({ busy: () => busy })
    const r = await w.svc.dispose("s1")
    expect(r.ok).toBe(true)
    expect(r.text).toContain("once what it started")
    expect(w.restarted.length).toBe(0)
    expect(w.svc.waitingToDispose("s1")).toBe(true)
    await new Promise((x) => setTimeout(x, 100))
    expect(w.restarted.length).toBe(0)
    busy = false
    await new Promise((x) => setTimeout(x, 150))
    expect(w.restarted.length).toBe(1)
    expect(w.svc.waitingToDispose("s1")).toBe(false)
  })

  test("context fully spent while it waits: Claude Code compacts as usual, nothing is ended", async () => {
    process.env.CROSSTALK_POSTPONE_POLL_MS = "30"
    let busy = true
    const w = world({ rule: true, busy: () => busy })
    // The standing rule would block the compaction and start fresh; busy, it does neither.
    const pc = await w.svc.precompact("s1", "auto")
    expect(pc.block).toBeUndefined()
    // A wait already under way is called off by the compaction too.
    await w.svc.dispose("s1")
    expect(w.svc.waitingToDispose("s1")).toBe(true)
    expect((await w.svc.precompact("s1", "auto")).block).toBeUndefined()
    expect(w.svc.waitingToDispose("s1")).toBe(false)
    busy = false
    await new Promise((x) => setTimeout(x, 120))
    expect(w.restarted.length).toBe(0)
  })

  test("bounded: it gives up after the wait is up", async () => {
    process.env.CROSSTALK_POSTPONE_POLL_MS = "20"
    process.env.CROSSTALK_POSTPONE_UNTIL_MS = "60"
    const w = world({ busy: () => true })
    await w.svc.dispose("s1")
    await new Promise((x) => setTimeout(x, 250))
    expect(w.svc.waitingToDispose("s1")).toBe(false)
    expect(w.restarted.length).toBe(0)
    delete process.env.CROSSTALK_POSTPONE_UNTIL_MS
  })
})

describe("cleanup keeps what is in use", () => {
  const sp = (name: string, o: Partial<import("../src/spawn.ts").SpawnRec> = {}) => ({
    id: `app--${name}`,
    name,
    task: "t",
    repo: "/code/app",
    worktree: `/h/wt/${name}`,
    cwd: `/h/wt/${name}`,
    branch: `crosstalk/${name}`,
    base: "base",
    createdAt: 1,
    background: false,
    links: [],
    ...o,
  })
  const probe = (o: Partial<import("../src/cleanup.ts").Probe> = {}): import("../src/cleanup.ts").Probe => ({
    exists: () => true,
    clean: () => true,
    branchExists: () => true,
    merged: () => true,
    ended: () => true,
    ...o,
  })

  test("a process inside keeps it; a crosstalk service is named, to stop first", () => {
    const recs = [sp("busy"), sp("served"), sp("free")]
    const c = C.select(recs, probe({ inUse: (w) => (w.endsWith("busy") ? "a process is running in it (node x, pid 4)" : null), services: (w) => (w.endsWith("served") ? [{ name: "web", listening: [4100] }] : []) }))
    expect(c.map((x) => [x.rec.name, x.services ?? []])).toEqual([
      ["served", ["web · :4100"]],
      ["free", []],
    ])
    expect(C.offerFor(c)!.question).toContain("Its service (web · :4100) stops first.")
  })

  test("removing refuses while a service or any process runs in it, before git is asked anything", () => {
    const asked: string[][] = []
    const g = (_c: string, a: string[]) => (asked.push(a), { ok: true, out: "" })
    const o = { repo: "/code/app", worktree: "/h/wt/x", links: [], ours: true }
    expect(C.removeOne(o, g, { services: () => [{ name: "web" }], inUse: () => null })).toEqual({ path: "/h/wt/x", kb: 0, ok: false, why: "a crosstalk service is running in it (web)" })
    expect(C.removeOne(o, g, { services: () => [], inUse: () => "a process is running in it (vim, pid 9)" }).why).toBe("a process is running in it (vim, pid 9)")
    expect(asked).toEqual([])
  })

  test("a process whose working directory is inside, found by cwd", () => {
    const w = path.join(TMP, "inuse")
    fs.mkdirSync(path.join(w, "sub"), { recursive: true })
    expect(C.inUseBy(w, { cwds: new Map([[999_999, path.join(w, "sub")]]), exclude: new Set(), table: [{ pid: 999_999, ppid: 1, args: "node dev.js" }] })).toContain("node dev.js")
    expect(C.inUseBy(w, { cwds: new Map([[999_999, path.join(w, "sub")]]), exclude: new Set([999_999]), table: [] })).toBeNull()
    expect(C.inUseBy(w, { cwds: new Map([[999_999, TMP]]), exclude: new Set(), table: [] })).toBeNull()
  })
})

describe("services", () => {
  test("a name from the command", () => {
    expect(Svc.nameFrom("npm run dev")).toBe("dev")
    expect(Svc.nameFrom("PORT=3 pnpm run storybook -- -p 6006")).toBe("storybook")
    expect(Svc.nameFrom("docker compose up")).toBe("compose")
    expect(Svc.nameFrom("bun server.ts")).toBe("server")
    expect(Svc.nameFrom("python3 -m http.server")).toBe("http")
  })

  test("its environment: the session's, without provider tokens, secrets or crosstalk's own, plus the ports", () => {
    const env = Svc.serviceEnv(
      { PATH: "/bin", HOME: "/h", DATABASE_URL: "postgres://x", GITHUB_TOKEN: "t", LAUNCHDARKLY_SDK: "k", OPENAI_API_KEY: "k", CROSSTALK_HOME: "/c", CLAUDE_CODE_SESSION_ID: "s", ANTHROPIC_API_KEY: "a", TMUX: "/t", NODE_ENV: "development" },
      { PORT: "4100" },
    )
    expect(env).toEqual({ PATH: "/bin", HOME: "/h", DATABASE_URL: "postgres://x", NODE_ENV: "development", PORT: "4100" })
  })

  test("the script: its folder, its environment and nothing else, the log, the exit status", () => {
    const s = Svc.script({ cwd: "/w/a b", command: "npm run dev", env: { PORT: "4100", X: "it's" }, log: "/l/x.log", status: "/l/x.exit" })
    expect(s).toBe(`cd '/w/a b' || exit 1; env -i PORT=4100 'X=it'\\''s' sh -c 'npm run dev' >>/l/x.log 2>&1 </dev/null; echo $? >/l/x.exit`)
  })

  test("a log's tail: the last lines, without escapes", () => {
    const f = path.join(TMP, "x.log")
    fs.writeFileSync(f, Array.from({ length: 50 }, (_, i) => `\x1b[32mline ${i}\x1b[0m`).join("\n") + "\n\x1b]0;title\x07done\n")
    const t = Svc.tail(f, 3)
    expect(t).toBe("line 48\nline 49\ndone")
    expect(Svc.tail(path.join(TMP, "none.log"))).toBe("")
  })

  test("the badge: numbers only, after a title", () => {
    expect(Svc.badge([{ listening: [4101, 4100], ports: [] }, { listening: [], ports: [4100] }])).toBe(":4100 :4101")
    expect(TH.withBadge("auth", ":4100")).toBe("auth · :4100")
    expect(TH.withBadge("auth", ":41\x1b]0;x\x07")).not.toMatch(/[\u0000-\u001f]/)
    expect(TH.withBadge(undefined, ":4100")).toBeUndefined()
  })

  test("without tmux: a detached process with its log, reused not doubled, told at SessionStart, stopped", async () => {
    const repo = path.join(TMP, "repo")
    fs.mkdirSync(repo, { recursive: true })
    spawnSync("git", ["init", "-q", repo])
    const r = Svc.serve({ command: `echo hello $PORT; exec sleep 30`, name: "sleepy", cwd: repo, env: { ...process.env, CROSSTALK_SERVICES_NO_TMUX: "1", CROSSTALK_SERVE_WAIT_MS: "300", GITHUB_TOKEN: "secret" } })
    expect(r.ok).toBe(true)
    expect(r.text).toContain("as a detached process")
    const s = Svc.readAll().find((x) => x.name === "sleepy")!
    kids.push(s.pid!)
    expect(s.backend).toBe("process")
    await new Promise((x) => setTimeout(x, 200))
    expect(Svc.tail(s.log)).toContain(`hello ${s.port}`)
    expect(Svc.describe({ cwd: repo }).text).toContain("sleepy")
    const again = Svc.serve({ command: "sleep 30", name: "sleepy", cwd: repo, env: { ...process.env, CROSSTALK_SERVICES_NO_TMUX: "1" } })
    expect(again.text).toContain("already running")
    // The SessionStart brief names it, and the worktree's ports.
    const b = Svc.brief(repo)
    expect(b.systemMessage).toContain("still running in this worktree: sleepy")
    expect(b.context).toContain(`ports are ${s.base}-${s.base + 9}`)
    expect(b.context).toContain("sleepy")
    // The session manager sees it (src/sessions/services.ts setServices): closing a session there names it.
    const SS = await import("../src/sessions/services.ts")
    expect(SS.runningFor({ sessionId: "nobody", cwd: path.join(repo) }).map((x) => [x.name, x.pid])).toEqual([["sleepy", s.pid]])
    expect(SS.keepsLine(SS.runningFor({ sessionId: "nobody", cwd: repo }), false)).toBe(" Its sleepy keeps running.")
    expect(Svc.stop({ name: "sleepy", cwd: repo }).text).toContain("stopped sleepy")
    expect(Svc.aliveProc(s.pid!)).toBe(false)
    expect(Svc.brief(repo).systemMessage).toBeUndefined()
  }, 20_000)
})
