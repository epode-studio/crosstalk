#!/usr/bin/env bun
// crosstalk CLI. The slash commands in commands/ call into this.
//
//   crosstalk pair [--host]          start pairing, print an invite
//   crosstalk pair ct1_…             accept an invite
//   crosstalk peers | status | cost | doctor
//   crosstalk policy [peer] [notify|deliver|quiet] [--allow-ask|--no-allow-ask]
//   crosstalk mute [peer] [minutes]
//   crosstalk relay start|stop|status
//   crosstalk daemon start|stop|restart

import {
  loadIdentity,
  saveIdentity,
  loadPeers,
  savePeers,
  loadPolicy,
  savePolicy,
  policyFor,
  loadRelay,
  saveRelay,
  secureIdentity,
  ROOT,
  P,
} from "./config.ts"
import { newIdentity, newPhrase, asPeer, fingerprint, seal, open } from "./crypto.ts"
import * as pake from "./pake.ts"
import { formatInvite, parseInvite } from "./invite.ts"
import {
  bestAddress,
  allAddresses,
  machineName,
  userName,
  whereToSay,
  expandAddress,
} from "./net.ts"
import { ensureDaemon, daemonRunning, request } from "./client.ts"
import { ensureCloudflared, openTunnel } from "./tunnel.ts"
import { summarise } from "./usage.ts"
import * as trust from "./trust.ts"
import * as facts from "./facts.ts"
import { rootFrom, shim } from "./paths.ts"
import fs from "node:fs"
import path from "node:path"
import os from "node:os"
import net from "node:net"
import { spawn, execFileSync } from "node:child_process"

const argv = process.argv.slice(2)
const cmd = argv[0] ?? "status"
const VALUE_FLAGS = new Set([
  "--for",
  "--label",
  "--phrase",
  "--relay",
  "--port",
  "--address",
  "--in",
  "--because",
  "--intent",
  "--source",
  "--text",
])
/**
 * The relay everyone uses unless they say otherwise. It runs as a Cloudflare
 * Worker, routes ciphertext, and holds no key that opens anything. Because
 * everyone is already pointed at it, an invite is four words and nothing else.
 *
 * Point somewhere else with --relay, or run your own: see deploy/ and worker/.
 */
const DEFAULT_RELAY = process.env.CROSSTALK_DEFAULT_RELAY ?? "wss://crosstalk-relay.billowing-poetry-4cd6.workers.dev"
const flag = (f: string, d?: string) => {
  const i = argv.indexOf(f)
  return i === -1 ? d : argv[i + 1]
}
const has = (f: string) => argv.includes(f)
const positional = (() => {
  const out: string[] = []
  for (let i = 1; i < argv.length; i++) {
    const a = argv[i]
    if (a.startsWith("--")) {
      if (VALUE_FLAGS.has(a)) i++
      continue
    }
    out.push(a)
  }
  return out
})()

const ROOT_DIR = rootFrom(import.meta.url)
const RELAY_PID = path.join(ROOT, "relay.pid")
const TUNNEL_PID = path.join(ROOT, "tunnel.pid")
const httpBase = (ws = loadRelay().url) => ws.replace(/^ws/, "http").replace(/\/ws$/, "")

const die = (m: string): never => {
  console.error(m)
  process.exit(1)
}

const ago = (ts: number) => {
  if (!ts) return "never"
  const s = Math.round((Date.now() - ts) / 1000)
  if (s < 60) return `${s}s ago`
  if (s < 3600) return `${Math.round(s / 60)}m ago`
  return `${Math.round(s / 3600)}h ago`
}

function identityOrCreate() {
  const existing = loadIdentity()
  if (existing) return existing
  const label = flag("--label") ?? userName()
  const id = { ...newIdentity(label), machine: machineName() }
  saveIdentity(id)
  console.log(`you are "${label}" on "${id.machine}"   ${fingerprint(id.ed.pub)}`)
  console.log(`change it any time with /crosstalk:rename me <name>`)
  return id
}

// --- relay ---------------------------------------------------------------------

const relayPid = (): number | null => {
  try {
    const pid = Number(fs.readFileSync(RELAY_PID, "utf8"))
    process.kill(pid, 0)
    return pid
  } catch {
    return null
  }
}

async function relayPubkey(url = loadRelay().url, ms = 2000): Promise<string | undefined> {
  try {
    const r = await fetch(`${httpBase(url)}/pubkey`, { signal: AbortSignal.timeout(ms) })
    if (!r.ok) return undefined
    return ((await r.json()) as { pub: string }).pub
  } catch {
    return undefined
  }
}

async function relayReachable(url = loadRelay().url, ms = 1500): Promise<boolean> {
  try {
    const c = AbortSignal.timeout(ms)
    const r = await fetch(`${httpBase(url)}/health`, { signal: c })
    return r.ok
  } catch {
    return false
  }
}

