// What is running, asked of the machine: the process table, who listens on
// which TCP port, and each process's working directory. docs/services.md.
//
// Three users:
//
//   a service's ports     the listening ports of the process tree in its tmux
//                         pane (or of its detached process)
//   postponing an end     anything a Claude session started that is still
//                         running: gather and dispose wait for it to stop
//                         instead of ending the session under it
//   cleanup               nothing is removed while a process works in it or
//                         listens from it
//
// Listening ports: `ss -ltnpH` on Linux, else `lsof -nP -iTCP -sTCP:LISTEN`
// (macOS, and Linux without ss). Working directories: /proc on Linux, `lsof -d
// cwd` elsewhere. Every reader fails soft, to "nothing found": the callers
// that act on "nothing" (cleanup, restarts) also have git's and the session
// registry's own checks.

import fs from "node:fs"
import path from "node:path"
import { spawnSync } from "node:child_process"

export type Proc = { pid: number; ppid: number; args: string }
export type Listener = { pid: number; port: number }

const run = (cmd: string, args: string[], timeout = 5000): string | null => {
  try {
    const r = spawnSync(cmd, args, { encoding: "utf8", timeout, maxBuffer: 32 * 1024 * 1024 })
    if (r.error || (r.status !== 0 && !r.stdout)) return null
    return r.stdout ?? ""
  } catch {
    return null
  }
}

/** `ps -Ao pid=,ppid=,args=`, parsed. */
export function parsePs(text: string): Proc[] {
  const out: Proc[] = []
  for (const l of text.split("\n")) {
    const m = /^\s*(\d+)\s+(\d+)\s?(.*)$/.exec(l)
    if (m) out.push({ pid: Number(m[1]), ppid: Number(m[2]), args: m[3].trim() })
  }
  return out
}

export function psTable(): Proc[] {
  return parsePs(run("ps", ["-Ao", "pid=,ppid=,args="]) ?? "")
}

/** Every process below `pid`, breadth first, not `pid` itself. */
export function descendants(pid: number, table: Proc[]): Proc[] {
  const kids = new Map<number, Proc[]>()
  for (const p of table) if (p.pid !== p.ppid) (kids.get(p.ppid) ?? kids.set(p.ppid, []).get(p.ppid)!).push(p)
  const out: Proc[] = []
  const seen = new Set<number>([pid])
  const queue = [pid]
  while (queue.length) {
    for (const k of kids.get(queue.shift()!) ?? []) {
      if (seen.has(k.pid)) continue
      seen.add(k.pid)
      out.push(k)
      queue.push(k.pid)
    }
  }
  return out
}

/** `pid` and everything below it. */
export const tree = (pid: number, table: Proc[]): number[] => [pid, ...descendants(pid, table).map((p) => p.pid)]

/** `ss -ltnpH`: `LISTEN 0 511 0.0.0.0:3001 0.0.0.0:* users:(("bun",pid=123,fd=12))`. */
export function parseSs(text: string): Listener[] {
  const out: Listener[] = []
  for (const l of text.split("\n")) {
    const cols = l.trim().split(/\s+/)
    if (cols.length < 5) continue
    const local = cols[0] === "LISTEN" ? cols[3] : cols[2]
    const port = Number(/:(\d+)$/.exec(local ?? "")?.[1])
    if (!port) continue
    for (const m of l.matchAll(/pid=(\d+)/g)) out.push({ pid: Number(m[1]), port })
  }
  return out
}

/** `lsof -nP -iTCP -sTCP:LISTEN -Fpn`: `p123` then `n*:3001`, `n127.0.0.1:3001`, `n[::1]:3001`. */
export function parseLsof(text: string): Listener[] {
  const out: Listener[] = []
  let pid = 0
  for (const l of text.split("\n")) {
    if (l.startsWith("p")) pid = Number(l.slice(1)) || 0
    else if (l.startsWith("n") && pid) {
      const port = Number(/:(\d+)$/.exec(l)?.[1])
      if (port) out.push({ pid, port })
    }
  }
  return out
}

const dedupe = (ls: Listener[]) => [...new Map(ls.map((l) => [`${l.pid}:${l.port}`, l])).values()]

