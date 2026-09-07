#!/usr/bin/env bun
// Thin fan-out relay. It authenticates peers by Ed25519 challenge/response,
// routes sealed bodies by fingerprint, and buffers for offline peers. It never
// holds a key that can open a body.
//
//   bun relay/relay.ts [--port 8787] [--host 127.0.0.1]

import { fingerprint } from "../src/crypto.ts"
import { Channel, derive, newEd25519, newEphemeral, signWith, transcript, verifyWith } from "../src/link.ts"
import crypto from "node:crypto"
import fs from "node:fs"
import http from "node:http"
import { WebSocketServer } from "ws"
import type { Frame } from "../src/protocol.ts"

const argv = process.argv.slice(2)
const arg = (f: string, d: string) => {
  const i = argv.indexOf(f)
  return i === -1 ? d : argv[i + 1]
}

const PORT = Number(arg("--port", process.env.PORT ?? "8787"))
const HOST = arg("--host", "127.0.0.1")
const BUFFER_TTL_MS = 24 * 60 * 60 * 1000
// Per (recipient, sender). One peer filling their own queue must not displace
// what a recipient's other peers are waiting to deliver.
const MAX_BUFFERED_PER_SENDER = 200
const MAX_BODY = 1 << 20

type Conn = {
  fp?: string
  label?: string
  nonce: string
  authed: boolean
  eph?: ReturnType<typeof newEphemeral>
  ch?: Channel
}

const live = new Map<string, Set<any>>() // fingerprint -> sockets
const buffered = new Map<
  string,
  { from: string; body: string; id: string; ts: number; roomId?: string }[]
>()
const seen = new Map<string, number>() // msg id -> ts, for duplicate suppression
const rate = new Map<string, number[]>() // fingerprint -> recent send timestamps

const log = (...a: unknown[]) => console.log(new Date().toISOString(), ...a)

/** Send a protocol frame over a connection's encrypted channel. */
function send(ws: any, frame: unknown) {
  const d = ws.data as Conn
  if (!d.ch) return
  try {
    ws.send(d.ch.seal(frame))
  } catch {}
}

function sweep() {
  const now = Date.now()
  for (const [key, q] of buffered) {
    const kept = q.filter((m) => now - m.ts < BUFFER_TTL_MS)
    if (kept.length) buffered.set(key, kept)
    else buffered.delete(key)
  }
  for (const [id, ts] of seen) if (now - ts > 10 * 60_000) seen.delete(id)
}
setInterval(sweep, 60_000)

function rateOk(fp: string): boolean {
  const now = Date.now()
  const win = (rate.get(fp) ?? []).filter((t) => now - t < 60_000)
  win.push(now)
  rate.set(fp, win)
  return win.length <= 60
}

function drain(fp: string, ws: any) {
  let sent = 0
  for (const [key, q] of [...buffered]) {
    if (!key.startsWith(`${fp}|`)) continue
    buffered.delete(key)
    for (const m of q) {
      send(
        ws,
        m.roomId
          ? { t: "room_deliver", roomId: m.roomId, from: m.from, body: m.body, id: m.id }
          : { t: "deliver", from: m.from, body: m.body, id: m.id },
      )
      sent++
    }
  }
  if (sent) log(`drained ${sent} buffered to ${fp}`)
}

function announce(fp: string) {
  const online = [...live.keys()]
  for (const set of live.values())
    for (const ws of set) send(ws, { t: "presence", peers: online })
}

// Pairing offers, held briefly and encrypted under a passphrase the relay
// never sees. Two slots per code: the initiator's offer and the joiner's reply.
const offers = new Map<string, { offer?: string; reply?: string; ts: number }>()
const pairRate = new Map<string, number[]>()
setInterval(() => {
  const now = Date.now()
  for (const [k, v] of pairRate) {
    const win = v.filter((t) => now - t < 60_000)
    if (win.length) pairRate.set(k, win)
    else pairRate.delete(k)
  }
}, 60_000)
setInterval(() => {
  const now = Date.now()
  for (const [k, v] of offers) if (now - v.ts > 15 * 60_000) offers.delete(k)
}, 60_000)