async function startRelay(port = Number(flag("--port", "8787"))): Promise<string> {
  if (has("--address")) process.env.CROSSTALK_ADDRESS = flag("--address")!
  const addr = bestAddress()
  if (relayPid()) {
    const url = loadRelay().url
    if (await relayReachable(url)) return url
  }
  const out = fs.openSync(path.join(ROOT, "relay.log"), "a")
  const child = spawn(shim(ROOT_DIR), ["relay", "--host", "0.0.0.0", "--port", String(port)], {
    detached: true,
    stdio: ["ignore", out, out],
  })
  child.unref()
  fs.mkdirSync(ROOT, { recursive: true, mode: 0o700 })
  fs.writeFileSync(RELAY_PID, String(child.pid), { mode: 0o600 })
  const url = `ws://${addr.host}:${port}`
  saveRelay(url)
  for (let i = 0; i < 40; i++) {
    if (await relayReachable(url, 500)) break
    await new Promise((r) => setTimeout(r, 100))
  }
  if (has("--public")) {
    const bin = await ensureCloudflared((n) => console.log(n))
    if (!bin)
      die(
        "could not get cloudflared, which --public needs.\nInstall it yourself (brew install cloudflared) and try again, or drop --public\nand pair on the same network.",
      )
    console.log("opening a public tunnel, this takes a few seconds")
    try {
      const t = await openTunnel(bin!, port, path.join(ROOT, "tunnel.log"))
      fs.writeFileSync(TUNNEL_PID, String(t.pid), { mode: 0o600 })
      saveRelay(`wss://${t.host}`)
      console.log(`relay reachable at ${t.url}`)
      return `wss://${t.host}`
    } catch (e) {
      die(`the tunnel did not come up: ${(e as Error).message}\nSee ${path.join(ROOT, "tunnel.log")}`)
    }
  }

  console.log(`relay running on ${url}   (${addr.kind}, ${addr.note})`)
  const others = allAddresses().filter((a) => a.host !== addr.host)
  if (others.length)
    console.log(
      `other addresses this machine has: ${others.map((a) => a.host).join(", ")}\nIf they cannot reach ${addr.host}, redo with --address <one of those>.`,
    )
  return url
}

async function relay() {
  const sub = positional[0] ?? "status"
  if (sub === "stop") {
    const pid = relayPid()
    if (!pid) return console.log("no relay started by crosstalk is running")
    process.kill(pid, "SIGTERM")
    fs.rmSync(RELAY_PID, { force: true })
    try {
      process.kill(Number(fs.readFileSync(TUNNEL_PID, "utf8")), "SIGTERM")
      fs.rmSync(TUNNEL_PID, { force: true })
      console.log("tunnel closed")
    } catch {}
    return console.log("relay stopped")
  }
  if (sub === "start") {
    await startRelay()
    return
  }
  const url = loadRelay().url
  console.log(`configured  ${url}`)
  console.log(`reachable   ${(await relayReachable(url)) ? "yes" : "no"}`)
  console.log(`local pid   ${relayPid() ?? "none started by crosstalk"}`)
}

// --- pairing -------------------------------------------------------------------

const myOffer = async (id: ReturnType<typeof identityOrCreate>) => ({
  label: id.label,
  machine: id.machine ?? machineName(),
  edPub: id.ed.pub,
  xPub: id.x.pub,
  // A watcher or a worker is a member like anyone else, except that nobody can
  // raise it past a notice however much they trust it.
  ...(has("--agent") ? { isMachine: true } : {}),
})

/**
 * Never replaces an existing peer, because a new key must not inherit the
 * settings you gave someone else. Two machines belonging to the same person
 * both inherit that person's name, so a clash takes a distinguishing suffix
 * rather than a refusal. Returns the name actually used.
 */
function adoptPeer(peer: ReturnType<typeof asPeer>): string {
  const peers = loadPeers()
  const taken = (name: string) => peers[name] && peers[name].fingerprint !== peer.fingerprint
  let label = peer.label

  if (taken(label)) {
    const byMachine = peer.machine ? `${peer.label}-${peer.machine}` : ""
    if (byMachine && !taken(byMachine)) label = byMachine
    else {
      let i = 2
      while (taken(`${peer.label}-${i}`)) i++
      label = `${peer.label}-${i}`
    }
    console.log(
      `\nYou already have a "${peer.label}" (${peers[peer.label].fingerprint}), so this one is "${label}".\nRename it with /crosstalk:rename ${label} <name>.`,
    )
  }

  peers[label] = { ...peer, label }
  savePeers(peers)
  return label
}

