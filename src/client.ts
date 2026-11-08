// Talks to the local daemon over its control socket.

import net from "node:net"
import fs from "node:fs"
import { spawn, spawnSync } from "node:child_process"
import path from "node:path"
import { P } from "./config.ts"
import { rootFrom, shim } from "./paths.ts"

export function request<T = any>(req: Record<string, unknown>, timeoutMs = 130_000): Promise<T> {
  return new Promise((resolve, reject) => {
    const sock = net.createConnection(P.daemonSock)
    let rest = ""
    let settled = false
    const finish = (f: () => void) => {
      if (settled) return
      settled = true
      clearTimeout(t)
      f()
    }
    const t = setTimeout(() => {
      sock.destroy()
      finish(() => reject(new Error("daemon did not answer")))
    }, timeoutMs)
    sock.on("connect", () => sock.write(JSON.stringify(req) + "\n"))
    sock.on("data", (b) => {
      rest += b.toString("utf8")
      const i = rest.indexOf("\n")
      if (i === -1) return
      const line = rest.slice(0, i)
      sock.end()
      finish(() => {
        try {
          resolve(JSON.parse(line))
        } catch (e) {
          reject(e)
        }
      })
    })
    sock.on("error", (e) => finish(() => reject(e)))
    // The daemon went away (a restart, a crash) before it answered: say so now
    // rather than waiting out the whole timeout for a reply that cannot come.
    const gone = () => finish(() => reject(new Error("daemon closed the connection without answering")))
    sock.on("end", gone)
    sock.on("close", gone)
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

/** The version in a plugin root's manifest, or "" when it has none. */
export function pluginVersion(root: string): string {
  try {
    return String(JSON.parse(fs.readFileSync(path.join(root, ".claude-plugin", "plugin.json"), "utf8")).version ?? "")
  } catch {
    return ""
  }
}

/** a > b, for dotted versions. */
export function newer(a: string, b: string): boolean {
  const x = a.split(".").map((n) => parseInt(n, 10) || 0)
  const y = b.split(".").map((n) => parseInt(n, 10) || 0)
  for (let i = 0; i < Math.max(x.length, y.length); i++) if ((x[i] ?? 0) !== (y[i] ?? 0)) return (x[i] ?? 0) > (y[i] ?? 0)
  return false
}

/**
 * Whether the running daemon is older than this install: its version file
 * names an older version, or it predates version files. Only ever newer over
 * older, so sessions still on an old install never pull the daemon back.
 */
export function daemonOutdated(mine: string): boolean {
  if (!mine || process.env.CROSSTALK_NO_DAEMON_UPGRADE) return false
  let pid = 0
  try {
    pid = Number(fs.readFileSync(P.daemonLock, "utf8"))
  } catch {
    return false
  }
  try {
    const v = JSON.parse(fs.readFileSync(P.daemonVersion, "utf8"))
    if (v.pid !== pid) return true // written by an earlier daemon: this one predates version files
    return newer(mine, String(v.version ?? ""))
  } catch {
    return true
  }
}

/**
 * One daemon starting at a time. Two hooks firing together each see no socket
 * and each start one; the second would unlink the first's socket and come up
 * alongside it. The first to create the file wins; a file left by a start that
 * died (its pid gone, or older than 30 s) is taken over.
 */
export function takeStartLock(file = path.join(P.root, "daemon.starting"), now = Date.now()): boolean {
  const take = () => {
    try {
      fs.writeFileSync(file, JSON.stringify({ pid: process.pid, at: now }), { flag: "wx", mode: 0o600 })
      return true
    } catch {
      return false
    }
  }
  if (take()) return true
  try {
    const o = JSON.parse(fs.readFileSync(file, "utf8"))
    let alive = true
    try {
      process.kill(Number(o.pid), 0)
    } catch {
      alive = false
    }
    if (alive && o.pid !== process.pid && now - Number(o.at) < 30_000) return false
  } catch {}
  try {
    fs.unlinkSync(file)
  } catch {}
  return take()
}

export function dropStartLock(file = path.join(P.root, "daemon.starting")) {
  try {
    if (JSON.parse(fs.readFileSync(file, "utf8")).pid === process.pid) fs.unlinkSync(file)
  } catch {}
}

/** An upgrade whose daemon would not start: that version is not tried again for an hour. */
const failedFile = () => path.join(P.root, "upgrade-failed.json")
export function upgradeFailed(version: string, now = Date.now()): boolean {
  try {
    const o = JSON.parse(fs.readFileSync(failedFile(), "utf8"))
    return o.version === version && now - Number(o.at) < 3_600_000
  } catch {
    return false
  }
}
export function noteUpgradeFailed(version: string, now = Date.now()) {
  try {
    fs.writeFileSync(failedFile(), JSON.stringify({ version, at: now }), { mode: 0o600 })
  } catch {}
}

/** The install the running daemon came from, so a failed upgrade can bring it back. */
export function daemonRoot(): string | undefined {
  try {
    const r = String(JSON.parse(fs.readFileSync(P.daemonVersion, "utf8")).root ?? "")
    return r && fs.existsSync(r) ? r : undefined
  } catch {
    return undefined
  }
}

/**
 * Whether a pid is a crosstalk daemon: never this process, and its command
 * line runs crosstalk's daemon entry, so a stale lock naming a reused pid is
 * never signalled.
 */
export function isDaemonProcess(pid: number, args: (pid: number) => string | null = psArgs): boolean {
  if (!pid || pid === process.pid || pid === process.ppid) return false
  const a = args(pid) ?? ""
  return /(^|[\/\s])daemon\.(js|ts)(\s|$)/.test(a) || /\bcrosstalk\S*\s+daemon\s*$/.test(a)
}

function psArgs(pid: number): string | null {
  try {
    const r = spawnSync("ps", ["-o", "args=", "-p", String(pid)], { encoding: "utf8", timeout: 2000 })
    return r.status === 0 ? r.stdout.trim() : null
  } catch {
    return null
  }
}

/** Stop an older daemon so this install's starts. SIGTERM only, only to a crosstalk daemon; true when it has gone. */
async function stopOutdated(): Promise<boolean> {
  const pid = Number(fs.readFileSync(P.daemonLock, "utf8"))
  if (!isDaemonProcess(pid)) return false
  try {
    process.kill(pid, "SIGTERM")
  } catch {}
  for (let i = 0; i < 50; i++) {
    if (!daemonRunning()) return true
    await new Promise((r) => setTimeout(r, 100))
  }
  return false
}

/** Start the daemon detached if it is not already up. Safe to call repeatedly. A daemon from an older install is replaced. */
export async function ensureDaemon(root = rootFrom(import.meta.url)): Promise<boolean> {
  let fallback: string | undefined
  const mine = pluginVersion(root)
  if (daemonRunning()) {
    if (!daemonOutdated(mine) || upgradeFailed(mine)) return true
    fallback = daemonRoot()
    if (!(await stopOutdated())) return true // it would not go: keep using it
  }
  if (await start(root)) return true
  // The newer install's daemon would not start: bring the old one back, and leave that version alone for an hour.
  if (fallback && fallback !== root) {
    noteUpgradeFailed(mine)
    return start(fallback)
  }
  return false
}

async function start(root: string): Promise<boolean> {
  let child
  try {
    fs.mkdirSync(P.root, { recursive: true, mode: 0o700 })
    const out = fs.openSync(P.log, "a")
    child = spawn(shim(root), ["daemon"], {
      detached: true,
      stdio: ["ignore", out, out],
    })
  } catch {
    return false
  }
  // A missing or unrunnable shim is reported here, asynchronously. Unhandled,
  // it would kill a hook before it printed its answer.
  let failed = false
  child.on("error", () => (failed = true))
  child.unref()
  for (let i = 0; i < 40; i++) {
    if (daemonRunning()) return true
    if (failed) return false
    await new Promise((r) => setTimeout(r, 100))
  }
  return false
}

/**
 * A session started before crosstalk updated keeps running the old version
 * until it restarts. Said once per session, quietly, when the daemon is newer.
 */
export function staleNotice(sessionId: string, mine: string): string | null {
  if (!mine || !sessionId) return null
  let theirs = ""
  try {
    theirs = String(JSON.parse(fs.readFileSync(P.daemonVersion, "utf8")).version ?? "")
  } catch {
    return null
  }
  if (!newer(theirs, mine)) return null
  const f = path.join(P.root, "stale-noted.json")
  let noted: Record<string, number> = {}
  try {
    noted = JSON.parse(fs.readFileSync(f, "utf8"))
  } catch {}
  if (noted[sessionId]) return null
  const now = Date.now()
  for (const [k, at] of Object.entries(noted)) if (now - at > 7 * 86_400_000) delete noted[k]
  noted[sessionId] = now
  try {
    fs.writeFileSync(f, JSON.stringify(noted), { mode: 0o600 })
  } catch {}
  return `◢ crosstalk updated to ${theirs}. This session still runs ${mine}: it picks up the new one next time it starts. Nothing to do now.`
}