// --- rooms -------------------------------------------------------------------
// The relay holds the roster so every member sees the same one, and copies
// ciphertext to it. It never holds a room key. Membership changes are only
// accepted from a joined member of that room.

type RelayMember = {
  fingerprint: string
  label: string
  addedBy: string
  addedAt: number
  state: "invited" | "joined"
}
type RelayRoom = {
  id: string
  name: string
  createdBy: string
  createdAt: number
  members: Record<string, RelayMember>
}

const IDENTITY_FILE = process.env.CROSSTALK_RELAY_IDENTITY ?? "./crosstalk-relay-identity.json"
const relayIdentity = (() => {
  try {
    return JSON.parse(fs.readFileSync(IDENTITY_FILE, "utf8"))
  } catch {
    const k = newEd25519()
    fs.writeFileSync(IDENTITY_FILE, JSON.stringify(k), { mode: 0o600 })
    return k
  }
})()

const ROOMS_FILE = process.env.CROSSTALK_RELAY_STATE ?? "./crosstalk-rooms.json"
const roomState: Record<string, RelayRoom> = (() => {
  try {
    return JSON.parse(fs.readFileSync(ROOMS_FILE, "utf8"))
  } catch {
    return {}
  }
})()
const saveRooms = () => {
  try {
    fs.writeFileSync(ROOMS_FILE, JSON.stringify(roomState), { mode: 0o600 })
  } catch {}
}

const joined = (room: RelayRoom, fp: string) => room.members[fp]?.state === "joined"

const roster = (room: RelayRoom) => ({
  id: room.id,
  name: room.name,
  members: Object.values(room.members).map((m) => ({
    fingerprint: m.fingerprint,
    label: m.label,
    addedBy: m.addedBy,
    state: m.state,
  })),
})

/** Tell every connected member of a room that its roster moved. */
function announceRoom(room: RelayRoom) {
  for (const m of Object.values(room.members)) {
    for (const ws of live.get(m.fingerprint) ?? []) send(ws, { t: "room", room: roster(room) })
  }
}