async function pair() {
  if (has("--relay")) saveRelay(flag("--relay")!)
  const id = identityOrCreate()
  const joining = positional.join(" ").trim()
  const base = () => httpBase(loadRelay().url)

  const put = async (slot: string, part: string, blob: string) => {
    const r = await fetch(`${base()}/pair/${slot}?part=${part}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ blob }),
    })
    if (!r.ok) die(`the relay would not take part ${part} (${r.status})`)
  }
  const get = async (slot: string, part: string, waitMs = 0): Promise<string | null> => {
    const deadline = Date.now() + waitMs
    for (;;) {
      const r = await fetch(`${base()}/pair/${slot}?part=${part}`).catch(() => null)
      if (r?.ok) return ((await r.json()) as { blob: string }).blob
      if (Date.now() >= deadline) return null
      await new Promise((res) => setTimeout(res, 1000))
    }
  }

  // --- accepting an invitation ------------------------------------------------
  if (joining) {
    const inv = parseInvite(joining)
    if (!inv.slot) die("that invite is missing its number. It looks like 4821-otter-basalt-thunder-anvil.")
    if (inv.where) {
      for (const candidate of expandAddress(inv.where, inv.port ?? 8787))
        if (await relayReachable(candidate, 3000)) {
          saveRelay(candidate)
          break
        }
    }
    if (!(await relayReachable())) die(`cannot reach a relay at ${base()}.`)

    const theirs = await get(inv.slot, "a")
    if (!theirs) die(`nothing is waiting on ${inv.slot}. Invites last fifteen minutes.`)

    const mine = pake.begin(inv.phrase, inv.slot)
    const key = pake.finish(mine, theirs, inv.slot, "crosstalk/pair/v4")
    if (!key) die("that invite could not be used. Check the words.")

    // Our identity, sealed to a key only someone with the same words can hold.
    await put(inv.slot, "b", mine.message + "." + seal(key, JSON.stringify(await myOffer(id))))

    const back = await get(inv.slot, "c", 120_000)
    if (!back) die("the other side never answered. Ask them to start again.")
    let peer
    try {
      peer = asPeer(JSON.parse(open(key, back)))
    } catch {
      return die("could not read what they sent. Somebody may be interfering; start again.")
    }
    const localName = adoptPeer(peer)
    peer.label = localName
    if ((peer as any).relayPub) saveRelay(loadRelay().url, (peer as any).relayPub)
    await ensureDaemon(ROOT_DIR)
    console.log(`
Paired with "${peer.label}"${peer.isMachine ? ", a machine rather than a person" : ""}.

  them  ${peer.fingerprint}
  you   ${fingerprint(id.ed.pub)}

Read both to each other. If they match, nobody is in the middle.

They start at "ask": they can put a line on your screen, and their agent can ask
yours a question. Their words never enter your session unless you raise them.

  /crosstalk:trust`)
    return
  }

  // --- offering one -----------------------------------------------------------
  const url = has("--host") ? await startRelay() : loadRelay().url
  if (!(await relayReachable(url)))
    die(`no relay at ${httpBase(url)}.\n\nRun this instead and crosstalk will host one for you:\n  /crosstalk:pair --host`)

  const slotRes = await fetch(`${httpBase(url)}/slot`, { method: "POST" }).catch(() => null)
  if (!slotRes?.ok) die("the relay would not give out a slot. Try again in a moment.")
  const { slot } = (await slotRes.json()) as { slot: string }

  const phrase = flag("--phrase") ?? newPhrase(4)
  const mine = pake.begin(phrase, slot)
  await put(slot, "a", mine.message)

  const asHttp = new URL(url.replace(/^ws/, "http"))
  const where =
    url === DEFAULT_RELAY ? null : `${asHttp.hostname}${asHttp.port ? ":" + asHttp.port : ""}`
  const invite = `${slot}-${phrase}${where ? ` at ${where}` : ""}`

  console.log(`
Tell them this:

    ${invite}

They run  /crosstalk:pair ${invite}

Say it out loud, or send it somewhere you already trust. The number is public;
the words are the secret. They work once and expire in fifteen minutes.

  you       ${id.label}  ${fingerprint(id.ed.pub)}
  reaches   ${where ? "same network" : "anywhere"}

Waiting…`)

  const theirs = await get(slot, "b", 900_000)
  if (!theirs) die("that invite expired without anyone using it")
  const dot = theirs.indexOf(".")
  const key = pake.finish(mine, theirs.slice(0, dot), slot, "crosstalk/pair/v4")
  if (!key) die("somebody tried to pair with the wrong words. Start again with a new invite.")

  let peer
  try {
    peer = asPeer(JSON.parse(open(key, theirs.slice(dot + 1))))
  } catch {
    return die("could not read what they sent. Somebody may be interfering; start again.")
  }
  if (peer.fingerprint === fingerprint(id.ed.pub)) die("that reply carries your own key")

  const relayPub = await relayPubkey(url)
  if (relayPub) saveRelay(url, relayPub)
  await put(slot, "c", seal(key, JSON.stringify({ ...(await myOffer(id)), relayPub })))

  peer.label = adoptPeer(peer)
  await ensureDaemon(ROOT_DIR)
  console.log(`
Paired with "${peer.label}"${peer.isMachine ? ", a machine rather than a person" : ""}.

  them  ${peer.fingerprint}
  you   ${fingerprint(id.ed.pub)}

Read both to each other. If they match, nobody is in the middle.

They start at "ask": a line on your screen, and their agent may ask yours a
question. Nothing they do puts their words inside your turn.

  /crosstalk:trust`)
}

// --- everything else -------------------------------------------------------------

async function peers() {
  if (!(await ensureDaemon(ROOT_DIR))) die("daemon is not running; see ~/.claude/crosstalk/daemon.log")
  const r = await request({ op: "peers" })
  console.log(`\nyou   ${r.me.label}   relay ${r.relay}`)
  for (const s of r.me.sessions) console.log(`      ${s.name}  ${s.cwd}  ${s.status}`)
  if (!r.peers.length) {
    console.log(`\nNo peers yet. Run /crosstalk:pair --host to invite someone.\n`)
    return
  }
  for (const p of r.peers) {
    const muted = p.policy.mutedUntil && p.policy.mutedUntil > Date.now()
    console.log(
      `\n${p.online ? "●" : "○"} ${p.label}${p.isMachine ? " (a machine)" : ""}  ${p.fingerprint}  ${p.policy.delivery}${muted ? " (muted)" : ""}${p.unread ? `  ${p.unread} unread` : ""}`,
    )
    if (!p.sessions.length) console.log(`      no sessions reported  (presence ${ago(p.presenceAt)})`)
    for (const s of p.sessions) console.log(`      ${s.name}  ${s.cwd}  ${s.status}  ${ago(s.lastSeen)}`)
  }
  console.log()
}

async function mute() {
  const peer = positional[0] && !/^\d+$/.test(positional[0]) ? positional[0] : undefined
  const minutes = Number(positional.find((a) => /^\d+$/.test(a)) ?? 60)
  await ensureDaemon(ROOT_DIR)
  const r = await request({ op: "mute", peer, minutes })
  console.log(
    r.mutedUntil
      ? `muted ${peer ?? "all peers"} until ${new Date(r.mutedUntil).toLocaleTimeString()}`
      : `unmuted ${peer ?? "all peers"}`,
  )
}

async function policy() {
  const mode = positional.find((a) => ["notify", "deliver", "quiet"].includes(a))
  const peer = positional.find((a) => a !== mode)
  const set: Record<string, unknown> = {}
  if (mode) set.delivery = mode
  if (has("--allow-ask")) set.allowAsk = true
  if (has("--no-allow-ask")) set.allowAsk = false

  if (!Object.keys(set).length) {
    const p = loadPolicy()
    console.log(`\ndefault   ${p.default.delivery}   ask ${p.default.allowAsk ? "allowed" : "off"}`)
    for (const label of Object.keys(loadPeers())) {
      const pp = policyFor(label, p)
      console.log(`${label.padEnd(10)}${pp.delivery}   ask ${pp.allowAsk ? "allowed" : "off"}`)
    }
    console.log(`
  notify    a notice appears; their words stay behind crosstalk_read  (default)
  deliver   their text lands in your session mid-turn
  quiet     held silently, surfaced when the session next goes idle

  Questions are allowed from people you paired with. Turn them off for someone
  with /crosstalk:policy <name> --no-allow-ask.
`)
    return
  }
  await ensureDaemon(ROOT_DIR)
  const r = await request({ op: "policy", peer, set })
  console.log(JSON.stringify(r.policy, null, 2))
}

async function cost() {
  const s = daemonRunning() ? await request({ op: "usage" }) : { ...summarise() }
  if (!s.rows?.length) return console.log("no crosstalk messages yet")
  console.log(`\npeer        sent   recvd   to Claude   ~tokens out   ~tokens in`)
  for (const r of s.rows) {
    console.log(
      `${r.peer.padEnd(12)}${String(r.sent).padEnd(7)}${String(r.received).padEnd(8)}${String(r.deliveredToClaude).padEnd(12)}${String(r.estTokensOut).padEnd(14)}${r.estTokensIn}`,
    )
  }
  console.log(
    `\nA delivered message costs the receiver a turn, like a prompt they typed.
Token figures are a rough estimate from message length, for orientation only.\n`,
  )
}

async function status() {
  const id = loadIdentity()
  if (!id) return console.log("crosstalk: not set up. Run /crosstalk:pair --host.")
  console.log(`identity  ${id.label}  ${fingerprint(id.ed.pub)}`)
  console.log(`relay     ${loadRelay().url}`)
  console.log(`peers     ${Object.keys(loadPeers()).join(", ") || "none"}`)
  if (!daemonRunning()) return console.log("daemon    not running")
  const r = await request({ op: "status" })
  console.log(`daemon    running, relay ${r.relay}`)
  for (const s of r.sessions) console.log(`          ${s.name}  ${s.cwd}`)
}

async function doctor() {
  const rows: [string, boolean | null, string][] = []
  const id = loadIdentity()
  const socket = process.env.CLAUDE_CODE_MESSAGING_SOCKET

  rows.push(["runtime", true, `${path.basename(process.execPath)} ${process.version ?? ""}`.trim()])
  rows.push(["identity", !!id, id ? `${id.label}  ${fingerprint(id.ed.pub)}` : "none, run /crosstalk:pair --host"])
  rows.push([
    "peers",
    Object.keys(loadPeers()).length > 0,
    Object.keys(loadPeers()).join(", ") || "none paired yet",
  ])
  rows.push(["inbox socket", !!socket && fs.existsSync(socket), socket ?? "CLAUDE_CODE_MESSAGING_SOCKET not set"])
  rows.push([
    "messaging token",
    !!process.env.CLAUDE_CODE_MESSAGING_TOKEN,
    process.env.CLAUDE_CODE_MESSAGING_TOKEN ? "present" : "missing, messages arrive as anonymous peers",
  ])

  const sessionsDir = path.join(process.env.HOME ?? "", ".claude", "sessions")
  let visible = 0
  try {
    visible = fs.readdirSync(sessionsDir).filter((f) => f.endsWith(".json")).length
  } catch {}
  rows.push(["session registry", visible > 0, `${visible} entries in ${sessionsDir}`])

  const relayUrl = loadRelay().url
  const reach = await relayReachable(relayUrl)
  rows.push(["relay", reach, relayUrl])
  if (relayPid()) {
    const addr = bestAddress()
    const all = allAddresses()
    rows.push([
      "relay is yours",
      true,
      `serving on all interfaces; hand out ${addr.host}${all.length > 1 ? `  (also have ${all.filter((a) => a.host !== addr.host).map((a) => a.host).join(", ")})` : ""}`,
    ])
    if (process.platform === "darwin") {
      let fw = ""
      try {
        fw = execFileSync("/usr/libexec/ApplicationFirewall/socketfilterfw", ["--getglobalstate"], {
          encoding: "utf8",
        }).trim()
      } catch {}
      const on = /State = 1|enabled/i.test(fw)
      rows.push([
        "macOS firewall",
        !on,
        on
          ? "on, which can silently drop the other machine's connection. Allow incoming for bun or node, or turn it off while pairing."
          : "off, incoming connections are not blocked",
      ])
    }
  }
  rows.push(["daemon", daemonRunning(), daemonRunning() ? "running" : "not running (starts on next session)"])

  if (daemonRunning()) {
    try {
      const s = await request({ op: "status" })
      rows.push(["daemon ↔ relay", s.relay === "connected", s.relay])
      rows.push(["registered sessions", s.sessions.length > 0, s.sessions.map((x: any) => x.name).join(", ") || "none"])
    } catch (e) {
      rows.push(["daemon ↔ relay", false, (e as Error).message])
    }
  }

  console.log()
  for (const [name, ok, detail] of rows) {
    console.log(`${ok === null ? "·" : ok ? "✓" : "✗"}  ${name.padEnd(20)} ${detail}`)
  }
  const bad = rows.filter(([, ok]) => ok === false)
  console.log(bad.length ? `\n${bad.length} thing(s) to fix above.\n` : `\nAll good.\n`)
}

async function daemon() {
  const sub = positional[0] ?? "start"
  if (sub === "stop" || sub === "restart") {
    try {
      process.kill(Number(fs.readFileSync(P.daemonLock, "utf8")), "SIGTERM")
      console.log("daemon stopped")
    } catch {
      console.log("daemon was not running")
    }
    if (sub === "stop") return
    await new Promise((r) => setTimeout(r, 500))
  }
  console.log((await ensureDaemon(ROOT_DIR)) ? "daemon running" : "daemon failed to start")
}

async function room() {
  await ensureDaemon(ROOT_DIR)
  const [verb, ...rest] = positional

  if (!verb || verb === "list") {
    const r = await request({ op: "rooms" })
    const direct = r.direct ?? []
    if (!r.rooms.length && !direct.length) {
      console.log(
        "\nYou are not in anything yet.\n\n  /crosstalk:pair --host          pair with someone, which makes a room of two\n  /crosstalk:room create beta     a room for several people\n",
      )
      return
    }
    console.log()
    if (direct.length) {
      for (const room of direct) console.log(`  ${room.name.padEnd(16)}just the two of you`)
    }
    for (const room of r.rooms) {
      const who = room.members
        .map((m: any) => m.label + (m.you ? " (you)" : "") + (m.state === "invited" ? " (invited)" : "") + (!m.paired && !m.you ? " ·not paired" : ""))
        .join(", ")
      if (room.pending) {
        console.log(`  #${room.name}   INVITATION from ${room.pending.invitedBy}`)
        console.log(`      ${who}`)
        console.log(`      accept:  /crosstalk:room accept ${room.name}`)
      } else {
        console.log(`  #${room.name}`.padEnd(18) + who)
      }
    }
    console.log()
    return
  }

  const say = (r: any, ok: string) => (r.ok ? console.log(ok) : die(r.error))

  switch (verb) {
    case "create": {
      const name = rest[0] ?? die("name the room: /crosstalk:room create beta")
      const r = await request({ op: "room_create", name })
      say(r, `created #${r.room}. Invite someone you are paired with:\n\n  /crosstalk:room invite ${r.room} <peer>\n`)
      return
    }
    case "invite": {
      const [name, ...people] = rest
      if (!name || !people.length) die("usage: /crosstalk:room invite beta marie jo")
      for (const p of people) {
        const r = await request({ op: "room_invite", room: name, peer: p })
        r.ok ? console.log(`invited ${r.invited} to #${r.room}`) : console.error(`${p}: ${r.error}`)
      }
      console.log("\nThey each have to accept before anything from the room reaches them.")
      return
    }
    case "accept":
    case "decline":
    case "leave": {
      const name = rest[0] ?? die(`usage: /crosstalk:room ${verb} beta`)
      const r = await request({ op: `room_${verb}`, room: name })
      say(r, verb === "accept" ? `joined #${r.room}` : `left #${r.room}`)
      return
    }
    case "kick":
    case "remove": {
      const [name, who] = rest
      if (!name || !who) die("usage: /crosstalk:room kick beta marie")
      const r = await request({ op: "room_kick", room: name, peer: who })
      if (!r.ok) die(r.error)
      console.log(`removed ${r.removed} from #${name} and rekeyed to epoch ${r.rekeyedTo}`)
      if (r.unreachable?.length)
        console.log(
          `\nCould not hand the new key to: ${r.unreachable.join(", ")}.\nYou are not paired with them, so someone who is has to pass it on.`,
        )
      return
    }
    default:
      die(`unknown: /crosstalk:room ${verb}\n\nTry: list, create, invite, accept, decline, leave, kick`)
  }
}

