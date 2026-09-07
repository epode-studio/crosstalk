#!/usr/bin/env bun
// Posts a payload into a running Claude Code session's inbox socket.
//
//   bun spike/post.ts --pid 21227 --text "hello"
//   bun spike/post.ts --self --text "hello" --no-auth
//   bun spike/post.ts --pid 21227 --raw payload.json
//
// The docs say a connection that hasn't sent a complete line within 30s is
// closed, so the whole payload is built before the socket is opened.

import net from "node:net"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import crypto from "node:crypto"

const argv = process.argv.slice(2)
const arg = (flag: string, fallback?: string) => {
  const i = argv.indexOf(flag)
  return i === -1 ? fallback : argv[i + 1]
}
const has = (flag: string) => argv.includes(flag)

const SESSIONS = path.join(os.homedir(), ".claude", "sessions")
const text = arg("--text", "crosstalk probe: replay test")!
const from = arg("--from", "crosstalk")!
const shapeName = arg("--shape", "capture")!

// Captured from a real SendMessage on 2.1.263, see spike/README.md. The body
// is one newline-terminated JSON line. `from` is the sender's own inbox socket
// and doubles as the reply address; the receiving Claude sees only the
// <cross-session-message> wrapper.
const replyTo = arg("--reply-to", process.env.CLAUDE_CODE_MESSAGING_SOCKET ?? "")!
const mode = arg("--mode", "prompting")!

const wrapped = (attrs: string, body: string) =>
  `<cross-session-message ${attrs}>\n${body}\n</cross-session-message>`

const SHAPES: Record<string, unknown> = {
  // The captured shape, reproduced field for field.
  capture: {
    msgV: 1,
    msg_id: crypto.randomUUID(),
    type: "user",
    message: {
      role: "user",
      content: wrapped(
        `from="uds:${replyTo}" from-name="${from}" from-mode="${mode}"`,
        text,
      ),
    },
    priority: "next",
    from: `uds:${replyTo}`,
  },
  // No reply address, to see whether `from` is required for delivery.
  anonymous: {
    msgV: 1,
    msg_id: crypto.randomUUID(),
    type: "user",
    message: { role: "user", content: wrapped(`from-name="${from}"`, text) },
    priority: "next",
  },
  // Body with no wrapper at all, to see whether Claude Code adds one.
  bare: {
    msgV: 1,
    msg_id: crypto.randomUUID(),
    type: "user",
    message: { role: "user", content: text },
    priority: "next",
    from: `uds:${replyTo}`,
  },
}

function target(): { socket: string; pid: number } {
  if (has("--socket")) return { socket: arg("--socket")!, pid: -1 }
  if (has("--self")) {
    const s = process.env.CLAUDE_CODE_MESSAGING_SOCKET
    if (!s) throw new Error("CLAUDE_CODE_MESSAGING_SOCKET is not set in this shell")
    return { socket: s, pid: process.ppid }
  }
  const pid = Number(arg("--pid"))
  if (!pid) throw new Error("pass --pid <pid>, --self, or --socket <path>")
  const entry = JSON.parse(fs.readFileSync(path.join(SESSIONS, `${pid}.json`), "utf8"))
  if (!entry.messagingSocketPath) throw new Error(`session ${pid} has no messagingSocketPath`)
  return { socket: entry.messagingSocketPath, pid }
}

function token(pid: number): string | undefined {
  if (has("--no-auth")) return undefined
  if (has("--self") || pid === -1) return process.env.CLAUDE_CODE_MESSAGING_TOKEN
  const key = fs.readdirSync(SESSIONS).find((f) => f.startsWith(`${pid}.`) && f.endsWith(".key"))
  if (!key) return process.env.CLAUDE_CODE_MESSAGING_TOKEN
  try {
    return JSON.parse(fs.readFileSync(path.join(SESSIONS, key), "utf8")).peerToken
  } catch {
    return process.env.CLAUDE_CODE_MESSAGING_TOKEN
  }
}

const { socket, pid } = target()
const body = has("--raw")
  ? JSON.parse(fs.readFileSync(arg("--raw")!, "utf8"))
  : SHAPES[shapeName] ?? (() => { throw new Error(`unknown shape "${shapeName}"; have: ${Object.keys(SHAPES).join(", ")}`) })()

const tok = token(pid)
const payload =
  (tok ? JSON.stringify({ type: "auth", token: tok }) + "\n" : "") + JSON.stringify(body) + "\n"

console.log(`target   ${socket}`)
console.log(`auth     ${tok ? "yes" : "no"}`)
console.log(`body     ${JSON.stringify(body)}`)

const sock = net.createConnection(socket, () => {
  sock.write(payload, () => sock.end())
})
sock.on("data", (d) => console.log(`reply    ${d.toString("utf8").trim()}`))
sock.on("close", () => console.log("closed"))
sock.on("error", (e) => {
  console.error(`error    ${e.message}`)
  process.exit(1)
})
