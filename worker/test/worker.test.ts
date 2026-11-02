// The hosted relay's stream frames, inside a real local Worker (wrangler dev,
// workerd, nothing deployed and nothing reached over the network):
//
//   bun run test:worker            (wrangler on PATH or in worker/node_modules)
//   WRANGLER=/path/to/wrangler bun test worker/test/worker.test.ts
//
// With the allowance made small through wrangler vars:
//
//   live        a stream frame reaches a connected recipient as `deliver`, is
//               not acked, and leaves nothing in either mailbox's storage
//   offline     a frame for someone not connected is dropped and never held;
//               the sender is told once
//   burst       over the window's frames: refused, one `stream_burst` frame
//   day         over the sender's day: one `stream_paused` frame, and still
//               refused after reconnecting (the count went to storage then)
//   pool        over everyone's day: `stream_paused` with scope "relay"
//   send        an ordinary send still delivers and acks after all of that

import { afterAll, beforeAll, describe, expect, test } from "bun:test"
import { spawn, spawnSync, type ChildProcess } from "node:child_process"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"

const DIR = path.resolve(import.meta.dir, "..")
const PORT = Number(process.env.WORKER_TEST_PORT ?? 8797)
const BASE = `http://127.0.0.1:${PORT}`

function findWrangler(): string | null {
  const cands = [process.env.WRANGLER, path.join(DIR, "node_modules/.bin/wrangler"), path.join(DIR, "../node_modules/.bin/wrangler")]
  for (const c of cands) if (c && fs.existsSync(c)) return c
  const w = spawnSync("sh", ["-c", "command -v wrangler"], { encoding: "utf8" })
  return w.status === 0 && w.stdout.trim() ? w.stdout.trim() : null
}

const WRANGLER = findWrangler()
let proc: ChildProcess | null = null
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "ct-worker-"))
let logText = ""

