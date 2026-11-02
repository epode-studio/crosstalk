// The viewer's end of a share (docs/urls.md, "Sharing"): a local listener per
// share, on 127.0.0.1, that the viewer's own proxy names
// `<name>.<owner>.localhost`. Each request (and websocket) it takes becomes a
// stream of frames to the owner's daemon; the answer streams back.
//
//   host check   only loopback Host names (`*.localhost`, localhost,
//                127.0.0.1, [::1]) are answered, so a page that reached the
//                port by DNS rebinding gets a bare 421
//   streaming    a response is handed to the browser as its frames arrive;
//                a request body goes as it is read
//   websockets   the upgrade waits for the owner's server to open its side,
//                with the subprotocol it chose; then messages both ways
//
// Transport-agnostic: `send` carries a frame to the owner.

import crypto from "node:crypto"
import * as F from "./frames.ts"

export type ViewerDeps = {
  send: (owner: string, f: F.ReqFrame) => void
  log?: (s: string) => void
  /** How long to wait for the owner's answer to start. */
  timeoutMs?: number
}

type Head = { status: number; statusText?: string; headers: F.Headers } | { error: number; message: string } | { ws: true; protocol?: string }

type Stream = {
  s: string
  share: string
  owner: string
  q: number
  inq: number
  head?: (h: Head) => void
  ctrl?: ReadableStreamDefaultController<Uint8Array>
  /** What arrived before the body was handed to the browser, and whether it ended. */
  early?: Uint8Array[]
  earlyEnd?: boolean
  ws?: import("bun").ServerWebSocket<{ st: Stream }>
  wsQueue?: { d: Buffer; b: boolean }[]
  bytes: number
  done?: boolean
}

export type Listening = { id: string; owner: string; port: number; stop: () => void }

const NO_BODY = new Set([101, 204, 205, 304])

