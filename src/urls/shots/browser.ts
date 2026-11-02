// A headless browser to take a screenshot with, whichever this machine has.
//
//   1. Playwright as a library, when `require("playwright")` resolves: from
//      the worktree (its own node_modules), else from crosstalk's own
//      location and NODE_PATH. Its own Chromium, else the installed Chrome
//      (channel "chrome").
//   2. The worktree's Playwright command line, node_modules/.bin/playwright:
//      what `npx playwright` runs without installing anything.
//   3. An installed Chrome, Chromium, Edge or Brave, with
//      `--headless=new --screenshot`.
//
// None: no capture, and the answer says how to get one. Nothing is installed
// or downloaded here. CROSSTALK_SHOTS_ENGINE=playwright|cli|chrome|none picks
// one; CROSSTALK_SHOTS_BROWSER names a browser binary.

import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { spawn } from "node:child_process"
import { createRequire } from "node:module"

export type Engine = { kind: "playwright"; module: string } | { kind: "playwright-cli"; bin: string } | { kind: "chrome"; bin: string }

export const WIDTH = 1280
export const HEIGHT = 800

const MAC_BROWSERS = [
  "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
  "/Applications/Chromium.app/Contents/MacOS/Chromium",
  "/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge",
  "/Applications/Brave Browser.app/Contents/MacOS/Brave Browser",
]
const PATH_BROWSERS = ["google-chrome", "google-chrome-stable", "chromium", "chromium-browser", "microsoft-edge", "microsoft-edge-stable", "brave-browser"]

const executable = (p: string) => {
  try {
    fs.accessSync(p, fs.constants.X_OK)
    return fs.statSync(p).isFile()
  } catch {
    return false
  }
}

/** A Chrome-like browser's binary, if one is installed. */
export function findBrowser(env: NodeJS.ProcessEnv = process.env, platform: NodeJS.Platform = process.platform): string | undefined {
  if (env.CROSSTALK_SHOTS_BROWSER) return executable(env.CROSSTALK_SHOTS_BROWSER) ? env.CROSSTALK_SHOTS_BROWSER : undefined
  if (platform === "darwin") for (const p of MAC_BROWSERS) if (executable(p)) return p
  for (const d of (env.PATH ?? "").split(path.delimiter))
    for (const n of PATH_BROWSERS) if (d && executable(path.join(d, n))) return path.join(d, n)
  return undefined
}

/** Where `require("playwright")` resolves, looking from the worktree first. */
export function findPlaywright(root?: string): string | undefined {
  const name = "playwright"
  const bases = [root ? path.join(root, "package.json") : undefined, import.meta.url, path.join(process.cwd(), "package.json")].filter(Boolean) as string[]
  for (const b of bases)
    try {
      return createRequire(b).resolve(name)
    } catch {}
  return undefined
}

/** Every engine this machine has, best first. */
export function engines(o: { root?: string; env?: NodeJS.ProcessEnv } = {}): Engine[] {
  const env = o.env ?? process.env
  const only = env.CROSSTALK_SHOTS_ENGINE
  if (only === "none") return []
  const out: Engine[] = []
  if (!only || only === "playwright") {
    const m = findPlaywright(o.root)
    if (m) out.push({ kind: "playwright", module: m })
  }
  if (!only || only === "cli") {
    const bin = o.root ? path.join(o.root, "node_modules", ".bin", "playwright") : ""
    if (bin && executable(bin)) out.push({ kind: "playwright-cli", bin })
  }
  if (!only || only === "chrome") {
    const b = findBrowser(env)
    if (b) out.push({ kind: "chrome", bin: b })
  }
  return out
}

export const NO_ENGINE =
  "no headless browser here: crosstalk looked for Playwright (require('playwright'), or node_modules/.bin/playwright, which npx playwright runs), and for Chrome, Chromium, Edge or Brave. Install one (npm i -D playwright && npx playwright install chromium) and screenshots start by themselves."

export type Captured = { ok: true; engine: string; bytes: number } | { ok: false; error: string }