async function secure() {
  const r = secureIdentity()
  if (r.moved) {
    console.log(`
Your private key is in the macOS keychain now. ${P.identity} keeps only the
public half, so a process that reads your files no longer walks away with your
identity.

Undo with:  security delete-generic-password -a crosstalk -s crosstalk-identity
(after which you would have to pair again)`)
    return
  }
  console.log(`not moved: ${r.reason}`)
}

async function rename() {
  const [a, b] = positional

  // Your own label. Peers keep whatever name they gave you locally, so this
  // only affects how you introduce yourself to someone new.
  if (has("--me") || a === "me") {
    const to = (has("--me") ? a : b)?.trim()
    if (!to) die("usage: /crosstalk:rename me <newname>")
    const id = loadIdentity()
    if (!id) die("no identity yet")
    const was = id.label
    id.label = to
    saveIdentity(id)
    console.log(`you are "${to}" now, was "${was}".`)
    console.log("People you have already paired with keep the name they gave you.")
    if (daemonRunning()) console.log("Restart the daemon to advertise it: /crosstalk:status then crosstalk daemon restart")
    return
  }

  if (!a || !b) {
    const peers = loadPeers()
    console.log(`\nusage: /crosstalk:rename <current> <new>\n       /crosstalk:rename me <new>\n`)
    console.log(`known: ${Object.keys(peers).join(", ") || "nobody yet"}\n`)
    return
  }

  const peers = loadPeers()
  const peer = peers[a]
  if (!peer) die(`no peer called "${a}". Known: ${Object.keys(peers).join(", ") || "nobody"}`)
  if (peers[b]) die(`"${b}" is already someone else (${peers[b].fingerprint})`)

  delete peers[a]
  peers[b] = { ...peer, label: b }
  savePeers(peers)

  // Carry across everything else filed under the old name.
  const pol = loadPolicy()
  if (pol.peers[a]) {
    pol.peers[b] = pol.peers[a]
    delete pol.peers[a]
    savePolicy(pol)
  }
  try {
    const uPath = path.join(ROOT, "usage.json")
    const u = JSON.parse(fs.readFileSync(uPath, "utf8"))
    if (u[a]) {
      u[b] = u[a]
      delete u[a]
      fs.writeFileSync(uPath, JSON.stringify(u, null, 2), { mode: 0o600 })
    }
  } catch {}
  try {
    const qPath = path.join(ROOT, "queue.json")
    const q = JSON.parse(fs.readFileSync(qPath, "utf8"))
    let touched = 0
    for (const msgs of Object.values(q) as any[])
      for (const m of msgs) if (m.from === a) (m.from = b), touched++
    if (touched) fs.writeFileSync(qPath, JSON.stringify(q, null, 2), { mode: 0o600 })
  } catch {}

  console.log(`"${a}" is "${b}" now, still ${peer.fingerprint}.`)
  if (daemonRunning())
    console.log("Restart the daemon so it picks this up: crosstalk daemon restart")
}