const VARS = {
  TEST_HOOKS: "1",
  STREAM_BURST_FRAMES: "8",
  STREAM_BURST_MS: "1500",
  STREAM_DAY_FRAMES: "20",
  STREAM_POOL_FRAMES: "45",
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

type Conn = { ws: WebSocket; frames: any[]; fp: string; close: () => Promise<void> }

async function connect(fp: string): Promise<Conn> {
  const ws = new WebSocket(`ws://127.0.0.1:${PORT}/ws?fp=${fp}`)
  const frames: any[] = []
  ws.onmessage = (e) => frames.push(JSON.parse(String(e.data)))
  await new Promise<void>((res, rej) => {
    ws.onopen = () => res()
    ws.onerror = () => rej(new Error("no websocket"))
  })
  await until(() => frames.some((f) => f.t === "ready"))
  return {
    ws,
    frames,
    fp,
    close: async () => {
      ws.close()
      await sleep(300)
    },
  }
}

async function until(ok: () => boolean, ms = 5000) {
  const end = Date.now() + ms
  while (!ok() && Date.now() < end) await sleep(25)
  return ok()
}

const keys = async (fp: string) => ((await (await fetch(`${BASE}/__test/keys?fp=${fp}`)).json()) as { keys: string[] }).keys
const pool = async () => (await (await fetch(`${BASE}/__test/keys?pool=1`)).json()) as { keys: string[]; pool?: { used: number } }
const stream = (c: Conn, to: string, n: number, tag: string) => {
  for (let i = 0; i < n; i++) c.ws.send(JSON.stringify({ t: "stream", to, id: `${tag}-${i}`, body: `${tag} ${i}` }))
}
const delivered = (c: Conn, tag: string) => c.frames.filter((f) => f.t === "deliver" && String(f.body).startsWith(tag + " "))
const errors = (c: Conn, code: string) => c.frames.filter((f) => f.t === "error" && f.code === code)

describe.skipIf(!WRANGLER)("the Worker's stream frames (wrangler dev, local)", () => {
  beforeAll(async () => {
    const args = ["dev", "--local", "--ip", "127.0.0.1", "--port", String(PORT), "--persist-to", tmp, "--show-interactive-dev-session=false"]
    for (const [k, v] of Object.entries(VARS)) args.push("--var", `${k}:${v}`)
    proc = spawn(WRANGLER!, args, { cwd: DIR, env: { ...process.env, WRANGLER_SEND_METRICS: "false", CI: "1" }, stdio: ["ignore", "pipe", "pipe"] })
    proc.stdout!.on("data", (d) => (logText += d))
    proc.stderr!.on("data", (d) => (logText += d))
    const end = Date.now() + 60_000
    while (Date.now() < end) {
      try {
        if ((await fetch(`${BASE}/health`)).ok) return
      } catch {}
      await sleep(300)
    }
    throw new Error(`wrangler dev did not come up:\n${logText.slice(-3000)}`)
  }, 70_000)

  afterAll(async () => {
    proc?.kill("SIGTERM")
    await sleep(500)
    proc?.kill("SIGKILL")
    fs.rmSync(tmp, { recursive: true, force: true })
  })

  const A = "aaaa0001"
  const B = "bbbb0002"
  const C = "cccc0003"
  const D = "dddd0004"
  const E = "eeee0005"

  test("ready advertises streams and the allowance", async () => {
    const a = await connect(A)
    const r = a.frames.find((f) => f.t === "ready")
    expect(r.streams).toBe(1)
    expect(r.fingerprint).toBe(A)
    expect(r.streamAllowance).toEqual({ day: { frames: 20, bytes: 256 * 1024 * 1024 }, burst: { frames: 8, bytes: 48 * 1024 * 1024, ms: 1500 }, pool: { frames: 45 } })
    await a.close()
  })

  test("live to a connected recipient, unacked, nothing in storage; offline dropped and told once", async () => {
    const a = await connect(A)
    const b = await connect(B)
    stream(a, B, 3, "live")
    expect(await until(() => delivered(b, "live").length === 3)).toBe(true)
    expect(delivered(b, "live").map((f) => f.body)).toEqual(["live 0", "live 1", "live 2"])
    expect(delivered(b, "live")[0].from).toBe(A)
    expect(delivered(b, "live")[0].id).toBe("live-0")
    await sleep(200)
    expect(a.frames.filter((f) => f.t === "ack")).toEqual([])
    expect(await keys(A)).toEqual([])
    expect(await keys(B)).toEqual([])

    // C is not connected.
    stream(a, C, 2, "gone")
    expect(await until(() => errors(a, "stream_offline").length > 0)).toBe(true)
    await sleep(300)
    stream(a, C, 2, "gone2")
    await sleep(300)
    expect(errors(a, "stream_offline").length).toBe(1)
    expect(errors(a, "stream_offline")[0].to).toBe(C)
    expect(await keys(C)).toEqual([])
    const c = await connect(C)
    await sleep(300)
    expect(c.frames.filter((f) => f.t === "deliver")).toEqual([])
    await c.close()
    await sleep(1600) // a fresh burst window
    await a.close()
    await b.close()
  })

  test("burst, then the sender's day, then still paused after a reconnect; ordinary sends unaffected", async () => {
    const a = await connect(D)
    const b = await connect(B)
    // A fresh sender: nothing counted yet today. 8 a window.
    stream(a, B, 12, "burst")
    expect(await until(() => errors(a, "stream_burst").length > 0)).toBe(true)
    await sleep(300)
    expect(delivered(b, "burst").length).toBe(8)
    expect(errors(a, "stream_burst").length).toBe(1)
    expect(errors(a, "stream_burst")[0].message).toContain("dropped")

    // To the day's 20: 8 so far, so 12 more go and then it is paused.
    await sleep(1600)
    stream(a, B, 5, "day1")
    await sleep(1600)
    stream(a, B, 8, "day2")
    expect(await until(() => errors(a, "stream_paused").length > 0)).toBe(true)
    await sleep(300)
    expect(delivered(b, "day1").length + delivered(b, "day2").length).toBe(12)
    const p = errors(a, "stream_paused")
    expect(p.length).toBe(1)
    expect(p[0].scope).toBe("sender")
    expect(p[0].message).toContain("paused until tomorrow")
    expect(p[0].message).toContain("--host")
    expect(p[0].until).toBe((Math.floor(Date.now() / 86_400_000) + 1) * 86_400_000)
    await sleep(1600)
    stream(a, B, 3, "after")
    await sleep(400)
    expect(delivered(b, "after").length).toBe(0)
    expect(errors(a, "stream_paused").length).toBe(1)
    // The one coarse write: the day's count, when it was spent. No stream frame is in storage.
    expect(await keys(D)).toEqual(["stream"])
    expect(await keys(B)).toEqual([])

    // Ordinary sends: delivered and acked, as ever.
    a.ws.send(JSON.stringify({ t: "send", to: B, id: "plain-1", body: "plain hello" }))
    expect(await until(() => a.frames.some((f) => f.t === "ack" && f.id === "plain-1"))).toBe(true)
    expect(await until(() => b.frames.some((f) => f.t === "deliver" && f.body === "plain hello"))).toBe(true)

    // Reconnecting does not reset the day.
    await a.close()
    const a2 = await connect(D)
    stream(a2, B, 2, "again")
    expect(await until(() => errors(a2, "stream_paused").length > 0)).toBe(true)
    expect(delivered(b, "again").length).toBe(0)
    await a2.close()
    await b.close()
  }, 30_000)

  test("everyone's pool: a second sender gets what is left, then scope relay", async () => {
    // A and D reserved their days (20 each of 45): E gets the 5 left, then nothing.
    const before = await pool()
    const e = await connect(E)
    const b = await connect(B)
    stream(e, B, 8, "pool")
    expect(await until(() => errors(e, "stream_paused").length > 0)).toBe(true)
    await sleep(300)
    const left = 45 - (before.pool?.used ?? 0)
    expect(left).toBe(5)
    expect(delivered(b, "pool").length).toBe(5)
    expect(errors(e, "stream_paused")[0].scope).toBe("relay")
    expect((await pool()).pool?.used).toBe(45)
    // Ordinary sends from E still work.
    e.ws.send(JSON.stringify({ t: "send", to: B, id: "plain-2", body: "still here" }))
    expect(await until(() => e.frames.some((f) => f.t === "ack" && f.id === "plain-2"))).toBe(true)
    await e.close()
    await b.close()
  }, 15_000)
})

if (!WRANGLER) test("wrangler is not installed: the Worker integration test did not run", () => console.warn("SKIPPED: set WRANGLER=/path/to/wrangler or install it in worker/"))