const run = (cmd: string, args: string[], ms: number) =>
  new Promise<{ code: number | null; out: string }>((resolve) => {
    let out = ""
    let done = false
    const c = spawn(cmd, args, { stdio: ["ignore", "pipe", "pipe"], env: { ...process.env, PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD: "1" } })
    const t = setTimeout(() => {
      try {
        c.kill("SIGKILL")
      } catch {}
    }, ms)
    const fin = (code: number | null) => {
      if (done) return
      done = true
      clearTimeout(t)
      resolve({ code, out: out.slice(-2000) })
    }
    c.stdout?.on("data", (d) => (out += d))
    c.stderr?.on("data", (d) => (out += d))
    c.on("error", (e) => ((out += String(e)), fin(-1)))
    c.on("close", (code) => fin(code))
  })

const sizeOf = (file: string) => {
  try {
    return fs.statSync(file).size
  } catch {
    return 0
  }
}

/** A PNG starts with these eight bytes. */
export function isPng(file: string): boolean {
  try {
    const fd = fs.openSync(file, "r")
    const b = Buffer.alloc(8)
    fs.readSync(fd, b, 0, 8, 0)
    fs.closeSync(fd)
    return b.equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))
  } catch {
    return false
  }
}

async function withPlaywright(e: Extract<Engine, { kind: "playwright" }>, url: string, file: string, ms: number): Promise<Captured> {
  const req = createRequire(e.module)
  const pw = req(e.module)
  const chromium = pw.chromium ?? pw.default?.chromium
  if (!chromium) return { ok: false, error: "playwright has no chromium" }
  let browser: any
  let last = ""
  for (const opts of [{}, { channel: "chrome" }]) {
    try {
      browser = await chromium.launch({ headless: true, timeout: ms, ...opts })
      break
    } catch (err) {
      last = String((err as Error).message ?? err).split("\n")[0]
    }
  }
  if (!browser) return { ok: false, error: `playwright could not start a browser: ${last}` }
  try {
    const page = await browser.newPage({ viewport: { width: WIDTH, height: HEIGHT } })
    // "load", not "networkidle": a dev server's HMR socket never goes idle.
    await page.goto(url, { waitUntil: "load", timeout: ms })
    await page.waitForTimeout(Number(process.env.CROSSTALK_SHOTS_PAINT_MS ?? 400))
    await page.screenshot({ path: file, fullPage: false })
    return { ok: true, engine: "playwright", bytes: sizeOf(file) }
  } catch (err) {
    return { ok: false, error: `playwright: ${String((err as Error).message ?? err).split("\n")[0]}` }
  } finally {
    try {
      await browser.close()
    } catch {}
  }
}

/**
 * An installed Chrome, driven over the DevTools protocol on a pipe
 * (`--remote-debugging-pipe`: fd 3 in, fd 4 out, NUL between messages) rather
 * than `--screenshot`, which recent Chrome builds can hang on. No port is
 * opened. Its own throwaway profile, removed after.
 */
