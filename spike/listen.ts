#!/usr/bin/env bun
// Fake peer session. Registers itself the way Claude Code registers a real
// session, binds an inbox socket, and logs the exact bytes a real session
// sends when its Claude uses SendMessage.
//
// Usage: bun spike/listen.ts [--name crosstalk-probe] [--echo "text"]

import net from "node:net"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import crypto from "node:crypto"
import { execSync } from "node:child_process"

const argv = process.argv.slice(2)
const arg = (flag: string, fallback?: string) => {
  const i = argv.indexOf(flag)
  return i === -1 ? fallback : argv[i + 1]
}

const PID = process.pid
const NAME = arg("--name", "crosstalk-probe")!
const ECHO = arg("--echo")

const SOCK_DIR = "/tmp/cc-socks"
const SOCK = path.join(SOCK_DIR, `${PID}.sock`)
const SESSIONS = path.join(os.homedir(), ".claude", "sessions")
const ENTRY = path.join(SESSIONS, `${PID}.json`)
const CAPTURE = path.join(import.meta.dir, "capture")

if (fs.existsSync(ENTRY)) {
  console.error(`refusing to start: ${ENTRY} already exists (pid ${PID} is registered)`)
  process.exit(1)
}
fs.mkdirSync(CAPTURE, { recursive: true })
fs.mkdirSync(SOCK_DIR, { recursive: true })

const procStart = execSync(`ps -o lstart= -p ${PID}`).toString().trim()
const peerToken = crypto.randomBytes(16).toString("hex")
const sessionId = crypto.randomUUID()
const keyHash = crypto.createHash("sha256").update(`${PID}:${procStart}`).digest("hex")
const KEYFILE = path.join(SESSIONS, `${PID}.${keyHash}.key`)

// Field set copied from a real ~/.claude/sessions/<pid>.json on 2.1.263.
const entry = () => ({
  pid: PID,
  sessionId,
  cwd: process.cwd(),
  startedAt: Date.now(),
  procStart,
  version: "2.1.263",
  peerProtocol: 1,
  peerFeatures: ["notify_idle", "reply_across_default_dirs"],
  kind: "interactive",
  entrypoint: "cli",
  pidDomain: "darwin",
  messagingSocketPath: SOCK,
  name: NAME,
  nameSource: "derived",
  nameSince: Date.now(),
  status: "idle",
  updatedAt: Date.now(),
  statusUpdatedAt: Date.now(),
})

const writeEntry = () => fs.writeFileSync(ENTRY, JSON.stringify(entry()), { mode: 0o644 })
writeEntry()
fs.writeFileSync(KEYFILE, JSON.stringify({ peerToken, procStart, pidDomain: "darwin" }), { mode: 0o600 })

const logPath = path.join(CAPTURE, `${new Date().toISOString().replace(/[:.]/g, "-")}.log`)
const log = (s: string) => {
  process.stdout.write(s + "\n")
  fs.appendFileSync(logPath, s + "\n")
}

let conn = 0
const server = net.createServer((sock) => {
  const id = ++conn
  log(`\n=== connection ${id} @ ${new Date().toISOString()} ===`)
  const chunks: Buffer[] = []
  sock.on("data", (buf: Buffer) => {
    chunks.push(buf)
    log(`--- chunk (${buf.length} bytes) ---`)
    log(buf.toString("utf8"))
    log(`--- hex ---`)
    log(buf.toString("hex").replace(/(.{64})/g, "$1\n"))
    for (const line of buf.toString("utf8").split("\n")) {
      if (!line.trim()) continue
      try {
        log(`--- parsed ---\n${JSON.stringify(JSON.parse(line), null, 2)}`)
      } catch {
        log(`--- unparsed line ---\n${line}`)
      }
    }
    if (ECHO) {
      sock.write(ECHO + "\n")
      log(`--- echoed ---\n${ECHO}`)
    }
  })
  sock.on("close", () => log(`=== connection ${id} closed, ${Buffer.concat(chunks).length} bytes total ===`))
  sock.on("error", (e) => log(`=== connection ${id} error: ${e.message} ===`))
})

try {
  fs.unlinkSync(SOCK)
} catch {}
server.listen(SOCK, () => {
  fs.chmodSync(SOCK, 0o600)
  log(`listening   ${SOCK}`)
  log(`registered  ${ENTRY} as "${NAME}"`)
  log(`key file    ${KEYFILE}`)
  log(`capture     ${logPath}`)
  log(`\nIn another terminal: claude, then /list-agents, then ask it to message ${NAME}.`)
})

const heartbeat = setInterval(writeEntry, 5000)

let cleaned = false
const cleanup = () => {
  if (cleaned) return
  cleaned = true
  clearInterval(heartbeat)
  for (const f of [ENTRY, KEYFILE, SOCK]) {
    try {
      fs.unlinkSync(f)
    } catch {}
  }
  console.log("\ncleaned up registry entry, key file and socket")
}
process.on("exit", cleanup)
for (const sig of ["SIGINT", "SIGTERM", "SIGHUP"] as const) {
  process.on(sig, () => {
    cleanup()
    process.exit(0)
  })
}
