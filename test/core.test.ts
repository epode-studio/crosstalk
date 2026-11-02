// Core correctness: the client's socket, the ui store's lock, the session
// registry under CLAUDE_CONFIG_DIR, and what the hook asks the daemon.
//
//   bun test test/core.test.ts
//
// Nothing here starts a real daemon. A stand-in answers on the control socket
// in a temp CROSSTALK_HOME, so every test controls exactly what comes back.
// The daemon's own side (route, replay, adoption) runs in test/core.sh.

import { afterAll, describe, expect, test } from "bun:test"
import fs from "node:fs"
import net from "node:net"
import os from "node:os"
import path from "node:path"

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), "ct-core-"))
const HOME = path.join(TMP, "ct")
const FAKE_HOME = path.join(TMP, "home")
fs.mkdirSync(HOME, { recursive: true })
fs.mkdirSync(FAKE_HOME, { recursive: true })
process.env.CROSSTALK_HOME = HOME
process.env.HOME = FAKE_HOME
process.env.CROSSTALK_THREADS_NO_PUSH = "1"
delete process.env.CLAUDE_CONFIG_DIR

const ROOT = path.join(import.meta.dir, "..")
const { P, saveIdentity } = await import("../src/config.ts")
const { newIdentity } = await import("../src/crypto.ts")
const client = await import("../src/client.ts")
const U = await import("../src/uistate.ts")
const registry = await import("../src/registry.ts")

afterAll(() => {
  stopFake()
  fs.rmSync(TMP, { recursive: true, force: true })
})

// --- a stand-in daemon ---------------------------------------------------------------

type Handler = (req: any, sock: net.Socket) => unknown | undefined
let server: net.Server | null = null
let seen: any[] = []

async function fake(h: Handler): Promise<void> {
  stopFake()
  seen = []
  try {
    fs.rmSync(P.daemonSock, { force: true })
  } catch {}
  server = net.createServer((sock) => {
    let rest = ""
    sock.on("data", (b) => {
      rest += b.toString("utf8")
      let i: number
      while ((i = rest.indexOf("\n")) !== -1) {
        const req = JSON.parse(rest.slice(0, i))
        rest = rest.slice(i + 1)
        seen.push(req)
        const r = h(req, sock)
        if (r !== undefined) sock.write(JSON.stringify(r) + "\n")
      }
    })
    sock.on("error", () => {})
  })
  await new Promise<void>((r) => server!.listen(P.daemonSock, r))
  fs.writeFileSync(P.daemonLock, String(process.pid))
}

function stopFake() {
  server?.close()
  server = null
  try {
    fs.rmSync(P.daemonSock, { force: true })
    fs.rmSync(P.daemonLock, { force: true })
  } catch {}
}

/** The real hook, as Claude Code runs it, against the stand-in. Async, so the stand-in can answer. */
async function runHook(input: unknown, env: Record<string, string> = {}): Promise<{ out: string; ms: number; code: number }> {
  const t0 = Date.now()
  const p = Bun.spawn(["bun", path.join(ROOT, "src/hook.ts")], {
    cwd: ROOT,
    stdin: new Blob([JSON.stringify(input)]),
    stdout: "pipe",
    stderr: "pipe",
    env: {
      PATH: process.env.PATH ?? "",
      HOME: FAKE_HOME,
      CROSSTALK_HOME: HOME,
      CROSSTALK_THREADS_NO_PUSH: "1",
      CROSSTALK_NO_RESTORE: "1",
      CROSSTALK_NO_GATHER: "1",
      CROSSTALK_NO_DOCTOR: "1",
      CROSSTALK_NO_ATTENTION: "1",
      CROSSTALK_NO_TERM: "1",
      CROSSTALK_NO_REPOTRUST: "1",
      ...env,
    },
  })
  const out = await new Response(p.stdout).text()
  const code = await p.exited
  return { out, ms: Date.now() - t0, code }
}

// --- 1. the mod's poll keeps push and main ---------------------------------------------

