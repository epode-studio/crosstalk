// The local proxy behind `http://auth.localhost` (docs/urls.md).
//
//   where      127.0.0.1 only, on CROSSTALK_PROXY_PORT when set; else port 80
//              when it can be had without privileges (macOS lets anyone bind
//              it; Linux mostly does not), else 1355
//   routing    by the Host header (routes.ts) to the service's current port;
//              a name not known is looked up again at once (a service that
//              just moved), and still unknown, a small page lists the names
//              there are
//   bytes      once routed, the connection is piped as it is, both ways: so
//              websockets (a dev server's HMR), server-sent events and
//              streamed responses work, and the Host header reaches the
//              server unchanged (Vite, Next and webpack accept *.localhost)
//   upstream   127.0.0.1, then ::1 (Node's dev servers often listen on
//              `localhost`, which can be ::1 alone)
//   safety     only Host names under .localhost are routed or answered with
//              the list: a page that reached this port by DNS rebinding sends
//              its own host name, and gets a bare 421
//
// The daemon runs it (daemon.ts) and writes <crosstalk home>/proxy.json with
// its port and routes, which is how the hook, the MCP server and the pane know
// it is up and what each worktree's name is.

import fs from "node:fs"
import net from "node:net"
import path from "node:path"
import { P } from "../config.ts"
import { buildTable, hostLabel, lookup, proxyUrl, type Route, type Table, type Target } from "./routes.ts"

export const DEFAULT_PORT = 1355
const HEAD_MAX = 32 * 1024

export type ProxyState = { port: number; pid: number; at: number; routes: Route[] }

export const stateFile = () => path.join(P.root, "proxy.json")

const alive = (pid: number) => {
  try {
    process.kill(pid, 0)
    return true
  } catch (e) {
    return (e as NodeJS.ErrnoException).code === "EPERM"
  }
}

/** The proxy's state, when one is up. */
export function readState(file = stateFile()): ProxyState | null {
  try {
    const s = JSON.parse(fs.readFileSync(file, "utf8"))
    if (!(s?.port > 0) || !(s?.pid > 0) || !alive(s.pid)) return null
    return { port: s.port, pid: s.pid, at: s.at ?? 0, routes: Array.isArray(s.routes) ? s.routes : [] }
  } catch {
    return null
  }
}

export function writeState(s: { port: number; routes: Route[] }, file = stateFile()) {
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 })
  const tmp = `${file}.${process.pid}.tmp`
  fs.writeFileSync(tmp, JSON.stringify({ port: s.port, pid: process.pid, at: Date.now(), routes: s.routes }, null, 1), { mode: 0o600 })
  fs.renameSync(tmp, file)
}

export function clearState(file = stateFile()) {
  try {
    const s = JSON.parse(fs.readFileSync(file, "utf8"))
    if (s?.pid === process.pid) fs.unlinkSync(file)
  } catch {}
}