async function withChrome(bin: string, url: string, file: string, ms: number): Promise<Captured> {
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), "ct-shot-"))
  const args = [
    "--headless=new",
    "--remote-debugging-pipe",
    "--disable-gpu",
    "--hide-scrollbars",
    "--no-first-run",
    "--no-default-browser-check",
    "--disable-extensions",
    "--disable-background-networking",
    "--disable-sync",
    "--mute-audio",
    `--user-data-dir=${profile}`,
    `--window-size=${WIDTH},${HEIGHT}`,
    // Chrome refuses to run as root with its sandbox.
    ...(process.getuid?.() === 0 ? ["--no-sandbox"] : []),
    "about:blank",
  ]
  const c = spawn(bin, args, { stdio: ["ignore", "ignore", "pipe", "pipe", "pipe"] })
  let err = ""
  c.stderr?.on("data", (d) => (err = (err + d).slice(-2000)))
  const input = c.stdio[3] as NodeJS.WritableStream
  const output = c.stdio[4] as NodeJS.ReadableStream
  let buf = ""
  let seq = 0
  const waiting = new Map<number, (m: any) => void>()
  const events: ((m: any) => void)[] = []
  output.on("data", (d: Buffer) => {
    buf += d.toString("utf8")
    let i
    while ((i = buf.indexOf("\0")) !== -1) {
      const raw = buf.slice(0, i)
      buf = buf.slice(i + 1)
      try {
        const m = JSON.parse(raw)
        if (m.id !== undefined && waiting.has(m.id)) {
          waiting.get(m.id)!(m)
          waiting.delete(m.id)
        } else for (const f of events) f(m)
      } catch {}
    }
  })
  let exited = false
  c.on("exit", () => {
    exited = true
    for (const f of waiting.values()) f({ error: { message: "the browser exited" } })
  })
  c.on("error", (e) => ((err += String(e)), (exited = true)))
  const send = (method: string, params: Record<string, unknown> = {}, sessionId?: string) =>
    new Promise<any>((resolve, reject) => {
      if (exited) return reject(new Error("the browser exited"))
      const id = ++seq
      const t = setTimeout(() => (waiting.delete(id), reject(new Error(`${method} timed out`))), ms)
      waiting.set(id, (m) => (clearTimeout(t), m.error ? reject(new Error(m.error.message)) : resolve(m.result)))
      input.write(JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) }) + "\0")
    })
  try {
    const { targetId } = await send("Target.createTarget", { url: "about:blank" })
    const { sessionId } = await send("Target.attachToTarget", { targetId, flatten: true })
    await send("Page.enable", {}, sessionId)
    await send("Emulation.setDeviceMetricsOverride", { width: WIDTH, height: HEIGHT, deviceScaleFactor: 1, mobile: false }, sessionId)
    const loaded = new Promise<void>((resolve) => {
      const t = setTimeout(resolve, ms)
      events.push((m) => m.sessionId === sessionId && m.method === "Page.loadEventFired" && (clearTimeout(t), resolve()))
    })
    const nav = await send("Page.navigate", { url }, sessionId)
    if (nav?.errorText) return { ok: false, error: `chrome: ${nav.errorText}` }
    await loaded
    await new Promise((r) => setTimeout(r, Number(process.env.CROSSTALK_SHOTS_PAINT_MS ?? 400)))
    const shot = await send("Page.captureScreenshot", { format: "png" }, sessionId)
    fs.writeFileSync(file, Buffer.from(String(shot?.data ?? ""), "base64"), { mode: 0o600 })
    return isPng(file) ? { ok: true, engine: "chrome", bytes: sizeOf(file) } : { ok: false, error: "chrome: no PNG came back" }
  } catch (e) {
    return { ok: false, error: `${path.basename(bin)}: ${(e as Error).message}${err ? ` (${err.trim().split("\n").pop()})` : ""}` }
  } finally {
    try {
      if (!exited) input.write(JSON.stringify({ id: ++seq, method: "Browser.close" }) + "\0")
    } catch {}
    await new Promise<void>((r) => {
      if (exited) return r()
      const t = setTimeout(() => {
        try {
          c.kill("SIGKILL")
        } catch {}
        r()
      }, 3000)
      c.on("exit", () => (clearTimeout(t), r()))
    })
    fs.rmSync(profile, { recursive: true, force: true })
  }
}

/** One screenshot of `url` into `file`, with the first engine that manages it. */
export async function capture(url: string, file: string, o: { root?: string; engines?: Engine[]; timeoutMs?: number } = {}): Promise<Captured> {
  if (!/^https?:\/\/[^\s\u0000-\u001f]+$/.test(url)) return { ok: false, error: "only an http(s) address can be captured" }
  const list = o.engines ?? engines({ root: o.root })
  if (!list.length) return { ok: false, error: NO_ENGINE }
  const ms = o.timeoutMs ?? Number(process.env.CROSSTALK_SHOTS_TIMEOUT_MS ?? 20_000)
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 })
  const errors: string[] = []
  for (const e of list) {
    try {
      fs.unlinkSync(file)
    } catch {}
    let r: Captured
    if (e.kind === "playwright") r = await withPlaywright(e, url, file, ms)
    else if (e.kind === "playwright-cli") {
      const x = await run(e.bin, ["screenshot", `--viewport-size=${WIDTH},${HEIGHT}`, "--wait-for-timeout=400", url, file], ms + 5000)
      r = x.code === 0 && isPng(file) ? { ok: true, engine: "playwright-cli", bytes: sizeOf(file) } : { ok: false, error: `playwright screenshot: ${x.out.trim().split("\n").pop() ?? x.code}` }
    } else r = await withChrome(e.bin, url, file, ms)
    if (r.ok && isPng(file)) return r
    errors.push(r.ok ? `${e.kind}: no PNG` : r.error)
  }
  return { ok: false, error: errors.join("; ").slice(0, 600) }
}
