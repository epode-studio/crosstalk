// A minimal RFC 6455 server, so the relay has no dependency to bundle.
//
// `ws` refuses to inline into a single file, which meant a machine that
// installed the plugin could not run its own relay: dist/relay.js still had a
// bare import of it. The wire format here is ordinary WebSocket, so proxies and
// hosts that special-case websockets keep working, and the client stays on the
// global WebSocket that both Bun and Node provide.
//
// Only what a relay needs: text frames, fragmentation, ping, pong and close.

import crypto from "node:crypto"
import type { IncomingMessage } from "node:http"
import type { Socket as TcpSocket } from "node:net"

const GUID = "258EAFA5-E914-47DA-95CA-C5AB0DC85B11"

export type Socket = {
  send: (text: string) => void
  close: () => void
  remoteAddress?: string
  data?: unknown
  onMessage?: (text: string) => void
  onClose?: () => void
}

const accept = (key: string) =>
  crypto.createHash("sha1").update(key + GUID).digest("base64")

/** Server frames are never masked. Payloads over 64 KiB use the 64-bit length. */
function frame(opcode: number, payload: Buffer): Buffer {
  const len = payload.length
  let header: Buffer
  if (len < 126) {
    header = Buffer.alloc(2)
    header[1] = len
  } else if (len < 65536) {
    header = Buffer.alloc(4)
    header[1] = 126
    header.writeUInt16BE(len, 2)
  } else {
    header = Buffer.alloc(10)
    header[1] = 127
    header.writeBigUInt64BE(BigInt(len), 2)
  }
  header[0] = 0x80 | opcode // FIN plus opcode
  return Buffer.concat([header, payload])
}

export function upgrade(
  req: IncomingMessage,
  socket: TcpSocket,
  head: Buffer,
  maxPayload = 4 << 20,
): Socket | null {
  const key = req.headers["sec-websocket-key"]
  if (typeof key !== "string" || (req.headers.upgrade ?? "").toLowerCase() !== "websocket") {
    socket.end("HTTP/1.1 400 Bad Request\r\n\r\n")
    return null
  }

  socket.write(
    "HTTP/1.1 101 Switching Protocols\r\n" +
      "Upgrade: websocket\r\n" +
      "Connection: Upgrade\r\n" +
      `Sec-WebSocket-Accept: ${accept(key)}\r\n\r\n`,
  )
  socket.setNoDelay(true)

  const ws: Socket = {
    remoteAddress: socket.remoteAddress,
    send(text) {
      if (socket.writable) socket.write(frame(0x1, Buffer.from(text, "utf8")))
    },
    close() {
      if (socket.writable) socket.write(frame(0x8, Buffer.alloc(0)))
      socket.end()
    },
  }

  let buf: Buffer = head?.length ? Buffer.from(head) : Buffer.alloc(0)
  // A message split across frames arrives as one continuation chain.
  let fragments: Buffer[] = []
  let fragmentOpcode = 0

  const fail = () => {
    try {
      socket.destroy()
    } catch {}
  }

  socket.on("data", (chunk: Buffer) => {
    buf = buf.length ? Buffer.concat([buf, chunk]) : chunk

    for (;;) {
      if (buf.length < 2) return
      const fin = (buf[0] & 0x80) !== 0
      const opcode = buf[0] & 0x0f
      const masked = (buf[1] & 0x80) !== 0
      let len = buf[1] & 0x7f
      let offset = 2

      if (len === 126) {
        if (buf.length < 4) return
        len = buf.readUInt16BE(2)
        offset = 4
      } else if (len === 127) {
        if (buf.length < 10) return
        const big = buf.readBigUInt64BE(2)
        if (big > BigInt(maxPayload)) return fail()
        len = Number(big)
        offset = 10
      }
      if (len > maxPayload) return fail()

      // Every frame from a client must be masked.
      if (!masked) return fail()
      if (buf.length < offset + 4 + len) return
      const mask = buf.subarray(offset, offset + 4)
      const payload = Buffer.allocUnsafe(len)
      for (let i = 0; i < len; i++) payload[i] = buf[offset + 4 + i] ^ mask[i & 3]
      buf = buf.subarray(offset + 4 + len)

      if (opcode === 0x8) {
        ws.close()
        return
      }
      if (opcode === 0x9) {
        if (socket.writable) socket.write(frame(0xa, payload))
        continue
      }
      if (opcode === 0xa) continue // pong, nothing to do

      if (opcode === 0x0) {
        fragments.push(payload)
      } else {
        fragments = [payload]
        fragmentOpcode = opcode
      }

      if (!fin) continue
      const whole = fragments.length === 1 ? fragments[0] : Buffer.concat(fragments)
      fragments = []
      if (fragmentOpcode === 0x1) ws.onMessage?.(whole.toString("utf8"))
    }
  })

  socket.on("close", () => ws.onClose?.())
  socket.on("error", () => ws.onClose?.())
  return ws
}