const page = (status: number, text: string) =>
  new Response(`<!doctype html><meta charset="utf-8"><title>crosstalk</title><p>${text.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`)}</p>`, { status, headers: { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" } })

export class ShareViewer {
  private streams = new Map<string, Stream>()
  private listeners = new Map<string, { owner: string; server: import("bun").Server<{ st: Stream }>; ended?: string }>()
  constructor(private d: ViewerDeps) {}

  private key = (owner: string, s: string) => `${owner}\0${s}`

  private out(st: Stream, f: Record<string, unknown>) {
    this.d.send(st.owner, { ...f, share: st.share, s: st.s, q: st.q++ } as F.ReqFrame)
  }

  private finish(st: Stream) {
    if (st.done) return
    st.done = true
    this.streams.delete(this.key(st.owner, st.s))
  }

  private newStream(owner: string, share: string): Stream {
    const st: Stream = { s: crypto.randomBytes(12).toString("base64url"), share, owner, q: 0, inq: 0, bytes: 0 }
    this.streams.set(this.key(owner, st.s), st)
    return st
  }

  private waitHead(st: Stream): Promise<Head> {
    return new Promise<Head>((resolve) => {
      const t = setTimeout(() => {
        st.head = undefined
        resolve({ error: 504, message: "the owner's machine did not answer in time (it may be offline)" })
      }, this.d.timeoutMs ?? 30_000)
      st.head = (h) => {
        clearTimeout(t)
        st.head = undefined
        resolve(h)
      }
    })
  }

  /** One request, start to end, without a listener: for the daemon's own checks and tests. */
  async request(owner: string, share: string, r: { method?: string; path: string; headers?: F.Headers; body?: Uint8Array }): Promise<{ status: number; headers: F.Headers; body: Buffer; message?: string }> {
    const st = this.newStream(owner, share)
    const chunks: Buffer[] = []
    let done!: () => void
    const ended = new Promise<void>((r) => (done = r))
    st.ctrl = { enqueue: (c: Uint8Array) => void chunks.push(Buffer.from(c)), close: () => done(), error: () => done(), desiredSize: 1 } as unknown as ReadableStreamDefaultController<Uint8Array>
    const head = this.waitHead(st)
    this.out(st, { op: "req", method: r.method ?? "GET", path: r.path, headers: r.headers ?? [["host", "localhost"]] })
    for (const c of r.body ? F.chunks(r.body) : []) this.out(st, { op: "body", d: F.enc(c) })
    this.out(st, { op: "end" })
    const h = await head
    if ("error" in h) {
      this.finish(st)
      return { status: h.error, headers: [], body: Buffer.alloc(0), message: h.message }
    }
    if ("ws" in h) return { status: 101, headers: [], body: Buffer.alloc(0) }
    const t = setTimeout(done, this.d.timeoutMs ?? 30_000)
    await ended
    clearTimeout(t)
    return { status: h.status, headers: h.headers, body: Buffer.concat(chunks) }
  }

  /** Start the listener for a share; resolves with its port. */
  listen(o: { id: string; owner: string; port?: number }): Listening {
    this.close(o.id)
    const self = this
    const server = Bun.serve<{ st: Stream }>({
      hostname: "127.0.0.1",
      port: o.port ?? 0,
      idleTimeout: 0,
      maxRequestBodySize: F.MAX_REQUEST_BODY,
      async fetch(req, srv) {
        if (!F.loopbackHost(req.headers.get("host"))) return new Response("crosstalk answers *.localhost names only.\n", { status: 421 })
        const l = self.listeners.get(o.id)
        if (!l || l.ended) return page(410, `This share from ${o.owner} has ${l?.ended ?? "ended"}.`)
        const url = new URL(req.url)
        const path = `${url.pathname}${url.search}`
        const headers = F.pairsOf(req.headers)
        const st = self.newStream(o.owner, o.id)
        const head = self.waitHead(st)
        if ((req.headers.get("upgrade") ?? "").toLowerCase() === "websocket") {
          const protocols = (req.headers.get("sec-websocket-protocol") ?? "")
            .split(",")
            .map((p) => p.trim())
            .filter(Boolean)
          self.out(st, { op: "req", method: "GET", path, headers, ws: true, ...(protocols.length ? { protocols } : {}) })
          const h = await head
          if ("error" in h) {
            self.finish(st)
            return page(h.error, h.message)
          }
          if (!("ws" in h)) {
            self.finish(st)
            return page(502, "the shared server did not open a websocket")
          }
          st.wsQueue = []
          if (srv.upgrade(req, { data: { st }, headers: h.protocol ? { "Sec-WebSocket-Protocol": h.protocol } : undefined })) return undefined as unknown as Response
          self.out(st, { op: "wsclose", code: 1011 })
          self.finish(st)
          return page(400, "not a websocket upgrade")
        }
        self.out(st, { op: "req", method: req.method, path, headers })
        // The body goes as it is read.
        void (async () => {
          try {
            if (req.body) {
              const reader = req.body.getReader()
              for (;;) {
                const { value, done } = await reader.read()
                if (done || st.done) break
                for (const c of F.chunks(value)) self.out(st, { op: "body", d: F.enc(c) })
              }
            }
            if (!st.done) self.out(st, { op: "end" })
          } catch {
            if (!st.done) self.out(st, { op: "abort" })
          }
        })()
        const h = await head
        if ("error" in h) {
          self.finish(st)
          return page(h.error, h.message)
        }
        if ("ws" in h) {
          self.finish(st)
          return page(502, "unexpected websocket")
        }
        const out = new Headers()
        for (const [k, v] of F.cleanHeaders(h.headers)) {
          try {
            out.append(k, v)
          } catch {}
        }
        if (req.method === "HEAD" || NO_BODY.has(h.status)) {
          self.out(st, { op: "abort" })
          self.finish(st)
          return new Response(null, { status: h.status, statusText: h.statusText, headers: out })
        }
        const body = new ReadableStream<Uint8Array>({
          start(c) {
            st.ctrl = c
            for (const b of st.early ?? []) c.enqueue(b)
            st.early = undefined
            if (st.earlyEnd) c.close()
          },
          cancel() {
            if (!st.done) self.out(st, { op: "abort" })
            self.finish(st)
          },
        })
        return new Response(body, { status: h.status, statusText: h.statusText, headers: out })
      },
      websocket: {
        open(ws) {
          const st = ws.data.st
          st.ws = ws
          for (const m of st.wsQueue ?? []) ws.send(m.b ? m.d : m.d.toString("utf8"))
          st.wsQueue = undefined
        },
        message(ws, m) {
          const st = ws.data.st
          if (st.done) return
          const binary = typeof m !== "string"
          const b = binary ? Buffer.from(m as Uint8Array) : Buffer.from(m, "utf8")
          if (b.length > F.MAX_WS_MESSAGE) return ws.close(1009)
          self.out(st, { op: "wsmsg", d: F.enc(b), ...(binary ? { b: true } : {}) })
        },
        close(ws, code, reason) {
          const st = ws.data.st
          if (st.done) return
          self.out(st, { op: "wsclose", code, reason: String(reason ?? "").slice(0, 120) })
          self.finish(st)
        },
      },
    })
    this.listeners.set(o.id, { owner: o.owner, server })
    return { id: o.id, owner: o.owner, port: server.port!, stop: () => this.close(o.id) }
  }

  /** One frame from `owner`. */
  onFrame(owner: string, f: F.ResFrame): void {
    if (!f || typeof f !== "object" || typeof f.s !== "string") return
    const st = this.streams.get(this.key(owner, f.s))
    if (!st || st.share !== f.share) return
    if (f.q !== st.inq) {
      this.d.log?.(`share: a frame from ${owner} out of order; ending the request`)
      return this.abort(st, 502, "frames out of order")
    }
    st.inq++
    switch (f.op) {
      case "res":
        if (st.head) st.head({ status: Number(f.status) >= 100 && Number(f.status) < 600 ? Number(f.status) : 502, statusText: typeof f.statusText === "string" ? f.statusText.replace(/[^\x20-\x7e]/g, "") : undefined, headers: Array.isArray(f.headers) ? f.headers : [] })
        return
      case "body": {
        const b = F.dec(f.d)
        st.bytes += b.length
        if (st.bytes > F.MAX_RESPONSE_BODY) return this.abort(st, 502, "response too large")
        try {
          if (st.ctrl) st.ctrl.enqueue(new Uint8Array(b))
          else (st.early ??= []).push(new Uint8Array(b))
        } catch {
          this.out(st, { op: "abort" })
          this.finish(st)
        }
        return
      }
      case "end":
        try {
          if (st.ctrl) st.ctrl.close()
          else st.earlyEnd = true
        } catch {}
        return this.finish(st)
      case "error":
        return this.abort(st, Number(f.status) || 502, typeof f.message === "string" ? f.message.slice(0, 200) : "error")
      case "wsopen":
        if (st.head) st.head({ ws: true, protocol: typeof f.protocol === "string" && /^[!#$%&'*+.^_`|~0-9A-Za-z-]{1,64}$/.test(f.protocol) ? f.protocol : undefined })
        return
      case "wsmsg": {
        const b = F.dec(f.d)
        if (st.ws) st.ws.send(f.b ? b : b.toString("utf8"))
        else if (st.wsQueue && st.wsQueue.length < 256) st.wsQueue.push({ d: b, b: !!f.b })
        return
      }
      case "wsclose": {
        const code = typeof f.code === "number" && f.code >= 1000 && f.code < 5000 && f.code !== 1005 && f.code !== 1006 ? f.code : 1000
        try {
          st.ws?.close(code, typeof f.reason === "string" ? f.reason.slice(0, 120) : undefined)
        } catch {}
        return this.finish(st)
      }
    }
  }

  private abort(st: Stream, status: number, message: string) {
    if (st.head) st.head({ error: status, message })
    else if (st.ws) {
      try {
        st.ws.close(status === 410 || status === 403 ? 1008 : 1011, message.slice(0, 120))
      } catch {}
    } else
      try {
        st.ctrl?.error(new Error(message))
      } catch {}
    this.finish(st)
  }

  /** Stop a share's listener and every request of it (stopped, expired). */
  close(id: string, why?: string) {
    const l = this.listeners.get(id)
    for (const st of [...this.streams.values()]) if (st.share === id) this.abort(st, 410, why ? `the share ${why}` : "the share ended")
    if (!l) return
    this.listeners.delete(id)
    try {
      l.server.stop(true)
    } catch {}
  }

  closeAll() {
    for (const id of [...this.listeners.keys()]) this.close(id)
  }
}
