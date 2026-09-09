// One HTTP-and-WebSocket server over two backends.
//
// Bun and Node each provide exactly one of the two halves we need. Bun has a
// native WebSocket server; its node:http compatibility layer silently discards
// writes to an upgrade socket, so the hand-written server cannot run there
// (write() returns true, the callback reports no error, and nothing reaches the
// wire; verified on Bun 1.3.6). Node has a working upgrade socket and no
// WebSocket server at all without a dependency, and `ws` refuses to inline into
// a single-file bundle.
//
// So: Bun's server under Bun, relay/wsserver.ts under Node. Neither needs an
// installed package, which is what lets a plugin install host its own relay.

import http from "node:http"
import type net from "node:net"
import { upgrade } from "./wsserver.ts"

export type Conn = {
  send: (text: string) => void
  close: () => void
  remoteAddress?: string
  data: any
}

export type HttpReply = { status: number; body: string; type?: string }

export type ServeOptions = {
  port: number
  host: string
  /** Everything that is not a websocket upgrade. */
  http: (req: {
    method: string
    url: URL
    body: () => Promise<string>
    remoteAddress?: string
  }) => Promise<HttpReply> | HttpReply
  /** Path that accepts upgrades. Anything else gets a 400. */
  path: string
  open: (conn: Conn) => void
  message: (conn: Conn, text: string) => void
  close: (conn: Conn) => void
  onListen?: () => void
}

const isBun = typeof (globalThis as any).Bun !== "undefined"

export function serve(o: ServeOptions) {
  return isBun ? serveBun(o) : serveNode(o)
}

function serveBun(o: ServeOptions) {
  const Bun = (globalThis as any).Bun
  Bun.serve({
    port: o.port,
    hostname: o.host,
    async fetch(req: Request, server: any) {
      const url = new URL(req.url)
      if (url.pathname === o.path) {
        const ok = server.upgrade(req, { data: { conn: null as Conn | null } })
        return ok ? undefined : new Response("upgrade failed", { status: 400 })
      }
      const reply = await o.http({
        method: req.method,
        url,
        body: () => req.text(),
        remoteAddress: server.requestIP(req)?.address,
      })
      return new Response(reply.body, {
        status: reply.status,
        headers: { "content-type": reply.type ?? "application/json" },
      })
    },
    websocket: {
      open(ws: any) {
        const conn: Conn = {
          send: (t) => {
            try {
              ws.send(t)
            } catch {}
          },
          close: () => ws.close(),
          remoteAddress: ws.remoteAddress,
          data: {},
        }
        ws.data.conn = conn
        o.open(conn)
      },
      message(ws: any, raw: any) {
        if (ws.data.conn) o.message(ws.data.conn, String(raw))
      },
      close(ws: any) {
        if (ws.data.conn) o.close(ws.data.conn)
      },
    },
  })
  o.onListen?.()
}

function serveNode(o: ServeOptions) {
  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url ?? "/", `http://${req.headers.host ?? "localhost"}`)
    const body = () =>
      new Promise<string>((resolve) => {
        let raw = ""
        req.on("data", (c) => {
          raw += c
          if (raw.length > 1 << 20) req.destroy()
        })
        req.on("end", () => resolve(raw))
        req.on("error", () => resolve(""))
      })
    const reply = await o.http({
      method: req.method ?? "GET",
      url,
      body,
      remoteAddress: req.socket.remoteAddress,
    })
    res.writeHead(reply.status, {
      "content-type": reply.type ?? "application/json",
      "content-length": Buffer.byteLength(reply.body),
    })
    res.end(reply.body)
  })

  // Node types the upgrade socket as a Duplex; on a TCP server it is always a
  // net.Socket, and the handshake needs setNoDelay and remoteAddress.
  server.on("upgrade", (req, socket: net.Socket, head) => {
    const url = new URL(req.url ?? "/", `http://${req.headers.host ?? "localhost"}`)
    if (url.pathname !== o.path) {
      socket.end("HTTP/1.1 404 Not Found\r\n\r\n")
      return
    }
    const ws = upgrade(req, socket, head)
    if (!ws) return
    const conn: Conn = {
      send: ws.send,
      close: ws.close,
      remoteAddress: ws.remoteAddress,
      data: {},
    }
    ws.onMessage = (t) => o.message(conn, t)
    ws.onClose = () => o.close(conn)
    o.open(conn)
  })

  server.listen(o.port, o.host, () => o.onListen?.())
}
