// The parts of "Messages are UI" that both crosstalk's mod (mod/register.tsx)
// and the daemon-side code need to agree on. No Node and no imports: a mod
// runs where there is neither, and it imports this file as it is.
//
//   pickers       Claude Code's $.ui.ask takes four options at most, so a card
//                 offers Hand to agent / Reply / Open thread / More…, and More…
//                 opens a second picker with Mute / Later
//   @ shortcuts   `@<thread> <text>`, `@main`, `@restore`: optional, typed at
//                 the prompt and taken before they become one
//   the pane      what a thread pane shows, as plain data

export const HAND = "Hand to agent"
export const REPLY = "Reply"
export const ANSWER = "Answer"
export const OPEN_THREAD = "Open thread"
export const MORE = "More…"
export const MUTE = "Mute"
export const LATER = "Later"

/** $.ui.ask refuses more than this many options. */
export const MAX_OPTIONS = 4

/**
 * The turn the mod submits after the person hands a message over. It names
 * nobody: a sender's label, session or thread is theirs to choose, and in the
 * person's own voice it would be words they never said.
 */
export const HANDED_PROMPT = "I handed you the crosstalk message above. Read it and act on it if it concerns this session."

/** A steer's confirmation picker (src/coordinator.ts). */
export const STEER_YES = "Tell it"
export const STEER_NO = "Don't"

/** The first picker for a message card. */
export const CARD_OPTIONS: readonly string[] = [HAND, REPLY, OPEN_THREAD, MORE]
/** The first picker for a peer's question. */
export const ASK_OPTIONS: readonly string[] = [ANSWER, HAND, OPEN_THREAD, MORE]
/** What More… opens. */
export const MORE_OPTIONS: readonly string[] = [MUTE, LATER]

/** The options for a card, never more than $.ui.ask takes. */
export function cardOptions(kind: string): string[] {
  return [...(kind === "ask" ? ASK_OPTIONS : CARD_OPTIONS)].slice(0, MAX_OPTIONS)
}

// --- @ shortcuts --------------------------------------------------------------------

export type At =
  | { kind: "main"; on: boolean }
  | { kind: "restore"; want: "yes" | "no" | "windows" }
  | { kind: "name"; name: string; text: string }

/**
 * `@main`, `@main off`, `@restore [yes|no|windows]`, `@<name> <text>`. Anything
 * else (a file mention such as `@src/a.ts`, an email address) is not ours.
 */
export function parseAt(prompt: string): At | null {
  const m = /^@([A-Za-z0-9_][\w.-]*)(?:\s+([\s\S]*))?$/.exec(prompt.trim())
  if (!m) return null
  const word = m[1]!.toLowerCase()
  const rest = (m[2] ?? "").trim()
  if (word === "main") {
    if (!rest || /^(on|yes|y)$/i.test(rest)) return { kind: "main", on: true }
    if (/^(off|no|n|stop)$/i.test(rest)) return { kind: "main", on: false }
    return null
  }
  if (word === "restore") {
    const w = rest.toLowerCase()
    if (!w || w === "yes" || w === "y") return { kind: "restore", want: "yes" }
    if (w === "no" || w === "n" || w === "not now") return { kind: "restore", want: "no" }
    if (w === "windows") return { kind: "restore", want: "windows" }
    return null
  }
  if (!rest) return null
  return { kind: "name", name: word, text: rest }
}

/**
 * Whether the mod should take `@<word> …` before it is a prompt. Only for a
 * word it knows to be crosstalk's: main, restore, a thread or a person with
 * something waiting. `@README.md explain this` stays the person's prompt.
 */
export function takesAt(at: At | null, known: readonly string[]): boolean {
  if (!at) return false
  if (at.kind !== "name") return true
  const n = at.name.toLowerCase()
  return known.some((k) => k.toLowerCase() === n)
}

/**
 * The option a short typed answer means: the option itself (any case), the
 * start of one, `y`/`yes` for the first and `n`/`no` for the one that says no.
 */