function handleRoom(ws: any, d: Conn, f: any): boolean {
  const me = d.fp!
  switch (f.t) {
    case "room_create": {
      const id = String(f.id ?? "").slice(0, 32)
      if (!id || roomState[id]) return true
      roomState[id] = {
        id,
        name: String(f.name ?? "room").slice(0, 64),
        createdBy: me,
        createdAt: Date.now(),
        members: {
          [me]: { fingerprint: me, label: d.label ?? "?", addedBy: me, addedAt: Date.now(), state: "joined" },
        },
      }
      saveRooms()
      announceRoom(roomState[id])
      return true
    }
    case "room_invite": {
      const room = roomState[f.roomId]
      if (!room || !joined(room, me)) return true
      const fp = String(f.fingerprint ?? "")
      if (!fp || room.members[fp]) return true
      room.members[fp] = {
        fingerprint: fp,
        label: String(f.label ?? "?").slice(0, 64),
        addedBy: me,
        addedAt: Date.now(),
        state: "invited",
      }
      saveRooms()
      announceRoom(room)
      return true
    }
    case "room_accept":
    case "room_decline":
    case "room_leave": {
      const room = roomState[f.roomId]
      if (!room || !room.members[me]) return true
      if (f.t === "room_accept") room.members[me].state = "joined"
      else delete room.members[me]
      // Announce before dropping the last member, then clean up.
      announceRoom(room)
      if (f.t !== "room_accept")
        for (const ws2 of live.get(me) ?? []) send(ws2, { t: "room_gone", roomId: room.id })
      if (!Object.keys(room.members).length) delete roomState[room.id]
      saveRooms()
      return true
    }
    case "room_kick": {
      const room = roomState[f.roomId]
      const fp = String(f.fingerprint ?? "")
      if (!room || !joined(room, me) || !room.members[fp] || fp === me) return true
      delete room.members[fp]
      saveRooms()
      announceRoom(room)
      for (const ws2 of live.get(fp) ?? []) send(ws2, { t: "room_gone", roomId: room.id })
      return true
    }
    case "room_list": {
      send(ws, {
        t: "rooms",
        rooms: Object.values(roomState)
          .filter((x) => x.members[me])
          .map(roster),
      })
      return true
    }
    case "room_send": {
      const room = roomState[f.roomId]
      if (!room || !joined(room, me)) return true
      if (!rateOk(me)) return true
      if (typeof f.body !== "string" || f.body.length > MAX_BODY) return true
      if (seen.has(f.id)) return true
      seen.set(f.id, Date.now())
      for (const m of Object.values(room.members)) {
        if (m.fingerprint === me || m.state !== "joined") continue
        const out = { t: "room_deliver", roomId: room.id, from: me, body: f.body, id: f.id }
        const targets = live.get(m.fingerprint)
        if (targets?.size) for (const t of targets) send(t, out)
        else {
          const key = `${m.fingerprint}|${me}`
          const q = buffered.get(key) ?? []
          q.push({ from: me, body: f.body, id: f.id, ts: Date.now(), roomId: room.id })
          buffered.set(key, q.slice(-MAX_BUFFERED_PER_SENDER))
        }
      }
      send(ws, { t: "ack", id: f.id })
      return true
    }
  }
  return false
}

function onMessage(ws: any, raw: string) {

  const d = ws.data as Conn

  // The handshake frame is the only plaintext one. Everything after it is
  // sealed to the link keys.
  if (!d.authed) {
let f: any
try {
  f = JSON.parse(String(raw))
} catch {
  return ws.close()
}
if (f.t !== "hello" || !f.ephPub || !f.pub || !f.sig) return ws.close()
const t = transcript(d.eph!.pub, f.ephPub, d.nonce)
if (!verifyWith(f.pub, t, f.sig)) {
  ws.send(JSON.stringify({ t: "error", message: "bad signature" }))
  return ws.close()
}
d.ch = new Channel(derive(d.eph!.key, f.ephPub, t, "relay"))
d.fp = fingerprint(f.pub)
d.label = f.label
d.authed = true
if (!live.has(d.fp)) live.set(d.fp, new Set())
live.get(d.fp)!.add(ws)
// The relay's own signature travels inside the channel, which the client
// can only open if the relay held the matching ephemeral private key.
send(ws, { t: "ready", fingerprint: d.fp, sig: signWith(relayIdentity.priv, t) })
log(`link up ${d.label} ${d.fp}`)
drain(d.fp, ws)
announce(d.fp)
return
  }

  let f: Frame
  try {
f = d.ch!.open(String(raw)) as Frame
  } catch {
log(`bad frame from ${d.label ?? "?"}; closing`)
return ws.close()
  }

  if (f.t === "ping") return send(ws, { t: "pong" })

  if (typeof f.t === "string" && f.t.startsWith("room_") && handleRoom(ws, d, f)) return

  if (f.t === "send") {
if (!rateOk(d.fp!)) return send(ws, { t: "error", message: "rate limited" })
if (typeof f.body !== "string" || f.body.length > MAX_BODY)
  return send(ws, { t: "error", message: "body too large" })
if (seen.has(f.id)) return send(ws, { t: "ack", id: f.id })
seen.set(f.id, Date.now())

const out = { t: "deliver", from: d.fp, body: f.body, id: f.id }
const targets = live.get(f.to)
if (targets?.size) {
  for (const t of targets) send(t, out)
} else {
  const key = `${f.to}|${d.fp}`
  const q = buffered.get(key) ?? []
  q.push({ from: d.fp!, body: f.body, id: f.id, ts: Date.now() })
  buffered.set(key, q.slice(-MAX_BUFFERED_PER_SENDER))
}
send(ws, { t: "ack", id: f.id })
  }

}