describe("ui waiting()", () => {
  test("passes the daemon's push and main through to the mod", async () => {
    await fake((req) =>
      req.op === "ui"
        ? { ok: true, items: [], label: "ana", threads: ["auth"], main: { sessions: 3, waiting: 1 }, push: { id: "p1", text: "1 question in auth" } }
        : { ok: true },
    )
    const { waiting } = await import("../src/uicli.ts")
    const w: any = await waiting("s1", true)
    expect(w.daemon).toBe(true)
    expect(w.push).toEqual({ id: "p1", text: "1 question in auth" })
    expect(w.main).toEqual({ sessions: 3, waiting: 1 })
    stopFake()
  })
})

// --- 3. CLAUDE_CONFIG_DIR ---------------------------------------------------------------

describe("the session registry", () => {
  test("is read from CLAUDE_CONFIG_DIR when it is set", () => {
    const cfg = path.join(TMP, "claude-config")
    fs.mkdirSync(path.join(cfg, "sessions"), { recursive: true })
    const sock = path.join(TMP, "inbox.sock")
    fs.writeFileSync(sock, "")
    fs.writeFileSync(
      path.join(cfg, "sessions", `${process.pid}.json`),
      JSON.stringify({ pid: process.pid, sessionId: "cfg-session", name: "cfg", cwd: TMP, messagingSocketPath: sock, updatedAt: 1 }),
    )
    process.env.CLAUDE_CONFIG_DIR = cfg
    try {
      expect(registry.sessionsDir()).toBe(path.join(cfg, "sessions"))
      expect(registry.listLocalSessions().map((s) => s.sessionId)).toEqual(["cfg-session"])
    } finally {
      delete process.env.CLAUDE_CONFIG_DIR
    }
    expect(registry.sessionsDir()).toBe(path.join(os.homedir(), ".claude", "sessions"))
    expect(registry.listLocalSessions().map((s) => s.sessionId)).not.toContain("cfg-session")
  })
})

// --- 7, 15. the client ---------------------------------------------------------------------

describe("the client", () => {
  test("a daemon that closes without answering is an error at once, not after the timeout", async () => {
    await fake((_req, sock) => void sock.end())
    const t0 = Date.now()
    const err = await client.request({ op: "anything" }, 20_000).then(() => null, (e) => e as Error)
    expect(err).toBeInstanceOf(Error)
    expect(Date.now() - t0).toBeLessThan(2000)
    stopFake()
  })

  test("a daemon destroyed mid-request is an error at once", async () => {
    await fake((_req, sock) => void sock.destroy())
    const t0 = Date.now()
    const err = await client.request({ op: "anything" }, 20_000).then(() => null, (e) => e as Error)
    expect(err).toBeInstanceOf(Error)
    expect(Date.now() - t0).toBeLessThan(2000)
    stopFake()
  })

  test("ensureDaemon with no runnable shim says no instead of throwing", async () => {
    stopFake()
    const nowhere = path.join(TMP, "no-plugin-here")
    fs.mkdirSync(nowhere, { recursive: true })
    const errors: unknown[] = []
    const onErr = (e: unknown) => errors.push(e)
    process.on("uncaughtException", onErr)
    try {
      expect(await client.ensureDaemon(nowhere)).toBe(false)
      await new Promise((r) => setTimeout(r, 200))
    } finally {
      process.off("uncaughtException", onErr)
    }
    expect(errors).toEqual([])
  })
})

// --- 7. the hook's register timeout --------------------------------------------------------

saveIdentity({ ...newIdentity("ana"), machine: "desk" })