export function matchOption(typed: string, options: readonly string[]): string | undefined {
  const t = typed.trim().toLowerCase()
  if (!t || !options.length) return undefined
  const exact = options.find((o) => o.toLowerCase() === t)
  if (exact) return exact
  if (t === "y" || t === "yes") return options[0]
  if (t === "n" || t === "no") return options.find((o) => /^(no|not|don't|dont|hold|cancel)\b/i.test(o)) ?? options[options.length - 1]
  const starts = options.filter((o) => o.toLowerCase().startsWith(t))
  return starts.length === 1 ? starts[0] : undefined
}

// --- the pane ----------------------------------------------------------------------

export type PaneFeature = { name: string; risk: string; flag?: string; stage?: string; state?: string }
export type PaneRecent = { from: string; text: string; ts?: number }

/** One thread, as its pane draws it. Never model context. */
export type PaneModel = {
  thread: string
  status: string
  repo?: string
  recap?: string
  people: string[]
  sessions: number
  /** What is waiting: open questions, and things the person has to answer. */
  waiting: string[]
  decision?: { text: string; who: string; at: number }
  recent: PaneRecent[]
  features: PaneFeature[]
  /** crosstalk services running in this session's worktree, with where they listen (docs/services.md). */
  services?: PaneService[]
  /** The thread's URLs (src/urls/): in the main session, every thread's. */
  links?: PaneLink[]
  /** Screenshots, each URL's before and after, as files (src/urls/shots/); the mod links them, it cannot draw images. */
  shots?: PaneShot[]
  /** A QR code crosstalk_qr made for the phone (src/urls/history/phone.ts): half-block rows, drawn white on black. */
  qr?: { label: string; caption: string; rows: string[]; at: number; why?: string }
}

/** `broken`: crashed or stopped answering (src/urls/health/), with why. */
export type PaneService = { name: string; ports: number[]; url?: string; broken?: string }

export type PaneShot = { label: string; path?: string; before?: { file: string; at: number }; after: { file: string; at: number } }

/** `file:///…`, its path escaped, for an OSC 8 link to a screenshot. Only an absolute path of printable characters. */
export const fileLink = (file: string) => (/^\/[^\u0000-\u001f\u007f]*$/.test(file) && file.length <= 1000 ? `file://${file.split("/").map(encodeURIComponent).join("/")}` : undefined)

/** A screenshot pair's line: `auth · web /login · before 2m · after now`. */
export const shotLine = (s: PaneShot, now: number) => `${s.label}${s.path ? ` ${s.path}` : ""} · ${s.before ? `before ${ago(s.before.at, now)}` : "no before yet"} · after ${ago(s.after.at, now)}`

/** One URL in the pane: what it is, where (the proxy's name for a local server), and whether it answers. */
export type PaneLink = { label: string; url: string; kind: "local" | "preview" | "pr" | "link" | "shared"; alive: boolean; thread?: string }

export const LINK_KINDS = [
  ["local", "Local"],
  ["preview", "Previews"],
  ["pr", "Pull requests"],
  ["link", "Links found in output"],
  ["shared", "Shared"],
] as const

/** The pane's links by kind, in the order above, empty kinds left out. */
export function linkGroups(links: readonly PaneLink[]): { kind: PaneLink["kind"]; title: string; links: PaneLink[] }[] {
  return LINK_KINDS.map(([kind, title]) => ({ kind, title, links: links.filter((l) => l.kind === kind) })).filter((g) => g.links.length)
}

/** A URL the pane may make clickable: http(s), a plain host, nothing that is not printable. */
export const linkable = (url: string) => url.length <= 500 && /^https?:\/\/[A-Za-z0-9.\[\]:-]+(\/[!-~]*)?$/.test(url)

/** A link's line: `● auth · dev server`, or `○ auth · dev server · dead`. */
export const linkLine = (l: PaneLink) => `${l.alive ? "●" : "○"} ${l.label}${l.alive ? "" : l.kind === "shared" ? " · ended" : " · dead"}`

/** A service's line in the pane: `web · :4100`. */
export const serviceLine = (s: PaneService) => (s.broken ? `${s.name} · broken: ${s.broken}` : s.ports.length ? `${s.name} · ${s.ports.map((p) => `:${p}`).join(" ")}` : `${s.name} · starting`)

/** A feature's line in the pane: `v2 tokens · risky · flag auth-v2 at internal · merged`. */
export function featureLine(f: PaneFeature): string {
  const parts = [f.name, f.risk]
  if (f.flag) parts.push(`flag ${f.flag}${f.stage ? ` at ${f.stage}` : ""}`)
  else if (f.stage) parts.push(`at ${f.stage}`)
  if (f.state) parts.push(f.state)
  return parts.join(" · ")
}

export function ago(ts: number | undefined, now: number): string {
  if (!ts) return ""
  const s = Math.max(0, Math.round((now - ts) / 1000))
  if (s < 60) return "now"
  if (s < 3600) return `${Math.round(s / 60)}m`
  if (s < 86400) return `${Math.round(s / 3600)}h`
  return `${Math.round(s / 86400)}d`
}

/** Plain lines of a pane, for a surface or a test that draws text alone. */
export function paneLines(p: PaneModel, now: number): string[] {
  const out = [`◢ ${p.thread} · ${p.status}`, p.people.length ? p.people.join("  ") : "nobody yet"]
  if (p.recap) out.push("", p.recap)
  out.push("", "Waiting", ...(p.waiting.length ? p.waiting.map((w) => ` ? ${w}`) : [" nothing"]))
  if (p.decision) out.push("", "Latest decision", ` ${p.decision.text} (${p.decision.who}${p.decision.at ? `, ${ago(p.decision.at, now)}` : ""})`)
  if (p.features.length) out.push("", "Features", ...p.features.map((f) => ` ${featureLine(f)}`))
  if (p.recent.length) out.push("", "Recent", ...p.recent.map((r) => ` ${r.from} ${ago(r.ts, now)} ${r.text}`))
  if (p.services?.length) out.push("", "Services", ...p.services.map((s) => ` ${serviceLine(s)}${s.url ? ` ${s.url}` : ""}`))
  if (p.links?.length) {
    out.push("", "Links")
    for (const g of linkGroups(p.links)) out.push(` ${g.title}`, ...g.links.map((l) => `  ${linkLine(l)} ${l.url}`))
  }
  if (p.shots?.length) {
    out.push("", "Screenshots")
    for (const s of p.shots) out.push(` ${shotLine(s, now)}`, ...(s.before ? [`  before ${s.before.file}`] : []), `  after  ${s.after.file}`)
  }
  return out
}