async function trustCmd() {
  const t = trust.load()
  const level = positional.find((a) => trust.isLevel(a)) as trust.Level | undefined
  const who = positional.find((a) => a !== level)
  const room = flag("--in")

  if (!who && !level) {
    console.log()
    console.log(`  default${" ".repeat(12)}${t.default}`)
    const rooms = Object.entries(t.rooms)
    if (rooms.length) {
      console.log("\n  rooms")
      for (const [n, l] of rooms) console.log(`    #${n.padEnd(16)}${l}`)
    }
    const people = Object.entries(t.people)
    if (people.length) {
      console.log("\n  pinned people")
      for (const [n, l] of people) console.log(`    ${n.padEnd(17)}${l}`)
    }
    console.log("\n  levels, each including the ones before it\n")
    for (const l of trust.LEVELS) console.log(`    ${l.padEnd(10)}${trust.DESCRIPTION[l]}`)
    console.log(`
  /crosstalk:trust marie ask          pin a person
  /crosstalk:trust incident deliver   set a room, for everyone in it
  /crosstalk:trust marie mute --in ideas
`)
    return
  }

  if (!level) die(`give a level: ${trust.LEVELS.join(", ")}`)
  if (!who) {
    t.default = level
    trust.save(t)
    return console.log(`anyone you have paired with, by default: ${level}`)
  }

  // A name that matches a room you are in sets the room, unless --in says
  // otherwise or the name is someone you paired with.
  const isPerson = !!loadPeers()[who]
  if (room) {
    t.people[who] = level
    t.rooms[room] = t.rooms[room] ?? trust.ROOM_DEFAULT
    trust.save(t)
    return console.log(`${who} is "${level}" (pinned, so it applies in #${room} too)`)
  }
  if (isPerson) {
    t.people[who] = level
    trust.save(t)
    return console.log(`${who}: ${level}`)
  }
  t.rooms[who.replace(/^#/, "")] = level
  trust.save(t)
  console.log(`#${who.replace(/^#/, "")}: ${level} for everyone in it`)
}

/** Anything on this machine can put a line on your screen without pairing. */
async function post() {
  const text = positional.join(" ").trim() || flag("--text", "")!
  if (!text) die('usage: crosstalk post "build failed on main" [--intent blocking] [--source ci]')
  await ensureDaemon(ROOT_DIR)
  const r = await request({
    op: "post",
    text,
    intent: flag("--intent", "fyi"),
    source: flag("--source", "local"),
  })
  console.log(r.ok ? `posted as ${r.source}` : `not posted: ${r.error}`)
}

/** What has been spending your attention, and how much is left. */
async function attention() {
  await ensureDaemon(ROOT_DIR)
  const r = await request({ op: "attention" })
  console.log()
  console.log(`  budget       ${r.budget} an hour, ${r.used} used in the last hour`)
  console.log(`  held         ${r.held} waiting for you to go idle`)
  const rows = Object.entries(r.bySource ?? {}) as [string, number][]
  if (rows.length) {
    console.log()
    const most = Math.max(...rows.map(([, n]) => n))
    for (const [who, n] of rows.sort((a, b) => b[1] - a[1]))
      console.log(`  ${who.padEnd(14)}${String(n).padStart(3)}  ${"●".repeat(Math.ceil((n / most) * 10))}`)
  }
  console.log(`
  A message held quietly costs nothing and is not counted. Only what actually
  reached you is. Change who may reach you with /crosstalk:trust.
`)
}

async function tasksCmd() {
  await ensureDaemon(ROOT_DIR)
  const verb = positional[0]
  if (verb === "add") {
    const r = await request({
      op: "tasks",
      write: "add",
      text: positional.slice(1).join(" "),
      for: flag("--for"),
    })
    return console.log(r.ok ? `added ${r.id} to #${r.room}` : `not added: ${r.error}`)
  }
  if (verb === "claim" || verb === "done" || verb === "release" || verb === "drop") {
    const r = await request({
      op: "tasks",
      write: verb,
      id: positional[1],
      note: positional.slice(2).join(" ") || undefined,
    })
    return console.log(r.ok ? `${verb}: ${positional[1]}` : r.error ?? "nothing changed")
  }
  const r = await request({ op: "tasks" })
  const all = Object.entries(r.tasks ?? {}) as [string, any[]][]
  if (!all.some(([, t]) => t.length)) {
    console.log(`
  Nothing on the list.

    /crosstalk:tasks add "wire the upload retry" --for marie
`)
    return
  }
  for (const [room, list] of all) {
    if (!list.length) continue
    console.log(`\n  #${room}`)
    for (const t of list) {
      const who = t.state === "claimed" ? `claimed by ${t.claimedBy}` : t.for ? `for ${t.for}` : "open"
      console.log(`    ${t.id}  ${t.text}`)
      console.log(`${" ".repeat(12)}${who}, from ${t.by}`)
    }
  }
  console.log()
}

async function factsCmd() {
  await ensureDaemon(ROOT_DIR)
  const verb = positional[0]
  if (verb === "add" || verb === "remember") {
    const text = positional.slice(1).join(" ")
    const r = await request({ op: "facts", write: "add", text, tags: (flag("--in") ?? "").split(",").filter(Boolean) })
    return console.log(r.ok ? `remembered in #${r.room}` : `not saved: ${r.error}`)
  }
  if (verb === "confirm" || verb === "correct" || verb === "forget") {
    const map: Record<string, string> = { confirm: "confirm", correct: "supersede", forget: "remove" }
    const r = await request({
      op: "facts",
      write: map[verb],
      id: positional[1],
      text: positional.slice(2).join(" ") || undefined,
      reason: flag("--because"),
    })
    return console.log(r.ok ? `${verb}ed ${positional[1]}` : `nothing changed: ${r.error ?? "no such fact"}`)
  }
  const r = await request({ op: "facts", cwd: process.cwd() })
  const all = Object.entries(r.facts ?? {}) as [string, any[]][]
  const any = all.some(([, f]) => f.length)
  if (!any) {
    console.log(`
  Nothing written down yet.

    /crosstalk:facts add "the API returns snake_case"
    /crosstalk:facts add "uploads chunk at 4KB" --in palpable-fw
`)
    return
  }
  for (const [room, list] of all) {
    if (!list.length) continue
    console.log(`\n  #${room}`)
    for (const f of list) {
      const who = [f.by, ...f.confirmed.map((x: any) => x.by)]
      console.log(`    ${f.id}  ${f.text}`)
      console.log(`${" ".repeat(12)}${who.join(", ")}${f.tags.length ? "  in " + f.tags.join(", ") : ""}`)
    }
  }
  console.log()
}

/**
 * Your second machine should be you, not a second person.
 *
 * Pairing exchanges keys between two people. Linking copies one identity onto
 * another machine, so both answer to the same fingerprint and appear once in
 * every room. Messages arrive on whichever machine you are sitting at, because
 * the relay holds a mailbox per identity and delivers to every connection on it.
 *
 * The phrase here protects your whole identity rather than one introduction, so
 * it is six words instead of five and it should never leave the two machines.
 */
async function link() {
  const zlib = await import("node:zlib")
  const id = loadIdentity()
  const joining = positional.join(" ").trim()

  if (joining) {
    if (id)
      die(
        `this machine already has an identity ("${id.label}"). Linking would replace it,\nalong with everyone it is paired with. Move ~/.claude/crosstalk aside first if\nyou are sure.`,
      )
    const inv = parseInvite(joining)
    if (inv.where)
      for (const candidate of expandAddress(inv.where, inv.port ?? 8787))
        if (await relayReachable(candidate, 3000)) {
          saveRelay(candidate)
          break
        }
    if (!inv.slot) die("that link is missing its number. It looks like 4821-six-words-like-this.")
    const first = await fetch(`${httpBase()}/pair/${inv.slot}?part=a`)
    if (!first.ok) die("no link waiting on that number. They last fifteen minutes.")
    const theirPoint = ((await first.json()) as { blob: string }).blob

    const half = pake.begin(inv.phrase, inv.slot)
    const key = pake.finish(half, theirPoint, inv.slot, "crosstalk/link/v1")
    if (!key) die("could not use that link. Check the words.")
    await fetch(`${httpBase()}/pair/${inv.slot}?part=b`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ blob: half.message }),
    })

    let bundle: any
    for (let i = 0; i < 120; i++) {
      const r = await fetch(`${httpBase()}/pair/${inv.slot}?part=c`).catch(() => null)
      if (r?.ok) {
        try {
          const raw = JSON.parse(open(key, ((await r.json()) as { blob: string }).blob))
          bundle = JSON.parse(zlib.gunzipSync(Buffer.from(raw.z, "base64")).toString("utf8"))
        } catch {
          return die("could not read what came back. Start again.")
        }
        break
      }
      await new Promise((res) => setTimeout(res, 1000))
    }
    if (!bundle) die("the other machine never sent anything. Start again.")
    fs.mkdirSync(ROOT, { recursive: true, mode: 0o700 })
    const write = (name: string, value: unknown) =>
      fs.writeFileSync(path.join(ROOT, name), JSON.stringify(value, null, 2), { mode: 0o600 })
    write("identity.json", { ...bundle.identity, machine: machineName() })
    write("peers.json", bundle.peers ?? {})
    if (bundle.rooms) write("rooms.json", bundle.rooms)
    if (bundle.trust) write("trust.json", bundle.trust)
    if (bundle.relay) write("relay.json", bundle.relay)
    await ensureDaemon(ROOT_DIR)
    console.log(`
This machine is now "${bundle.identity.label}", the same one as your other machine.

  ${fingerprint(bundle.identity.ed.pub)}

Everyone you had paired with came across. In a room you appear once, not twice,
and a message reaches whichever machine you are sitting at.`)
    return
  }

  if (!id) die("nothing to link yet. Pair with someone first, or run this on the machine that already has your identity.")
  const url0 = loadRelay().url
  const slotRes = await fetch(`${httpBase(url0)}/slot`, { method: "POST" }).catch(() => null)
  if (!slotRes?.ok) die("the relay would not give out a slot. Try again in a moment.")
  const { slot } = (await slotRes.json()) as { slot: string }
  const phrase = newPhrase(6)
  const half = pake.begin(phrase, slot)
  const bundle = {
    identity: id,
    peers: loadPeers(),
    rooms: (() => { try { return JSON.parse(fs.readFileSync(path.join(ROOT, "rooms.json"), "utf8")) } catch { return {} } })(),
    trust: trust.load(),
    relay: loadRelay(),
  }
  const z = zlib.gzipSync(Buffer.from(JSON.stringify(bundle), "utf8")).toString("base64")
  const url = url0
  await fetch(`${httpBase(url)}/pair/${slot}?part=a`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ blob: half.message }),
  })
  console.log(`
On your other machine, run:

    /crosstalk:link ${slot}-${phrase}

Waiting…`)

  let key: Buffer | null = null
  for (let i = 0; i < 900; i++) {
    const r = await fetch(`${httpBase(url)}/pair/${slot}?part=b`).catch(() => null)
    if (r?.ok) {
      key = pake.finish(half, ((await r.json()) as { blob: string }).blob, slot, "crosstalk/link/v1")
      break
    }
    await new Promise((res) => setTimeout(res, 1000))
  }
  if (!key) die("the other machine never answered.")
  const sealed = seal(key, JSON.stringify({ z }))
  if (sealed.length > 8000)
    die("too much to send in one go. This happens with a lot of peers; copy ~/.claude/crosstalk across by hand instead.")
  const res = await fetch(`${httpBase(url)}/pair/${slot}?part=c`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ blob: sealed }),
  })
  if (!res.ok) die("the relay would not take it. Try again in a minute.")
  console.log(`
That machine is becoming this identity: same fingerprint, same people, same
rooms. Those six words carry your whole identity, so keep them between your own
two machines and nowhere else.`)
}

