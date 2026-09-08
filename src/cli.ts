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
import { newIdentity, newPhrase, codeForPhrase, sealOffer, openOffer, asPeer, fingerprint } from "./crypto.ts"
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
import { rootFrom, shim } from "./paths.ts"
import fs from "node:fs"
import path from "node:path"
import net from "node:net"
import { spawn, execFileSync } from "node:child_process"

const argv = process.argv.slice(2)
const cmd = argv[0] ?? "status"
const VALUE_FLAGS = new Set(["--label", "--phrase", "--relay", "--port", "--address"])
/** Set this to a relay you host, and an invite becomes four words and nothing else. */
const DEFAULT_RELAY = process.env.CROSSTALK_DEFAULT_RELAY ?? ""
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

  // Accepting an invite.
  if (joining) {
    const inv = parseInvite(joining)
    const code = codeForPhrase(inv.phrase)

    if (inv.where) {
      const port = inv.port ?? 8787
      const tried: string[] = []
      let found: string | null = null
      for (const candidate of expandAddress(inv.where, port)) {
        tried.push(candidate)
        if (await relayReachable(candidate, 3000)) {
          found = candidate
          break
        }
      }
      if (!found)
        die(
          `nothing is answering as "${inv.where}".\n\nTried: ${tried.join(", ")}\n\nTheir machine has to be awake, and you have to be able to reach it: the same\nnetwork, or both on the same tailnet. Ask them what /crosstalk:pair --host\nprinted, including the part after "at".`,
        )
      saveRelay(found)
    }

    if (!(await relayReachable()))
      die(`cannot reach a relay at ${httpBase()}.`)

    const r = await fetch(`${httpBase()}/pair/${code}?side=offer`)
    if (!r.ok)
      die(
        r.status === 429
          ? "the relay is rate-limiting pairing attempts; wait a minute"
          : `no invite matches "${inv.phrase}". Check the words, or ask for a new one, invites last 15 minutes.`,
      )
    const { blob } = (await r.json()) as { blob: string }
    let peer, offerRelayPub: string | undefined
    try {
      const raw = openOffer(inv.phrase, blob)
      offerRelayPub = raw.relayPub
      peer = asPeer(raw)
    } catch {
      return die(`could not open that invite. The words are probably slightly off.`)
    }

    const localName = adoptPeer(peer)
    peer.label = localName
    // Pin the relay identity that came inside the sealed offer, so nothing on
    // the network can pass itself off as this relay later.
    const advertised = (peer as any).relayPub ?? offerRelayPub
    if (advertised) saveRelay(loadRelay().url, advertised)
    const post = await fetch(`${httpBase()}/pair/${code}?side=reply`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ blob: sealOffer(inv.phrase, await myOffer(id)) }),
    })
    if (!post.ok) die("could not send the pairing reply")
    await ensureDaemon(ROOT_DIR)
    console.log(`
Paired with "${peer.label}".

  them  ${peer.fingerprint}
  you   ${fingerprint(id.ed.pub)}

Check both against what they see. Their messages arrive as "notify": you get a
notice, and their words stay behind the crosstalk_read tool until your Claude
fetches them. Change that per peer with /crosstalk:policy.`)
    return
  }

  // Inviting.
  const url = has("--host") ? await startRelay() : loadRelay().url
  if (!(await relayReachable(url)))
    die(
      `no relay at ${httpBase(url)}.\n\nRun this instead and crosstalk will host one for you:\n  /crosstalk:pair --host`,
    )

  const phrase = flag("--phrase") ?? newPhrase()
  const code = codeForPhrase(phrase)
  const relayPub = await relayPubkey(url)
  if (relayPub) saveRelay(url, relayPub)
  const res = await fetch(`${httpBase(url)}/pair/${code}?side=offer`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ blob: sealOffer(phrase, { ...(await myOffer(id)), relayPub }) }),
  })
  if (!res.ok) die(`the relay at ${httpBase(url)} refused the pairing offer`)

  const asHttp = new URL(url.replace(/^ws/, "http"))
  const port = Number(asHttp.port || (asHttp.protocol === "https:" ? 443 : 8787))
  const tunnelSub = asHttp.hostname.endsWith(".trycloudflare.com")
    ? asHttp.hostname.replace(".trycloudflare.com", "")
    : null
  const where =
    url === DEFAULT_RELAY
      ? null
      : tunnelSub
        ? { token: tunnelSub, reach: "anywhere" as const, how: "a throwaway tunnel" }
        : await whereToSay(port)
  const invite = formatInvite(phrase, where?.token ?? null, port)

  const reachNote =
    where?.reach === "anywhere"
      ? "They can be anywhere."
      : where?.reach === "same network"
        ? "They have to be on the same network as you. For anywhere, put both machines on\na tailnet with Tailscale and run this again, or host a relay: see deploy/."
        : "No network address was found, so nothing outside this machine can reach it."
  const tunnelNote = tunnelSub
    ? "\nThis address only lasts as long as this tunnel. Close it and the two of you stop\nreaching each other, and pairing again gives a different one. For something that\nlasts, run a relay: see deploy/."
    : ""

  console.log(`
Tell them these words:

    ${invite}

They run  /crosstalk:pair ${invite}

Say it out loud, or send it somewhere you already trust. Not through the relay.
Whoever has these words can pair with you until they expire.

  you       ${id.label}  ${fingerprint(id.ed.pub)}
  reaches   ${where?.reach ?? "anywhere"}${where ? `  (${where.how})` : ""}
  expires   15 minutes

${reachNote}${tunnelNote}

Waiting…`)

  for (let i = 0; i < 900; i++) {
    const r = await fetch(`${httpBase(url)}/pair/${code}?side=reply`).catch(() => null)
    if (r?.ok) {
      const { blob } = (await r.json()) as { blob: string }
      let peer
      try {
        peer = asPeer(openOffer(phrase, blob))
      } catch {
        // Someone with the code parked a reply they could not seal correctly.
        // Keep waiting for the real one rather than dying here.
        await new Promise((r) => setTimeout(r, 1000))
        continue
      }
      if (peer.fingerprint === fingerprint(id.ed.pub)) die("that pairing reply carries your own key")
      peer.label = adoptPeer(peer)
      await ensureDaemon(ROOT_DIR)
      console.log(`
Paired with "${peer.label}".

  them  ${peer.fingerprint}
  you   ${fingerprint(id.ed.pub)}

Read both aloud and check they match. Their messages arrive as "notify".`)
      return
    }
    await new Promise((r) => setTimeout(r, 1000))
  }
  die("that invite expired without anyone using it")
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
      `\n${p.online ? "●" : "○"} ${p.label}  ${p.fingerprint}  ${p.policy.delivery}${muted ? " (muted)" : ""}${p.unread ? `  ${p.unread} unread` : ""}`,
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

const commands: Record<string, () => Promise<void>> = {
  pair,
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
}
await (commands[cmd] ?? (async () => die(`unknown command "${cmd}"`)))()
