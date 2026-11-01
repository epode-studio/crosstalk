// Writes a peer message raw into a session's inbox socket, as src/inject.ts does.
//   bun spike/mod/run/peer.ts <CLAUDE_CONFIG_DIR> <text>
import fs from "node:fs"
import path from "node:path"
import { injectMessage } from "../../../src/inject.ts"

const [cfg, text] = process.argv.slice(2)
const dir = path.join(cfg!, "sessions")
const entry = fs
  .readdirSync(dir)
  .filter(f => /^\d+\.json$/.test(f))
  .map(f => JSON.parse(fs.readFileSync(path.join(dir, f), "utf8")))
  .sort((a, b) => b.startedAt - a.startedAt)[0]
if (!entry?.messagingSocketPath) throw new Error(`no inbox socket in ${dir}`)
await injectMessage(
  { socket: entry.messagingSocketPath, fromName: "marie/api" },
  { peer: "marie", peerSession: "api", intent: "ask", text: text!, id: crypto.randomUUID() },
)
console.log(`sent to ${entry.messagingSocketPath} (pid ${entry.pid}, session ${entry.sessionId})`)