const esc = (s: string) => s.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`)

/** The page for a name not known here: what there is, as links. */
export function indexPage(routes: Route[], port: number, asked?: string): string {
  const rows = routes.length
    ? routes
        .map((r) => {
          const u = proxyUrl(r.host, port)
          return `<li><a href="${esc(u)}">${esc(u)}</a> &rarr; ${esc(r.group)} &middot; ${esc(r.service)} on :${r.port}</li>`
        })
        .join("\n")
    : "<li>Nothing yet. Services crosstalk runs (crosstalk_serve) show up here by name.</li>"
  return `<!doctype html><meta charset="utf-8"><title>crosstalk</title><style>body{font:14px/1.5 system-ui,sans-serif;margin:2rem;max-width:46rem}code{background:#eee;padding:0 .2em}</style>
<h1>crosstalk</h1><p>${asked ? `No service is called <code>${esc(asked)}</code> here.` : "The local servers crosstalk knows by name:"}</p><ul>
${rows}
</ul>`
}

function respond(sock: net.Socket, code: number, reason: string, body: string, type = "text/html; charset=utf-8") {
  const b = Buffer.from(body, "utf8")
  sock.end(`HTTP/1.1 ${code} ${reason}\r\ncontent-type: ${type}\r\ncontent-length: ${b.length}\r\nconnection: close\r\ncache-control: no-store\r\n\r\n${body}`)
}

function connectUpstream(port: number): Promise<net.Socket | null> {
  const tryHost = (host: string) =>
    new Promise<net.Socket | null>((resolve) => {
      const s = net.connect({ host, port })
      const fail = () => {
        s.destroy()
        resolve(null)
      }
      s.once("connect", () => {
        s.off("error", fail)
        resolve(s)
      })
      s.once("error", fail)
      s.setTimeout(3000, fail)
    })
  return tryHost("127.0.0.1").then((s) => s ?? tryHost("::1"))
}

export type Proxy = {
  port: number
  server: net.Server
  /** The table now. */
  table: () => Table
  /** Look the targets up again now. */
  refresh: () => void
  close: () => Promise<void>
}

/**
 * Start the proxy. `targets` is asked for the services now (cheap: no port
 * lookup); `onTable` hears each table that differs from the last.
 */
export async function startProxy(o: { targets: () => Target[]; ports?: number[]; refreshMs?: number; onTable?: (t: Table, port: number) => void; log?: (s: string) => void }): Promise<Proxy | null> {
  let table: Table = buildTable([])
  let last = ""
  let port = 0
  const refresh = () => {
    try {
      table = buildTable(o.targets())
    } catch {}
    const sig = JSON.stringify(table.routes)
    if (sig !== last && port) {
      last = sig
      o.onTable?.(table, port)
    }
  }
  let lastMiss = 0
  const server = net.createServer((sock) => {
    sock.on("error", () => {})
    sock.setTimeout(30_000, () => sock.destroy())
    let head = Buffer.alloc(0)
    const onData = async (chunk: Buffer) => {
      head = Buffer.concat([head, chunk])
      const end = head.indexOf("\r\n\r\n")
      if (end === -1) {
        if (head.length > HEAD_MAX) respond(sock, 431, "Request Header Fields Too Large", "too large")
        return
      }
      sock.off("data", onData)
      sock.pause()
      const text = head.subarray(0, end).toString("latin1")
      const host = /\r\nhost:[ \t]*([^\r\n]*)/i.exec(text)?.[1]?.trim()
      const l = hostLabel(host)
      if (l === null) return respond(sock, 421, "Misdirected Request", "crosstalk's proxy answers *.localhost names only.\n", "text/plain")
      let r = lookup(table, host)
      // A service that just started or moved: look again, at most once a second.
      if (!r && l && Date.now() - lastMiss > 1000) {
        lastMiss = Date.now()
        refresh()
        r = lookup(table, host)
      }
      if (!r) return respond(sock, l ? 404 : 200, l ? "Not Found" : "OK", indexPage(table.routes, port, l || undefined))
      const up = await connectUpstream(r.port)
      if (!up) return respond(sock, 502, "Bad Gateway", `<!doctype html><meta charset="utf-8"><title>crosstalk</title><p>${esc(r.group)} &middot; ${esc(r.service)} is not answering on :${r.port}.</p>`)
      sock.setTimeout(0)
      up.on("error", () => sock.destroy())
      sock.on("error", () => up.destroy())
      up.on("close", () => sock.destroy())
      sock.on("close", () => up.destroy())
      up.write(head)
      sock.pipe(up)
      up.pipe(sock)
      sock.resume()
    }
    sock.on("data", onData)
  })
  server.on("error", () => {})
  const want = o.ports ?? portsToTry()
  for (const p of want) {
    const ok = await new Promise<boolean>((resolve) => {
      const onErr = (e: NodeJS.ErrnoException) => {
        server.off("listening", onOk)
        o.log?.(`urls: proxy could not listen on 127.0.0.1:${p}: ${e.code ?? e.message}`)
        resolve(false)
      }
      const onOk = () => {
        server.off("error", onErr)
        resolve(true)
      }
      server.once("error", onErr)
      server.once("listening", onOk)
      server.listen(p, "127.0.0.1")
    })
    if (ok) {
      port = (server.address() as net.AddressInfo).port
      break
    }
  }
  if (!port) return null
  refresh()
  // The first table, even an empty one, so readers know the proxy is up.
  if (!last) {
    last = JSON.stringify(table.routes)
    o.onTable?.(table, port)
  }
  const timer = setInterval(refresh, o.refreshMs ?? 3000)
  timer.unref?.()
  return {
    port,
    server,
    table: () => table,
    refresh,
    close: () =>
      new Promise<void>((resolve) => {
        clearInterval(timer)
        server.close(() => resolve())
      }),
  }
}

/** CROSSTALK_PROXY_PORT alone when set; else 80 (taken only where it needs no privileges), then 1355. */
export function portsToTry(env: NodeJS.ProcessEnv = process.env): number[] {
  const n = Number(env.CROSSTALK_PROXY_PORT)
  if (env.CROSSTALK_PROXY_PORT !== undefined && Number.isInteger(n) && n >= 0 && n < 65536) return [n]
  // As root, 80 is had through privilege: leave it to whatever the machine runs there.
  const root = typeof process.getuid === "function" && process.getuid() === 0
  return root ? [DEFAULT_PORT] : [80, DEFAULT_PORT]
}
