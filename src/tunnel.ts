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
  // --config /dev/null is what makes this a quick tunnel. Without it cloudflared
  // reads ~/.cloudflared/config.yml, and on a machine that already has a named
  // tunnel it runs *that* one: it prints no trycloudflare URL, serves whatever
  // the user's own ingress rules point at, and crosstalk is not on the other end
  // of anything. Somebody who runs their own tunnels is exactly the person who
  // would reach for --public.
  const child = spawn(
    bin,
    ["tunnel", "--no-autoupdate", "--config", "/dev/null", "--url", `http://127.0.0.1:${port}`],
    {
      detached: true,
      stdio: ["ignore", out, out],
    },
  )
  child.unref()

  // A detached child outlives us, so an interrupt while the tunnel is still
  // coming up leaves cloudflared running with nothing on the other end of it.
  const stop = () => {
    try {
      process.kill(child.pid!)
    } catch {}
  }
  process.once("exit", stop)
  process.once("SIGINT", () => {
    stop()
    process.exit(130)
  })
  process.once("SIGTERM", () => {
    stop()
    process.exit(143)
  })

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
    stop()
    throw new Error(`cloudflared printed no URL. See ${logPath}`)
  }

  // Finding the URL and proving it carries traffic get separate budgets. They
  // shared one, so a slow start ate the whole allowance and the tunnel was
  // killed while it was still coming up. Ten seconds a request, because the
  // first one to a fresh quick tunnel pays for a cold DNS lookup and a full TLS
  // handshake against an edge that has not routed this hostname before, and
  // four seconds is not reliably enough for that.
  const host = `${found[1]}.trycloudflare.com`
  const carrying = Date.now() + timeoutMs
  while (Date.now() < carrying) {
    try {
      const r = await fetch(`https://${host}/health`, { signal: AbortSignal.timeout(10_000) })
      if (r.ok) return { url: found[0], host, subdomain: found[1], pid: child.pid! }
    } catch {}
    await new Promise((r) => setTimeout(r, 1500))
  }

  stop()
  throw new Error(
    `the tunnel at ${host} never carried traffic. See ${logPath}\n\n` +
      `If that hostname does not resolve at all, Cloudflare never published DNS\n` +
      `for it. Quick tunnels are rate limited, so several in a few minutes stop\n` +
      `being handed out. Wait a few minutes, or run the relay yourself with\n` +
      `--host and give the other person the address it prints.`,
  )
}