/**
 * Wires crosstalk into Google's Antigravity CLI.
 *
 * agy does not read the plugin format Claude Code and Codex share. It reads
 * `hooks.json` in a customization root, where the top level is a map of hook
 * names and each name holds handlers per lifecycle event. It also names no
 * event in the payload, so the event is passed as an argument instead.
 *
 * Only PreInvocation is registered. It runs before every model call, including
 * the ones between tool calls, so it is both where a session announces itself
 * and where a waiting message gets picked up mid-turn.
 */
async function installAgy() {
  const root = rootFrom(import.meta.url)
  const bin = shim(root)
  const dir = path.join(os.homedir(), ".gemini", "config")
  const file = path.join(dir, "hooks.json")
  fs.mkdirSync(dir, { recursive: true })

  // Anyone else's named hooks in this file are left exactly as they are.
  let all: Record<string, unknown> = {}
  if (fs.existsSync(file)) {
    try {
      all = JSON.parse(fs.readFileSync(file, "utf8"))
    } catch {
      die(`${file} is not valid JSON. Fix or move it, then run this again.`)
    }
  }
  all.crosstalk = {
    PreInvocation: [
      { type: "command", command: `"${bin}" hook PreInvocation`, timeout: 20 },
    ],
  }
  fs.writeFileSync(file, JSON.stringify(all, null, 2) + "\n")
  console.log(`hooks    ${file}`)

  // The tools, so an agy session can send and read rather than only receive.
  try {
    execFileSync("agy", ["mcp", "add", "crosstalk", bin, "server"], { stdio: "pipe" })
    console.log(`tools    registered with agy as "crosstalk"`)
  } catch (e: any) {
    const why = String(e?.stderr ?? e?.message ?? "").trim().split("\n")[0]
    console.log(`tools    not registered${why ? `: ${why}` : ""}`)
    console.log(`         run: agy mcp add crosstalk ${bin} server`)
  }

  console.log(`
agy has no session-start event, so a session announces itself on its first
model call rather than at launch. Start a new agy session, or send one prompt
in an existing one, and it will show up in \`crosstalk peers\`.

agy also runs a hook in the directory holding hooks.json, so it learns which
project a session is in from the workspace rather than the working directory.
If \`crosstalk facts\` looks unscoped, launch agy with --add-dir "$PWD".`)
}


