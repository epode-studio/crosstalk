// `crosstalk urls qr [name | url]`: the QR code in a terminal, for a session
// with no pane. Without a name, the one crosstalk_qr last made. For a person's
// own terminal only: inside an agent it is refused, since a share link's code
// would land in the model's context.

import fs from "node:fs"
import path from "node:path"
import { P } from "../../config.ts"
import { paneQrFor, phoneTarget, isLocalUrl, type PaneQr } from "./phone.ts"
import { gather, pick } from "../tools.ts"

const insideAgent = () => !!(process.env.CLAUDECODE || process.env.CODEX_SANDBOX || process.env.CROSSTALK_AS_AGENT)

function latest(): PaneQr | undefined {
  const dir = path.join(P.root, "qr")
  let best: { at: number; q: PaneQr } | undefined
  try {
    for (const f of fs.readdirSync(dir)) {
      if (!f.endsWith(".json")) continue
      try {
        const q = JSON.parse(fs.readFileSync(path.join(dir, f), "utf8"))
        if (Array.isArray(q?.rows) && (!best || q.at > best.at)) best = { at: q.at, q }
      } catch {}
    }
  } catch {}
  return best?.q
}

/** White on black, so it scans on a light or a dark terminal. */
export const printQr = (q: PaneQr, write = (s: string) => void process.stdout.write(s)) => {
  const tty = process.stdout.isTTY
  write(`${q.label}${q.why ? ` (${q.why})` : ""}\n`)
  for (const r of q.rows) write(tty ? `\x1b[97;40m${r}\x1b[0m\n` : `${r}\n`)
  write(`${q.caption}\n`)
}

export function qrCmd(argv: string[]): number {
  if (insideAgent()) {
    console.log("◢ crosstalk: this prints a QR code for the person's eyes; inside an agent it is not shown. Ask for it with crosstalk_qr, which draws it in the pane.")
    return 1
  }
  const words = argv.slice(2).filter((a) => !a.startsWith("--")).join(" ").trim()
  if (!words) {
    const q = latest()
    if (!q) {
      console.log("◢ crosstalk: no QR code yet. Run `crosstalk urls qr <name>` (as crosstalk_urls labels them) or pass a URL.")
      return 1
    }
    printQr(q)
    return 0
  }
  let target: ReturnType<typeof phoneTarget>
  if (/^https?:\/\//.test(words)) target = isLocalUrl(words) ? { ok: false, text: "◢ crosstalk: a local URL does not open on a phone; it needs a share link or a deployed preview." } : { ok: true, url: words, label: words, via: "public" }
  else {
    const all = gather({ sessionId: process.env.CLAUDE_CODE_SESSION_ID ?? "", cwd: process.cwd() })
    const hits = pick(all, words)
    if (hits.length !== 1) {
      console.log(hits.length ? `◢ crosstalk: ${hits.length} match: ${hits.map((u) => u.label).join("; ")}` : `◢ crosstalk: nothing matches "${words}".`)
      return 1
    }
    target = phoneTarget(hits[0], all)
  }
  if (!target.ok) {
    console.log(target.text)
    return 1
  }
  printQr(paneQrFor({ url: target.url, label: target.label, via: target.via, note: target.note }))
  return 0
}
