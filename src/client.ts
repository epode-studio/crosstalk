// Talks to the local daemon over its control socket.

import net from "node:net"
import fs from "node:fs"
import { spawn } from "node:child_process"
import path from "node:path"
import { P } from "./config.ts"
import { rootFrom, shim } from "./paths.ts"

export function request<T = any>(req: Record<string, unknown>, timeoutMs = 130_000): Promise<T> {
  return new Promise((resolve, reject) => {
    const sock = net.createConnection(P.daemonSock)
    let rest = ""
    const t = setTimeout(() => {
      sock.destroy()
      reject(new Error("daemon did not answer"))
    }, timeoutMs)
    sock.on("connect", () => sock.write(JSON.stringify(req) + "\n"))
    sock.on("data", (b) => {
      rest += b.toString("utf8")
      const i = rest.indexOf("\n")
      if (i === -1) return
      clearTimeout(t)
      const line = rest.slice(0, i)
      sock.end()
      try {
        resolve(JSON.parse(line))
      } catch (e) {
        reject(e)
      }
    })
    sock.on("error", (e) => {
      clearTimeout(t)
      reject(e)
    })
  })
}

export function daemonRunning(): boolean {
  try {
    const pid = Number(fs.readFileSync(P.daemonLock, "utf8"))
    process.kill(pid, 0)
    return fs.existsSync(P.daemonSock)
  } catch {
    return false
  }
}

/** Start the daemon detached if it is not already up. Safe to call repeatedly. */
export async function ensureDaemon(root = rootFrom(import.meta.url)): Promise<boolean> {
  if (daemonRunning()) return true
  const out = fs.openSync(P.log, "a")
  const child = spawn(shim(root), ["daemon"], {
    detached: true,
    stdio: ["ignore", out, out],
  })
  child.unref()
  for (let i = 0; i < 40; i++) {
    if (daemonRunning()) return true
    await new Promise((r) => setTimeout(r, 100))
  }
  return false
}