/**
 * Qwen Code takes Claude Code's hook contract exactly: the same event names,
 * the same snake_case payload, the same hookSpecificOutput.additionalContext on
 * the way back. Only the file it reads is different.
 */
async function installQwen() {
  const bin = shim(rootFrom(import.meta.url))
  const dir = path.join(os.homedir(), ".qwen")
  const file = path.join(dir, "settings.json")
  fs.mkdirSync(dir, { recursive: true })

  let cfg: any = {}
  if (fs.existsSync(file)) {
    try {
      cfg = JSON.parse(fs.readFileSync(file, "utf8"))
    } catch {
      die(`${file} is not valid JSON. Fix or move it, then run this again.`)
    }
  }
  const entry = { hooks: [{ type: "command", command: `"${bin}" hook`, timeout: 20000 }] }
  cfg.hooks ??= {}
  for (const event of ["SessionStart", "UserPromptSubmit", "PostToolUse", "Stop"]) {
    const others = (cfg.hooks[event] ?? []).filter(
      (g: any) => !JSON.stringify(g).includes("crosstalk"),
    )
    cfg.hooks[event] = [...others, entry]
  }
  fs.writeFileSync(file, JSON.stringify(cfg, null, 2) + "\n")
  console.log(`hooks    ${file}`)
  console.log(`tools    add the MCP server: qwen mcp add crosstalk ${bin} server`)
}

