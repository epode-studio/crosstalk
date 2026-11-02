// Getting a blocking question in front of the person when they are not
// looking at the session that asks.
//
// docs/design/next-generation.md: "A desktop notification names the asking
// thread, and clicking it jumps to that session's tab." Only crosstalk's own
// notification can promise the jump, so the daemon posts it:
//
//   kitty            OSC 99, written to the asking session's own tty; kitty
//                    focuses the window that sent it when it is clicked
//   macOS            `terminal-notifier -execute "crosstalk attn focus …"` when
//                    it is installed: the click runs the focus adapter
//                    (focus.ts); without it, `display notification`, which
//                    cannot jump, plus the receipt below
//   Linux            `notify-send`, which cannot jump either
//
// And always, in the session the person is in: a receipt from crosstalk's mod
// naming the session, so "show me api" (crosstalk_work action "show") brings it up.
//
// When the person is away (activity.ts), the phone instead:
//
//   ntfy             a POST to the configured topic whose body is only
//                    "crosstalk: 1 question waiting in <thread>": the topic is
//                    readable by anyone who guesses it, so nothing of the
//                    question, the repo or the people goes in it
//   Claude's push    the mod calls Claude Code's own PushNotification tool
//                    (2.1.316 lists it among the built-in tools, sent through
//                    Remote Control to the Claude app) with the same sealed
//                    line, when the session has that tool
//
// Configuration: <crosstalk home>/attention.json
//   { "ntfy": { "url": "https://ntfy.sh", "topic": "<long random>", "token": "<optional>" } }
// or CROSSTALK_NTFY_URL=https://ntfy.sh/<topic> (and CROSSTALK_NTFY_TOKEN).

import fs from "node:fs"
import path from "node:path"
import { P } from "../config.ts"
import * as R from "../restore.ts"
import type { Step, Term } from "../restore.ts"

export type Desktop =
  | { kind: "tty"; path: string; data: string; how: string }
  | { kind: "run"; step: Step; how: string; jumps: boolean }

const ST = "\x1b\\"
/** OSC 99 takes no control characters and no `;` in its payload unescaped; keep it plain. */
const plain = (s: string, n: number) => s.replace(/[\x00-\x1f\x7f;]/g, " ").replace(/\s+/g, " ").trim().slice(0, n)

/** kitty's notification: title, then body, one id; a click focuses the window that wrote it (a=focus, the default). */
export function osc99(id: string, title: string, body: string): string {
  const i = id.replace(/[^A-Za-z0-9_-]/g, "").slice(0, 32) || "crosstalk"
  return `\x1b]99;i=${i}:d=0:a=focus;${plain(title, 80)}${ST}\x1b]99;i=${i}:d=1:a=focus:p=body;${plain(body, 240)}${ST}`
}

/**
 * How to post one notification. `click` is the command that focuses the
 * asking session; `asker` is its terminal, for kitty's own notifications.
 */
export function desktopPlan(o: {
  id: string
  title: string
  body: string
  click: string[]
  asker?: Term | null
  platform: NodeJS.Platform
  has: (bin: string) => boolean
}): Desktop | null {
  const t = o.asker
  if (t && !t.tmux && R.kindOf(t) === "kitty" && t.tty) return { kind: "tty", path: t.tty, data: osc99(o.id, o.title, o.body), how: "kitty OSC 99" }
  if (o.platform === "darwin") {
    if (o.has("terminal-notifier"))
      return {
        kind: "run",
        how: "terminal-notifier",
        jumps: true,
        step: { cmd: "terminal-notifier", args: ["-title", o.title, "-message", o.body, "-group", `crosstalk-${o.id}`, "-execute", o.click.map(R.shq).join(" ")] },
      }
    return { kind: "run", how: "osascript", jumps: false, step: { cmd: "osascript", args: ["-e", `display notification ${R.asq(o.body)} with title ${R.asq(o.title)}`] } }
  }
  if (o.platform === "linux" && o.has("notify-send")) return { kind: "run", how: "notify-send", jumps: false, step: { cmd: "notify-send", args: ["-a", "crosstalk", o.title, o.body] } }
  return null
}

// --- the phone ----------------------------------------------------------------------

export type Ntfy = { url: string; token?: string }

/** Where pushes go, or null when the person has not set one up. */
export function ntfyConfig(env: NodeJS.ProcessEnv = process.env, file = path.join(P.root, "attention.json")): Ntfy | null {
  if (env.CROSSTALK_NTFY_URL) return { url: env.CROSSTALK_NTFY_URL, token: env.CROSSTALK_NTFY_TOKEN || undefined }
  try {
    const c = JSON.parse(fs.readFileSync(file, "utf8"))?.ntfy
    if (c && typeof c.topic === "string" && c.topic) {
      const base = String(c.url ?? "https://ntfy.sh").replace(/\/+$/, "")
      return { url: `${base}/${encodeURIComponent(c.topic)}`, token: typeof c.token === "string" ? c.token : undefined }
    }
  } catch {}
  return null
}

/** The only words that ever leave the machine: a count and a thread name. */
export function sealedLine(count: number, thread: string): string {
  const name = thread.replace(/[^A-Za-z0-9._-]/g, "-").slice(0, 40) || "a thread"
  return `crosstalk: ${count} question${count === 1 ? "" : "s"} waiting in ${name}`
}

export async function pushNtfy(cfg: Ntfy, line: string, fetcher: typeof fetch = fetch): Promise<boolean> {
  try {
    const ctl = new AbortController()
    const t = setTimeout(() => ctl.abort(), 10_000)
    const r = await fetcher(cfg.url, {
      method: "POST",
      body: line,
      headers: { Title: "crosstalk", Tags: "speech_balloon", Priority: "high", ...(cfg.token ? { Authorization: `Bearer ${cfg.token}` } : {}) },
      signal: ctl.signal,
    })
    clearTimeout(t)
    return r.ok
  } catch {
    return false
  }
}