function onClose(ws: any) {

  const d = ws.data as Conn
  if (!d.fp) return
  const set = live.get(d.fp)
  set?.delete(ws)
  if (set && !set.size) live.delete(d.fp)
  log(`closed ${d.label ?? "?"} ${d.fp}`)
  announce(d.fp)
}

const httpServer = http.createServer((req, res) => {
  const url = new URL(req.url ?? "/", `http://${req.headers.host ?? "localhost"}`)
  const json = (body: unknown, status = 200) => {
    const s = JSON.stringify(body)
    res.writeHead(status, { "content-type": "application/json", "content-length": Buffer.byteLength(s) })
    res.end(s)
  }

  if (url.pathname === "/health") return json({ ok: true, online: live.size })

  // Clients pin this. It also travels inside the pairing offer, sealed under
  // the phrase, so an attacker who can rewrite traffic cannot substitute it.
  if (url.pathname === "/pubkey") return json({ pub: relayIdentity.pub })

  const m = url.pathname.match(/^\/pair\/([A-Z0-9]{4,16})$/)
  if (m) {
    const code = m[1]
    const slot = (url.searchParams.get("side") === "reply" ? "reply" : "offer") as "offer" | "reply"

    // A pairing phrase is only 32 bits, so the defence against guessing is that
    // a guess has to come through here. Only one request can test a phrase:
    // fetching the offer to try to decrypt it. Counting anything else would
    // throttle the inviter's own polling for the reply.
    if (req.method === "GET" && slot === "offer") {
      const who = req.socket.remoteAddress ?? "unknown"
      const now = Date.now()
      const win = (pairRate.get(who) ?? []).filter((t) => now - t < 60_000)
      win.push(now)
      pairRate.set(who, win)
      if (win.length > 30) return json({ error: "too many pairing attempts" }, 429)
    }

    if (req.method === "POST") {
      let raw = ""
      req.on("data", (c) => {
        raw += c
        if (raw.length > 16384) req.destroy()
      })
      req.on("end", () => {
        let blob: unknown
        try {
          blob = (JSON.parse(raw) as { blob: string }).blob
        } catch {
          return json({ error: "bad body" }, 400)
        }
        if (typeof blob !== "string" || blob.length > 8192) return json({ error: "bad blob" }, 400)
        const e = offers.get(code) ?? { ts: Date.now() }
        // Write once. Otherwise anyone holding the code can keep replacing the
        // offer and stop the pairing from ever completing.
        if (e[slot]) return json({ error: "slot already filled" }, 409)
        e[slot] = blob
        e.ts = Date.now()
        offers.set(code, e)
        json({ ok: true })
      })
      return
    }

    if (req.method === "GET") {
      const e = offers.get(code)
      if (!e?.[slot]) return json({ error: "not ready" }, 404)
      return json({ blob: e[slot] })
    }
  }

  res.writeHead(200, { "content-type": "text/plain" })
  res.end("crosstalk relay")
})

const wss = new WebSocketServer({ server: httpServer, path: "/ws" })

wss.on("connection", (ws: any) => {
  const d: Conn = {
    nonce: crypto.randomBytes(24).toString("base64"),
    authed: false,
    eph: newEphemeral(),
  }
  ws.data = d
  ws.send(JSON.stringify({ t: "hello", ephPub: d.eph!.pub, nonce: d.nonce }))

  ws.on("message", (raw: any) => onMessage(ws, String(raw)))
  ws.on("close", () => onClose(ws))
  ws.on("error", () => {})
})

httpServer.listen(PORT, HOST, () => log(`crosstalk relay on ws://${HOST}:${PORT}/ws`))