/** Every TCP port listened on now, with the pid listening, as far as this user may see. */
export function listeners(platform: NodeJS.Platform = process.platform): Listener[] {
  if (process.env.CROSSTALK_NO_LISTENERS) return []
  if (platform === "linux") {
    const ss = run("ss", ["-ltnpH"])
    if (ss !== null) {
      const got = parseSs(ss)
      if (got.length || !ss.trim()) return dedupe(got)
    }
  }
  const lsof = run("lsof", ["-nP", "-iTCP", "-sTCP:LISTEN", "-Fpn"])
  return lsof === null ? [] : dedupe(parseLsof(lsof))
}

/** `lsof -d cwd -Fpn`: `p123` then `n/the/folder`. */
export function parseLsofCwd(text: string): Map<number, string> {
  const out = new Map<number, string>()
  let pid = 0
  for (const l of text.split("\n")) {
    if (l.startsWith("p")) pid = Number(l.slice(1)) || 0
    else if (l.startsWith("n") && pid) out.set(pid, l.slice(1))
  }
  return out
}

/** Every process's working directory this user may read. */
export function cwds(platform: NodeJS.Platform = process.platform): Map<number, string> {
  const out = new Map<number, string>()
  if (platform === "linux") {
    try {
      for (const p of fs.readdirSync("/proc")) {
        if (!/^\d+$/.test(p)) continue
        try {
          out.set(Number(p), fs.readlinkSync(`/proc/${p}/cwd`))
        } catch {}
      }
      return out
    } catch {}
  }
  const lsof = run("lsof", ["-d", "cwd", "-Fpn"], 15_000)
  return lsof === null ? out : parseLsofCwd(lsof)
}

export const under = (p: string, dir: string) => {
  const a = path.resolve(p)
  const b = path.resolve(dir)
  return a === b || a.startsWith(b + path.sep)
}

// --- what a Claude session started ------------------------------------------------

export const SHELL = /^-?(sh|bash|zsh|dash|fish|ksh|tcsh|csh)$/
const prog = (args: string) => path.basename(args.trim().split(/\s+/)[0] ?? "")
export const isShell = (p: Proc) => SHELL.test(prog(p.args))

export type Activity = { pid: number; args: string; ports: number[] }

/**
 * What a Claude session started that is still running: every process below a
 * shell the session spawned (its Bash tool runs each command in one), and any
 * port listened on from there. Left out, as Claude Code's own: the processes
 * it spawns directly (MCP servers, hooks, ripgrep) and everything below them,
 * shells with nothing running in them, crosstalk's own processes (`ours`:
 * its watch and pane, by their command line), and anything in `exclude`
 * (crosstalk's services and their trees, which outlive the session anyway).
 */
export function activity(claudePid: number, o: { table: Proc[]; listeners: Listener[]; exclude?: Set<number>; ours?: (args: string) => boolean }): Activity[] {
  const ours = o.ours ?? (() => false)
  const exclude = o.exclude ?? new Set<number>()
  const ports = new Map<number, number[]>()
  for (const l of o.listeners) (ports.get(l.pid) ?? ports.set(l.pid, []).get(l.pid)!).push(l.port)
  const kids = new Map<number, Proc[]>()
  for (const p of o.table) if (p.pid !== p.ppid) (kids.get(p.ppid) ?? kids.set(p.ppid, []).get(p.ppid)!).push(p)
  const out: Activity[] = []
  const walk = (p: Proc, depth: number) => {
    if (exclude.has(p.pid) || ours(p.args) || depth > 64) return
    const listening = ports.get(p.pid) ?? []
    if (!isShell(p) || listening.length) out.push({ pid: p.pid, args: p.args, ports: [...new Set(listening)].sort((a, b) => a - b) })
    for (const k of kids.get(p.pid) ?? []) walk(k, depth + 1)
  }
  for (const child of kids.get(claudePid) ?? []) {
    if (!isShell(child) || exclude.has(child.pid) || ours(child.args)) continue
    for (const k of kids.get(child.pid) ?? []) walk(k, 1)
    if (ports.get(child.pid)?.length) out.push({ pid: child.pid, args: child.args, ports: ports.get(child.pid)! })
  }
  return out
}

/** crosstalk's own processes, by their command line: its CLI, hook, server and daemon. */
export const oursBy = (root: string) => (args: string) =>
  args.includes(path.join(root, "bin", "crosstalk")) || args.includes(path.join(root, "dist")) || args.includes(path.join(root, "src")) || /(^|\/)crosstalk(\s|$)/.test(args.split(/\s+/)[0] ?? "")
