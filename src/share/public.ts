// A public link to a local server, only when the person asked for one in so
// many words (docs/security.md, "Sharing a running server"). It is the
// existing quick-tunnel path (src/tunnel.ts, cloudflared, nothing downloaded)
// pointed at the service's port instead of the relay's: anyone with the link
// reaches the server, as if they were on this machine, until it expires (an
// hour by default, eight at most) or is stopped. It dies with the daemon.

import path from "node:path"
import { P } from "../config.ts"
import { openTunnel, tunnelBinary } from "../tunnel.ts"

export const WARNING =
  "⚠ PUBLIC LINK: anyone who has this URL can reach this server, as if they were on this machine, with no crosstalk check at all. Cloudflare carries the traffic in the clear to its edge. Send it only where it has to go; it expires on its own, and crosstalk_look action \"unshare\" stops it now."

export async function openPublic(port: number, id: string): Promise<{ url: string; pid: number } | { error: string }> {
  const bin = tunnelBinary()
  if (!bin) return { error: "a public link needs cloudflared installed (brew install cloudflared); crosstalk never downloads it. Sharing with people over crosstalk needs nothing." }
  try {
    const t = await openTunnel(bin, port, path.join(P.root, `share-${id}.tunnel.log`), 60_000, {
      // A dev server has no /health: any HTTP answer through the tunnel means it carries traffic.
      probe: async (host) => {
        const r = await fetch(`https://${host}/`, { method: "HEAD", redirect: "manual", signal: AbortSignal.timeout(10_000) })
        return r.status > 0 && r.status !== 502 && r.status !== 530
      },
    })
    return { url: t.url, pid: t.pid }
  } catch (e) {
    return { error: (e as Error).message }
  }
}

export function closePublic(pid: number | undefined) {
  if (!pid) return
  try {
    process.kill(pid)
  } catch {}
}