/**
 * Kimi Code keeps hooks as a TOML array rather than a JSON tree, one table per
 * event, and reads back a plain `message` which it wraps in a <hook_result> tag
 * of its own. The hook writes that field alongside the others.
 */
async function installKimi() {
  const bin = shim(rootFrom(import.meta.url))
  const dir = path.join(os.homedir(), ".kimi-code")
  const file = path.join(dir, "config.toml")
  fs.mkdirSync(dir, { recursive: true })

  const existing = fs.existsSync(file) ? fs.readFileSync(file, "utf8") : ""
  // Drop any block this command wrote before, so running it twice is safe.
  const kept = existing.replace(/\n*# crosstalk\n(?:\[\[hooks\]\][^[]*)+/g, "\n")
  const blocks = ["SessionStart", "UserPromptSubmit", "PostToolUse", "Stop"]
    .map((event) => `[[hooks]]\nevent = "${event}"\ncommand = "${bin} hook"\ntimeout = 20\n`)
    .join("\n")
  fs.writeFileSync(file, `${kept.trimEnd()}\n\n# crosstalk\n${blocks}`)
  console.log(`hooks    ${file}`)
  console.log(`tools    add the MCP server in ${path.join(dir, "mcp.json")}`)
}

/** Everything a client needs, per client. */
async function install() {
  const who = (positional[0] ?? "").toLowerCase()
  if (who === "agy" || who === "antigravity") return installAgy()
  if (who === "qwen") return installQwen()
  if (who === "kimi") return installKimi()
  die(`usage: crosstalk install <agy|qwen|kimi>

Claude Code and Codex install as a plugin instead:
  /plugin marketplace add epode-studio/crosstalk
  /plugin install crosstalk@epode`)
}

const commands: Record<string, () => Promise<void>> = {
  pair,
  link,
  post,
  attention,
  facts: factsCmd,
  tasks: tasksCmd,
  rename,
  trust: trustCmd,
  room,
  secure,
  peers,
  mute,
  policy,
  cost,
  status,
  doctor,
  daemon,
  relay,
  install,
}
await (commands[cmd] ?? (async () => die(`unknown command "${cmd}"`)))()
