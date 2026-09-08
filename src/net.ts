// Working out an address the other machine can actually reach, so pairing does
// not turn into a networking exercise.

import os from "node:os"
import { execFileSync } from "node:child_process"

export type Address = { host: string; kind: "tailscale" | "lan" | "loopback"; note: string }

/**
 * A tailnet name, which is the only thing here that works from another network.
 * MagicDNS publishes each machine under a short name, so an invite can say
 * "at paul-mbp" from anywhere rather than carrying an address at all.
 */
export function tailscaleName(): string | null {
  for (const bin of ["tailscale", "/Applications/Tailscale.app/Contents/MacOS/Tailscale"]) {
    try {
      const out = execFileSync(bin, ["status", "--json"], { encoding: "utf8", timeout: 3000 })
      const dns = JSON.parse(out)?.Self?.DNSName as string | undefined
      // "paul-mbp.tailnet-name.ts.net." reduces to "paul-mbp" inside the tailnet.
      const short = dns?.replace(/\.$/, "").split(".")[0]
      if (short) return short.toLowerCase()
    } catch {}
  }
  return null
}

function tailscale(): string | null {
  for (const bin of ["tailscale", "/Applications/Tailscale.app/Contents/MacOS/Tailscale"]) {
    try {
      const out = execFileSync(bin, ["ip", "-4"], { encoding: "utf8", timeout: 2000 }).trim()
      const ip = out.split("\n")[0]?.trim()
      if (ip && /^\d+\.\d+\.\d+\.\d+$/.test(ip)) return ip
    } catch {}
  }
  return null
}

function lan(): string | null {
  const best: string[] = []
  for (const addrs of Object.values(os.networkInterfaces())) {
    for (const a of addrs ?? []) {
      if (a.family !== "IPv4" || a.internal) continue
      if (a.address.startsWith("169.254.")) continue
      best.push(a.address)
    }
  }
  // Prefer a private range; a machine with a public IP is unusual for a laptop.
  return (
    best.find((a) => a.startsWith("192.168.")) ??
    best.find((a) => a.startsWith("10.")) ??
    best.find((a) => /^172\.(1[6-9]|2\d|3[01])\./.test(a)) ??
    best[0] ??
    null
  )
}

/**
 * Tailscale first: it works between two laptops on different networks, which is
 * the case that matters, and needs no port forwarding.
 */
export function bestAddress(): Address {
  // Whatever we guess, the person on the other end is the one who finds out it
  // was wrong. CROSSTALK_ADDRESS, or --address, wins.
  const forced = process.env.CROSSTALK_ADDRESS
  if (forced) return { host: forced, kind: "lan", note: "set by you" }

  const ts = tailscale()
  if (ts) return { host: ts, kind: "tailscale", note: "over your tailnet, from anywhere" }
  const l = lan()
  if (l) return { host: l, kind: "lan", note: "same network only" }
  return { host: "127.0.0.1", kind: "loopback", note: "this machine only" }
}

/** Every address we could offer, so a human can pick when the guess is wrong. */
export function allAddresses(): Address[] {
  const out: Address[] = []
  const ts = tailscale()
  if (ts) out.push({ host: ts, kind: "tailscale", note: "over your tailnet, from anywhere" })
  for (const addrs of Object.values(os.networkInterfaces())) {
    for (const a of addrs ?? []) {
      if (a.family !== "IPv4" || a.internal) continue
      if (a.address.startsWith("169.254.")) continue
      if (out.some((x) => x.host === a.address)) continue
      out.push({ host: a.address, kind: "lan", note: "same network only" })
    }
  }
  return out
}

