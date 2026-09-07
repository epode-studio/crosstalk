// Working out an address the other machine can actually reach, so pairing does
// not turn into a networking exercise.

import os from "node:os"
import { execFileSync } from "node:child_process"

export type Address = { host: string; kind: "tailscale" | "lan" | "loopback"; note: string }

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
