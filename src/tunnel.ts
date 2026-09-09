// A throwaway public address for the relay, so two people on different networks
// can start a room without either of them running a server.
//
// cloudflared's quick tunnels need no account and no domain, and the URL they
// hand back is itself four hyphenated words, which is how an invite already
// reads. What you give up: the URL is different every time, so it is the relay
// for this session only, and Cloudflare carries the ciphertext. For anything
// lasting, run a relay yourself: see deploy/.
//
// If cloudflared is not installed, it is one static binary and crosstalk fetches
// it into ~/.claude/crosstalk/bin rather than asking anyone to install a package
// manager first.

import { spawn, execFileSync } from "node:child_process"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { ROOT } from "./config.ts"

export type Tunnel = { url: string; host: string; subdomain: string; pid: number }

const BIN_DIR = path.join(ROOT, "bin")
const LOCAL_BIN = path.join(BIN_DIR, "cloudflared")

function onPath(): string | null {
  for (const candidate of [LOCAL_BIN, "cloudflared"]) {
    try {
      execFileSync(candidate, ["--version"], { stdio: "ignore", timeout: 4000 })
      return candidate
    } catch {}
  }
  return null
}

/** The release asset for this machine, or null if we do not know one. */
function assetName(): string | null {
  const arch = os.arch() === "arm64" ? "arm64" : os.arch() === "x64" ? "amd64" : null
  if (!arch) return null
  if (process.platform === "darwin") return `cloudflared-darwin-${arch}.tgz`
  if (process.platform === "linux") return `cloudflared-linux-${arch}`
  return null
}

export const tunnelBinary = () => onPath()

/** Fetches the single static binary if it is not already here. */
export async function ensureCloudflared(
  onProgress?: (note: string) => void,
): Promise<string | null> {
  const existing = onPath()
  if (existing) return existing

  const asset = assetName()
  if (!asset) return null

  const url = `https://github.com/cloudflare/cloudflared/releases/latest/download/${asset}`
  onProgress?.(`fetching cloudflared for ${process.platform} ${os.arch()}`)
  fs.mkdirSync(BIN_DIR, { recursive: true, mode: 0o700 })

  const res = await fetch(url, { redirect: "follow" })
  if (!res.ok) return null
  const bytes = Buffer.from(await res.arrayBuffer())

  if (asset.endsWith(".tgz")) {
    const tmp = path.join(BIN_DIR, "cloudflared.tgz")
    fs.writeFileSync(tmp, bytes)
    execFileSync("tar", ["-xzf", tmp, "-C", BIN_DIR], { timeout: 60_000 })
    fs.rmSync(tmp, { force: true })
  } else {
    fs.writeFileSync(LOCAL_BIN, bytes)
  }
  try {
    fs.chmodSync(LOCAL_BIN, 0o755)
  } catch {}
  return onPath()
}

/**
 * Starts a quick tunnel and waits for it to actually carry traffic.
 *
 * Two things this has to get right. cloudflared's output goes to the log file
 * rather than a pipe, because a piped stderr dies with the parent and takes
 * cloudflared with it. And the URL appears several seconds before the tunnel
 * routes anything, so finding the URL is not the same as being ready.
 */
export async function openTunnel(
  bin: string,
  port: number,
  logPath: string,
  timeoutMs = 60_000,
): Promise<Tunnel> {
  fs.writeFileSync(logPath, "")
  const out = fs.openSync(logPath, "a")
  const child = spawn(bin, ["tunnel", "--no-autoupdate", "--url", `http://127.0.0.1:${port}`], {
    detached: true,
    stdio: ["ignore", out, out],
  })
  child.unref()

  const deadline = Date.now() + timeoutMs
  let found: RegExpMatchArray | null = null

  while (Date.now() < deadline) {
    try {
      found = fs.readFileSync(logPath, "utf8").match(/https:\/\/([a-z0-9-]+)\.trycloudflare\.com/i)
    } catch {}
    if (found) break
    await new Promise((r) => setTimeout(r, 500))
  }
  if (!found) {
    try {
      process.kill(child.pid!)
    } catch {}
    throw new Error(`cloudflared printed no URL. See ${logPath}`)
  }

  const host = `${found[1]}.trycloudflare.com`
  while (Date.now() < deadline) {
    try {
      const r = await fetch(`https://${host}/health`, { signal: AbortSignal.timeout(4000) })
      if (r.ok) return { url: found[0], host, subdomain: found[1], pid: child.pid! }
    } catch {}
    await new Promise((r) => setTimeout(r, 1500))
  }

  try {
    process.kill(child.pid!)
  } catch {}
  throw new Error(`the tunnel at ${host} never carried traffic. See ${logPath}`)
}