/** This machine's name, the one its owner would recognise. */
export function machineName(): string {
  const clean = (s: string) =>
    s.trim().toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 24)
  if (process.platform === "darwin") {
    try {
      const name = execFileSync("scutil", ["--get", "ComputerName"], {
        encoding: "utf8",
        timeout: 2000,
      })
      // "Paul's MacBook Air" is mostly the owner's name repeated back, so keep
      // the part that distinguishes one machine from another.
      const c = clean(name).replace(/^[a-z]+-?s-/, "")
      if (c) return c
    } catch {}
  }
  return clean(os.hostname().split(".")[0]) || "machine"
}

/** The name this person already goes by on this machine. */
export function userName(): string {
  const first = (s: string) => s.trim().split(/\s+/)[0]?.toLowerCase().replace(/[^a-z0-9-]/g, "")
  for (const get of [
    () => execFileSync("git", ["config", "user.name"], { encoding: "utf8", timeout: 2000 }),
    () =>
      process.platform === "darwin"
        ? execFileSync("id", ["-F"], { encoding: "utf8", timeout: 2000 })
        : "",
    () => process.env.USER ?? "",
  ]) {
    try {
      const v = first(get())
      if (v && v.length > 1) return v
    } catch {}
  }
  return "me"
}

/**
 * The name this machine answers to on the local network. macOS publishes it
 * over Bonjour without any setup, Linux does the same with avahi. It beats an
 * IP address for an invite: it says whose machine it is, it survives the address
 * changing, and it works across subnets of one network.
 */
export function bonjourName(): string | null {
  if (process.platform === "darwin") {
    try {
      const n = execFileSync("scutil", ["--get", "LocalHostName"], {
        encoding: "utf8",
        timeout: 2000,
      }).trim()
      if (n) return n.toLowerCase()
    } catch {}
  }
  const h = os.hostname().split(".")[0]
  return h ? h.toLowerCase() : null
}

/** Does a name published over mDNS actually resolve back to us right now? */
export async function bonjourWorks(port: number, timeoutMs = 2000): Promise<string | null> {
  const name = bonjourName()
  if (!name) return null
  try {
    const r = await fetch(`http://${name}.local:${port}/health`, {
      signal: AbortSignal.timeout(timeoutMs),
    })
    return r.ok ? name : null
  } catch {
    return null
  }
}

export type Where = { token: string; reach: "anywhere" | "same network" | "same machine"; how: string }

/**
 * The friendliest thing to put after the words, and how far it actually reaches.
 * A tailnet name works from another network; everything else does not.
 */
export async function whereToSay(port: number): Promise<Where> {
  const ts = tailscaleName()
  if (ts) return { token: ts, reach: "anywhere", how: "over your tailnet" }

  const bonjour = await bonjourWorks(port)
  if (bonjour) return { token: bonjour, reach: "same network", how: "this machine's name on the network" }

  const addr = bestAddress()
  if (addr.kind === "loopback")
    return { token: addr.host, reach: "same machine", how: "no network address found" }
  return { token: addr.host, reach: "same network", how: "this machine's address" }
}

/**
 * Everything a given token could mean, in the order worth trying. A bare number
 * is completed from this machine's own subnet, on the assumption that two people
 * pairing are usually on the same network.
 */
export function expandAddress(token: string): string[] {
  const t = token.trim().replace(/^@/, "").trim()
  const out: string[] = []
  const add = (h: string) => {
    if (h && !out.includes(h)) out.push(h)
  }

  if (/^[a-z0-9][a-z0-9-]*$/i.test(t) && !/^\d+$/.test(t)) {
    // A bare name could be a tailnet name, which resolves as-is inside the
    // tailnet, or a machine on this network, which needs .local.
    add(t)
    add(`${t}.local`)
    return out
  }

  const mine = bestAddress().host
  const parts = mine.split(".")
  if (/^\d{1,3}$/.test(t) && parts.length === 4) add(`${parts[0]}.${parts[1]}.${parts[2]}.${t}`)
  if (/^\d{1,3}\.\d{1,3}$/.test(t) && parts.length === 4) add(`${parts[0]}.${parts[1]}.${t}`)
  add(t)
  return out
}