describe("the hook", () => {
  test("a daemon that never answers register costs seconds, well inside Claude Code's 60s", async () => {
    await fake((req) => (req.op === "register" ? undefined : { ok: true }))
    const r = await runHook({ hook_event_name: "UserPromptSubmit", session_id: "s-reg", cwd: TMP, prompt: "hi" })
    expect(seen.some((q) => q.op === "register")).toBe(true)
    expect(r.ms).toBeLessThan(15_000)
    expect(() => JSON.parse(r.out)).not.toThrow()
    expect(JSON.parse(r.out).continue).toBe(true)
    stopFake()
  }, 30_000)

  // --- 12. an edit report only when another thread shares the file -------------------------
  const repo = path.join(TMP, "repo")
  fs.mkdirSync(repo, { recursive: true })
  Bun.spawnSync(["git", "init", "-q", "-b", "main", repo])
  fs.writeFileSync(path.join(repo, "a.ts"), "export const a = 1\n")
  Bun.spawnSync(["git", "-C", repo, "-c", "user.email=t@t", "-c", "user.name=t", "add", "."])
  Bun.spawnSync(["git", "-C", repo, "-c", "user.email=t@t", "-c", "user.name=t", "commit", "-qm", "init"])
  const edit = { hook_event_name: "PostToolUse", session_id: "s-edit", cwd: repo, tool_name: "Edit", tool_input: { file_path: path.join(repo, "a.ts"), old_string: "1", new_string: "2" } }

  test("an edit to a file nobody else shares sends no edit report", async () => {
    fs.writeFileSync(path.join(repo, "a.ts"), "export const a = 2\n")
    await fake((req) => (req.op === "edit_shared" ? { ok: true, shared: false } : { ok: true }))
    const r = await runHook(edit)
    expect(JSON.parse(r.out).continue).toBe(true)
    const asked = seen.find((q) => q.op === "edit_shared")
    expect(asked?.path).toBe(path.join(repo, "a.ts"))
    expect(seen.some((q) => q.op === "edited")).toBe(false)
    stopFake()
  }, 30_000)

  test("an edit to a shared file sends the report", async () => {
    await fake((req) => (req.op === "edit_shared" ? { ok: true, shared: true } : { ok: true }))
    await runHook(edit)
    const sent = seen.find((q) => q.op === "edited")
    expect(sent?.edit?.file).toBe("a.ts")
    expect(sent?.edit?.diff).toContain("+export const a = 2")
    stopFake()
  }, 30_000)
})

// --- 11. the ui store's lock --------------------------------------------------------------------

describe("the ui store's lock", () => {
  const lock = path.join(HOME, "ui.lock")
  const deadPid = (() => {
    const p = Bun.spawnSync(["sh", "-c", "echo $$"])
    return Number(p.stdout.toString().trim())
  })()

  test("records its holder's pid while held", () => {
    const pid = U.withStore(() => Number(fs.readFileSync(path.join(lock, "pid"), "utf8")))
    expect(pid).toBe(process.pid)
    expect(fs.existsSync(lock)).toBe(false)
  })

  test("a lock left by a dead process is broken at once", () => {
    fs.mkdirSync(lock)
    fs.writeFileSync(path.join(lock, "pid"), String(deadPid))
    const t0 = Date.now()
    U.withStore((items, now) => U.upsert(items, { id: "msg:dead", kind: "message", sessionId: "s1", text: "x" }, now))
    expect(Date.now() - t0).toBeLessThan(500)
    expect(U.snapshot()["msg:dead"]?.state).toBe("pending")
    expect(fs.existsSync(lock)).toBe(false)
  })

  test("a lock held by a live process is not written through: it fails instead", () => {
    const holder = Bun.spawn(["sleep", "30"])
    fs.mkdirSync(lock)
    fs.writeFileSync(path.join(lock, "pid"), String(holder.pid))
    U.setLockWait(100)
    try {
      let ran = false
      const t0 = Date.now()
      expect(() => U.withStore(() => (ran = true))).toThrow(U.StoreBusy)
      expect(ran).toBe(false)
      // A short wait for the daemon, whose event loop it blocks.
      expect(Date.now() - t0).toBeLessThan(600)
      // And the holder's lock is still there.
      expect(Number(fs.readFileSync(path.join(lock, "pid"), "utf8"))).toBe(holder.pid)
    } finally {
      U.setLockWait(2000)
      holder.kill()
      fs.rmSync(lock, { recursive: true, force: true })
    }
  })

  test("a nested call runs inside the outer lock instead of waiting on itself", () => {
    const t0 = Date.now()
    U.withStore(() => U.withStore(() => 1))
    expect(Date.now() - t0).toBeLessThan(500)
  })
})
