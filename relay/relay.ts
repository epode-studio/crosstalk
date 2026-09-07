#!/usr/bin/env bun
// Thin fan-out relay. It authenticates peers by Ed25519 challenge/response,
// routes sealed bodies by fingerprint, and buffers for offline peers. It never
// holds a key that can open a body.
//
//   bun relay/relay.ts [--port 8787] [--host 127.0.0.1]

import { verify, fingerprint } from "../src/crypto.ts"
import crypto from "node:crypto"
import fs from "node:fs"
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

type Conn = { fp?: string; label?: string; nonce: string; authed: boolean }

const live = new Map<string, Set<any>>() // fingerprint -> sockets
const buffered = new Map<
  string,
  { from: string; body: string; id: string; ts: number; roomId?: string }[]
>()
const seen = new Map<string, number>() // msg id -> ts, for duplicate suppression
const rate = new Map<string, number[]>() // fingerprint -> recent send timestamps

const log = (...a: unknown[]) => console.log(new Date().toISOString(), ...a)

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
      ws.send(
        JSON.stringify(
          m.roomId
            ? { t: "room_deliver", roomId: m.roomId, from: m.from, body: m.body, id: m.id }
            : { t: "deliver", from: m.from, body: m.body, id: m.id },
        ),
      )
      sent++
    }
  }
  if (sent) log(`drained ${sent} buffered to ${fp}`)
}

function announce(fp: string) {
  const online = [...live.keys()]
  for (const set of live.values())
    for (const ws of set) ws.send(JSON.stringify({ t: "presence", peers: online }))
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
    for (const ws of live.get(m.fingerprint) ?? [])
      ws.send(JSON.stringify({ t: "room", room: roster(room) }))
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
        for (const ws2 of live.get(me) ?? []) ws2.send(JSON.stringify({ t: "room_gone", roomId: room.id }))
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
      for (const ws2 of live.get(fp) ?? []) ws2.send(JSON.stringify({ t: "room_gone", roomId: room.id }))
      return true
    }
    case "room_list": {
      ws.send(
        JSON.stringify({
          t: "rooms",
          rooms: Object.values(roomState)
            .filter((x) => x.members[me])
            .map(roster),
        }),
      )
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
        const out = JSON.stringify({
          t: "room_deliver",
          roomId: room.id,
          from: me,
          body: f.body,
          id: f.id,
        })
        const targets = live.get(m.fingerprint)
        if (targets?.size) for (const t of targets) t.send(out)
        else {
          const key = `${m.fingerprint}|${me}`
          const q = buffered.get(key) ?? []
          q.push({ from: me, body: f.body, id: f.id, ts: Date.now(), roomId: room.id })
          buffered.set(key, q.slice(-MAX_BUFFERED_PER_SENDER))
        }
      }
      ws.send(JSON.stringify({ t: "ack", id: f.id }))
      return true
    }
  }
  return false
}

Bun.serve({
  port: PORT,
  hostname: HOST,
  async fetch(req, server) {
    const url = new URL(req.url)

    if (url.pathname === "/ws") {
      const ok = server.upgrade(req, {
        data: { nonce: crypto.randomBytes(24).toString("base64"), authed: false } as Conn,
      })
      return ok ? undefined : new Response("upgrade failed", { status: 400 })
    }

    if (url.pathname === "/health") return Response.json({ ok: true, online: live.size })

    const m = url.pathname.match(/^\/pair\/([A-Z0-9]{4,16})$/)
    if (m) {
      const code = m[1]
      const slot = (url.searchParams.get("side") === "reply" ? "reply" : "offer") as
        | "offer"
        | "reply"
      // A pairing phrase is only 32 bits, so the defence against guessing is
      // that a guess has to come through here. Only one request can test a
      // phrase: fetching the offer to try to decrypt it. Counting anything else
      // would throttle the inviter's own polling for the reply.
      if (req.method === "GET" && slot === "offer") {
        const who = server.requestIP(req)?.address ?? "unknown"
        const now = Date.now()
        const win = (pairRate.get(who) ?? []).filter((t) => now - t < 60_000)
        win.push(now)
        pairRate.set(who, win)
        if (win.length > 30)
          return Response.json({ error: "too many pairing attempts" }, { status: 429 })
      }
      if (req.method === "POST") {
        const { blob } = (await req.json()) as { blob: string }
        if (typeof blob !== "string" || blob.length > 8192)
          return Response.json({ error: "bad blob" }, { status: 400 })
        const e = offers.get(code) ?? { ts: Date.now() }
        if (e[slot]) return Response.json({ error: "slot already filled" }, { status: 409 })
        e[slot] = blob
        e.ts = Date.now()
        offers.set(code, e)
        return Response.json({ ok: true })
      }
      if (req.method === "GET") {
        const e = offers.get(code)
        if (!e?.[slot]) return Response.json({ error: "not ready" }, { status: 404 })
        return Response.json({ blob: e[slot] })
      }
    }

    return new Response("crosstalk relay", { status: 200 })
  },

  websocket: {
    open(ws) {
      const d = ws.data as Conn
      ws.send(JSON.stringify({ t: "challenge", nonce: d.nonce }))
    },

    message(ws, raw) {
      const d = ws.data as Conn
      let f: Frame
      try {
        f = JSON.parse(String(raw))
      } catch {
        return
      }

      if (f.t === "auth") {
        if (!verify(f.pub, d.nonce, f.sig)) {
          ws.send(JSON.stringify({ t: "error", message: "bad signature" }))
          return ws.close()
        }
        d.fp = fingerprint(f.pub)
        d.label = f.label
        d.authed = true
        if (!live.has(d.fp)) live.set(d.fp, new Set())
        live.get(d.fp)!.add(ws)
        ws.send(JSON.stringify({ t: "ready", fingerprint: d.fp }))
        log(`auth ${d.label} ${d.fp}`)
        drain(d.fp, ws)
        announce(d.fp)
        return
      }

      if (!d.authed) return

      if (f.t === "ping") return ws.send(JSON.stringify({ t: "pong" }))

      if (typeof f.t === "string" && f.t.startsWith("room_") && handleRoom(ws, d, f)) return

      if (f.t === "send") {
        if (!rateOk(d.fp!)) return ws.send(JSON.stringify({ t: "error", message: "rate limited" }))
        if (typeof f.body !== "string" || f.body.length > MAX_BODY)
          return ws.send(JSON.stringify({ t: "error", message: "body too large" }))
        if (seen.has(f.id)) return ws.send(JSON.stringify({ t: "ack", id: f.id }))
        seen.set(f.id, Date.now())

        const out = { t: "deliver", from: d.fp, body: f.body, id: f.id }
        const targets = live.get(f.to)
        if (targets?.size) {
          for (const t of targets) t.send(JSON.stringify(out))
        } else {
          const key = `${f.to}|${d.fp}`
          const q = buffered.get(key) ?? []
          q.push({ from: d.fp!, body: f.body, id: f.id, ts: Date.now() })
          buffered.set(key, q.slice(-MAX_BUFFERED_PER_SENDER))
        }
        ws.send(JSON.stringify({ t: "ack", id: f.id }))
      }
    },

    close(ws) {
      const d = ws.data as Conn
      if (!d.fp) return
      const set = live.get(d.fp)
      set?.delete(ws)
      if (set && !set.size) live.delete(d.fp)
      log(`closed ${d.label ?? "?"} ${d.fp}`)
      announce(d.fp)
    },
  },
})

log(`crosstalk relay on ws://${HOST}:${PORT}/ws`)
