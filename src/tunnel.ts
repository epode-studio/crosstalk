// A throwaway public address for the relay, so two people on different networks
// can start a room without either of them running a server.
//
// cloudflared's quick tunnels need no account and no domain, and the URL they
// hand back is itself four hyphenated words, which is how an invite already
// reads. What you give up: the URL is different every time, so it is the relay
// for this session only, and Cloudflare carries the ciphertext. For anything
// lasting, run a relay yourself: see deploy/.
//
// cloudflared has to be installed already. crosstalk used to fetch the binary
// from GitHub releases and chmod it executable, with nothing verifying what came
// back. A tool whose whole claim is that it holds no key it should not hold has
// no business downloading an executable on your behalf, and Hermes's plugin
// scanner was right to refuse the repo over it.

import { spawn, execFileSync } from "node:child_process"
import fs from "node:fs"
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

export const tunnelBinary = () => onPath()

/** cloudflared, if it is installed. Nothing is fetched. */
export async function ensureCloudflared(): Promise<string | null> {
  return onPath()
}

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
    const asked = fs.readFileSync(logPath, "utf8").includes("Requesting new quick Tunnel")
    throw new Error(
      asked
        ? `Cloudflare would not issue a tunnel. See ${logPath}\n\n` +
          `It logged the request and never answered with a hostname, which is what\n` +
          `their rate limit looks like: several quick tunnels from one machine in a\n` +
          `short window stop being handed out. Wait, or run the relay yourself with\n` +
          `--host and give the other person the address it prints.`
        : `cloudflared printed no URL. See ${logPath}`,
    )
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
