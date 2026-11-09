// The parts of "Messages are UI" that both crosstalk's mod (mod/register.tsx)
// and the daemon-side code need to agree on. No Node and no imports: a mod
// runs where there is neither, and it imports this file as it is.
//
//   pickers       Claude Code's $.ui.ask takes four options at most, so a card
//                 offers Hand to agent / Reply / Open thread / More…, and More…
//                 opens a second picker with Mute / Later
//   @ shortcuts   `@<thread> <text>`, `@main`, `@restore`: optional, typed at
//                 the prompt and taken before they become one
//   the pane      what a thread pane shows, as plain data: status, people,
//                 what is waiting, Notes, Features, Running, History
//   the status line   `◢ auth · auth.localhost:1355 · 1 for you`

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

/** A note in the pane: its kind and one line. */
export type PaneNote = { kind: "decision" | "fact" | "task" | "rule"; text: string; who?: string; at?: number; state?: string }

/** One thread, as its pane draws it. Never model context. */
export type PaneModel = {
  thread: string
  status: string
  repo?: string
  recap?: string
  people: string[]
  /** How many agents are working in it. */
  sessions: number
  /** What is waiting: open questions, and things the person has to answer. */
  waiting: string[]
  /** The latest notes, newest first: decisions, open tasks, facts, rules. */
  notes?: PaneNote[]
  recent: PaneRecent[]
  features: PaneFeature[]
  /** What it runs and where to look (src/threads/running.ts): in the main session, every thread's. */
  running?: PaneRunning[]
  /** What it once had: the latest ended links and notes (src/threads/history.ts). */
  history?: PaneHistory[]
  /** Every agent on this machine ("show me all my agents", and the main session's pane). */
  agents?: PaneAgent[]
  /** With the agents: every pull request, and what just happened (checks passed or failed, merges). */
  prs?: PaneRunning[]
  events?: PaneEvent[]
  /** What waits on the person, most pressing first, in the order it will be asked (inboxOrder). */
  inbox?: string[]
  /** Agents with nothing to do, counted, not listed. */
  idle?: number
  /** The plan's windows and today's spend, `5-hour 42% (resets 3:10 PM) · week 18% · $12.40 …`; hot at 80%. */
  usage?: { text: string; hot: boolean }
  /** A QR code crosstalk_look action "qr" made for the phone (src/urls/history/phone.ts): half-block rows, drawn white on black. */
  qr?: { label: string; caption: string; rows: string[]; at: number; why?: string }
}

export type PaneAgent = { name: string; thread?: string; state: "working" | "waiting" | "idle"; forYou?: number; idleMin?: number; background?: boolean; here?: boolean; /** What its own agent is asking, waiting in that tab. */ asks?: string; sessionId?: string; /** What it has cost so far, `$1.20`. */ cost?: string }

export type PaneShot = { label: string; path?: string; before?: { file: string; at: number }; after: { file: string; at: number } }

/** What a thread runs and where to look, one kind of thing each. */
export type RunningKind = "server" | "preview" | "pr" | "share" | "link" | "screenshot"

/**
 * One thing in Running. `owner`: "you", or whose it is (a teammate who showed
 * you their server). `alive`: it answers (a server, a preview, a link), is
 * open (a share), or is there (a screenshot). A screenshot's `before` and
 * `after` are files; a server's `ports` and `broken` are what the machinery
 * knows of it.
 */
export type PaneRunning = {
  kind: RunningKind
  label: string
  url?: string
  /** The address underneath, when `url` is its local name: `http://localhost:4100`. */
  raw?: string
  /** Its local name, `auth.localhost`, when it has one. */
  name?: string
  alive: boolean
  owner: string
  thread?: string
  ports?: number[]
  broken?: string
  /** A pull request's checks (src/urls/ci.ts), and how long they usually have left. */
  checks?: "running" | "passed" | "failed" | "none"
  failed?: string[]
  eta?: string
  draft?: boolean
  /** In its repository's merge queue (src/urls/queue.ts). */
  queued?: boolean
  /** OPEN, MERGED, CLOSED. */
  state?: string
  /** Who a share of yours is open to. */
  with?: string[]
  until?: number
  path?: string
  before?: { file: string; at: number }
  after?: { file: string; at: number }
}

/** One thing in History: a link, preview, PR or screenshot the thread had, or a note that ended. */
export type PaneHistory = { kind: string; label: string; at: number; url?: string }

export const RUNNING_KINDS: readonly (readonly [RunningKind, string])[] = [
  ["server", "Servers"],
  ["preview", "Previews"],
  ["pr", "Pull requests"],
  ["share", "Shown to people"],
  ["link", "Links found in output"],
  ["screenshot", "Screenshots"],
] as const

/** Running by kind, in the order above, empty kinds left out. */
export function runningGroups(items: readonly PaneRunning[]): { kind: RunningKind; title: string; items: PaneRunning[] }[] {
  return RUNNING_KINDS.map(([kind, title]) => ({ kind, title, items: items.filter((r) => r.kind === kind) })).filter((g) => g.items.length)
}

/** Where a running thing is, for a person: its local name, else its address. */
export const runningWhere = (r: PaneRunning) => r.url ?? (r.ports?.length ? `localhost:${r.ports[0]}` : "")

/** A running thing's line: `● auth · dev server`, `○ auth · PR #12 · dead`, `● web · broken: exited 1`. */
export function runningLine(r: PaneRunning, now: number): string {
  const mark = r.alive ? "●" : "○"
  if (r.kind === "screenshot")
    return `${r.label}${r.path ? ` ${r.path}` : ""} · ${r.before ? `before ${ago(r.before.at, now)}` : "no before yet"} · after ${ago(r.after?.at, now)}`
  if (r.broken) return `${mark} ${r.label} · broken: ${r.broken}`
  if (r.kind === "server" && !r.url && !r.ports?.length) return `${mark} ${r.label} · starting`
  const who = r.kind === "share" ? (r.owner === "you" ? (r.with?.length ? ` · with ${r.with.join(", ")}` : "") : ` · from ${r.owner}`) : ""
  const left = r.kind === "share" && r.alive && r.until ? ` · ${until(r.until, now)} left` : ""
  if (r.kind === "pr") {
    const sign = r.state === "MERGED" ? SIGN.done : r.checks === "failed" ? SIGN.broken : r.checks === "running" ? SIGN.working : r.checks === "passed" ? SIGN.done : mark
    return `${sign} ${r.label}${prState(r)}`
  }
  const dead = r.alive ? "" : r.kind === "share" ? " · ended" : " · dead"
  return `${mark} ${r.label}${who}${left}${dead}`
}

/** `7h`, `40m`: how long until `ts`. */
export function until(ts: number, now: number): string {
  const s = Math.max(0, Math.round((ts - now) / 1000))
  if (s < 3600) return `${Math.max(1, Math.round(s / 60))}m`
  if (s < 86400) return `${Math.round(s / 3600)}h`
  return `${Math.round(s / 86400)}d`
}

/** A note's line in the pane: `decision · v1 accepted until 0.2 (paul, 2h)`, `[ ] remove the v1 parser`. */
export function noteLine(n: PaneNote, now: number): string {
  const when = n.who || n.at ? ` (${[n.who, n.at ? ago(n.at, now) : ""].filter(Boolean).join(", ")})` : ""
  if (n.kind === "task") return `[${n.state === "done" ? "x" : n.state === "claimed" ? "~" : " "}] ${n.text}${n.state === "claimed" && n.who ? ` (${n.who})` : ""}`
  return `${n.kind} · ${n.text}${when}`
}

/** A History line: `PR #9 · merged · 3d` or `fact · staging was shared · ended 5d`. */
export const historyLine = (h: PaneHistory, now: number) => `${h.label} · ${h.kind} · ${ago(h.at, now)}`

// --- the status line -----------------------------------------------------------------

/** What the status line says runs: where its one server is (`auth.localhost:1355`), else how many things run. */
export function runningSummary(items: readonly PaneRunning[]): string {
  const up = items.filter((r) => r.alive && r.kind !== "screenshot" && r.owner === "you")
  const servers = up.filter((r) => r.kind === "server")
  return servers.length === 1 ? runningWhere(servers[0]!).replace(/^https?:\/\//, "") : up.length ? `${up.length} running` : ""
}

/**
 * The status line: `◢ auth · tokens · auth.localhost:1355 · 1 for you`. The
 * session's threads, else what its cards are about, else its repo; where its
 * one server is (or how many things run); what waits on the person, only when
 * something does. Nothing at all when
 * nothing is waiting and nothing runs.
 */
export function statusLine(o: { threads: readonly string[]; cards?: readonly string[]; repo?: string; running?: readonly PaneRunning[]; where?: string; waiting: number; label?: string; main?: { sessions: number; threads: number; waiting: number } }): string | undefined {
  // What waits on the person, said only when something does: "0 waiting" read as noise.
  const forYou = (n: number) => (n > 0 ? `${SIGN.waiting} ${n} for you` : "")
  if (o.main) return ["◢ main", `${o.main.threads} thread${o.main.threads === 1 ? "" : "s"}`, `${SIGN.working} ${o.main.sessions} working`, forYou(Math.max(o.main.waiting, o.waiting))].filter(Boolean).join(" · ")
  const named = o.threads.length ? o.threads.slice(0, 3).join(" · ") : o.cards?.length ? o.cards.slice(0, 3).join(", ") : o.repo ?? ""
  const where = o.where || runningSummary(o.running ?? [])
  if (!o.waiting && !o.label && !where) return undefined
  // The session's thread colour in front, as on its tab; crosstalk's ◢ when it has no thread.
  const lead = o.threads[0] ? dotFor(o.threads[0]) : "◢"
  return `${lead} ${[named || "crosstalk", where, forYou(o.waiting)].filter(Boolean).join(" · ")}`
}

/** `file:///…`, its path escaped, for an OSC 8 link to a screenshot. Only an absolute path of printable characters. */
export const fileLink = (file: string) => (/^\/[^\u0000-\u001f\u007f]*$/.test(file) && file.length <= 1000 ? `file://${file.split("/").map(encodeURIComponent).join("/")}` : undefined)


/** A URL the pane may make clickable: http(s), a plain host, nothing that is not printable. */
export const linkable = (url: string) => url.length <= 500 && /^https?:\/\/[A-Za-z0-9.\[\]:-]+(\/[!-~]*)?$/.test(url)

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


/** Plain lines of a pane, for a surface or a test that draws text alone: the same sections the mod draws. */
export function paneLines(p: PaneModel, now: number): string[] {
  if (p.agents)
    return [
      `◢ ${p.thread} · ${p.status}`,
      "",
      `Needs you${p.inbox?.length ? ` · ${p.inbox.length}` : ""}`,
      ...(p.inbox?.length ? p.inbox.map((l, i) => ` ${i + 1}. ${l}`) : [" nothing right now"]),
      ...(p.agents.length ? ["", `Working · ${p.agents.length}`, ...p.agents.map((a) => ` ${agentLine(a)}`)] : []),
      ...(p.prs?.length ? ["", "Pull requests", ...p.prs.map((r) => ` ${runningLine(r, now)}`)] : []),
      ...(p.events?.length ? ["", "Lately", ...p.events.map((e) => ` ${e.text} · ${ago(e.at, now)}`)] : []),
      ...(p.idle || p.usage ? ["", [p.idle ? `${p.idle} idle` : "", p.usage ? p.usage.text : ""].filter(Boolean).join(" · ")] : []),
    ]
  const out = [`◢ ${p.thread} · ${p.status}${p.sessions ? ` · ${p.sessions} working` : ""}`, p.people.length ? p.people.join("  ") : "nobody yet"]
  if (p.recap) out.push("", p.recap)
  out.push("", "Waiting", ...(p.waiting.length ? p.waiting.map((w) => ` ? ${w}`) : [" nothing"]))
  if (p.notes?.length) out.push("", "Notes", ...p.notes.map((n) => ` ${noteLine(n, now)}`))
  if (p.features.length) out.push("", "Features", ...p.features.map((f) => ` ${featureLine(f)}`))
  if (p.running?.length) {
    out.push("", "Running")
    for (const g of runningGroups(p.running)) {
      out.push(` ${g.title}`)
      for (const r of g.items) {
        const where = runningWhere(r)
        out.push(`  ${runningLine(r, now)}${where ? ` ${where}` : ""}`)
        if (r.kind === "screenshot") out.push(...(r.before ? [`   before ${r.before.file}`] : []), ...(r.after ? [`   after  ${r.after.file}`] : []))
      }
    }
  }
  if (p.recent.length) out.push("", "Recent", ...p.recent.map((r) => ` ${r.from} ${ago(r.ts, now)} ${r.text}`))
  if (p.history?.length) out.push("", "History", ...p.history.map((h) => ` ${historyLine(h, now)}`))
  return out
}


const agoMin = (min: number) => (min < 1 ? "just now" : min < 60 ? `${min} min` : min < 48 * 60 ? `${Math.round(min / 60)} h` : `${Math.round(min / 1440)} days`)

/** One agent as the pane writes it: `? billing · billing-v2 · 2 for you`. */
export function agentLine(a: PaneAgent): string {
  const sign = a.state === "waiting" ? SIGN.waiting : a.state === "working" ? SIGN.working : (a.idleMin ?? 0) >= 60 ? SIGN.idle : SIGN.done
  const name = human(a.thread ?? a.name, 36)
  const what = a.state === "waiting" ? (a.forYou ? `${a.forYou} for you` : "waiting on you") : a.state === "working" ? "" : `idle ${agoMin(a.idleMin ?? 0)}`
  return [`${a.thread ? dotFor(a.thread) : ""}${sign} ${name}`, what, a.background ? "out of sight" : "", a.cost ?? ""].filter(Boolean).join(" · ")
}

/** The question an agent is waiting on, on the line under it: `    asks: Keep the Pi flat? (Pi flat / Keep any tilt)`. */
export const agentAsks = (a: PaneAgent): string | null => (a.asks ? `   asks: ${a.asks}` : null)


/** A pull request's state in words: ` · draft · checks running · about 6 min left`, ` · checks failed: e2e`, ` · merged`. */
export function prState(r: Pick<PaneRunning, "state" | "draft" | "checks" | "failed" | "eta" | "alive" | "queued">): string {
  if (r.state === "MERGED") return " · merged"
  if (r.state === "CLOSED") return " · closed"
  if (!r.alive) return " · dead"
  const parts = [r.draft ? "draft" : ""]
  if (r.checks === "running") parts.push("checks running", r.eta ?? "")
  else if (r.checks === "failed") parts.push(`checks failed${r.failed?.length ? `: ${r.failed.join(", ")}` : ""}`)
  else if (r.checks === "passed") parts.push("checks passed")
  if (r.queued) parts.push("in the merge queue")
  return parts.filter(Boolean).map((x) => ` · ${x}`).join("")
}

/** Something that just happened, for the main session's pane: `#2841 checks passed · 3m`. */
export type PaneEvent = { text: string; at: number }

// --- the inbox: one thing at a time, most pressing first -------------------------------

/** What the inbox orders by: kind, id and age, as the store keeps them. */
export type InboxItem = { id: string; kind: string; createdAt: number; from?: string; thread?: string; question?: string; text?: string }

/**
 * How pressing an item is. What the person just asked for (a tidy or close to
 * confirm, a restore) first; then an agent stopped until you answer (its own
 * question relayed to main, a permission prompt, a teammate's question); then
 * shipping steps, failures and staffing; offers last. Waiting raises any item,
 * up to half an hour's worth, so nothing old sinks for ever.
 */
export function inboxScore(it: InboxItem, now: number): number {
  const base =
    it.kind === "session" || it.kind === "restore"
      ? 120
      : it.id.startsWith("relay:") || it.id.startsWith("attn:perm:") || it.id.startsWith("attn:circle:")
        ? 100
        : it.kind === "ask"
          ? 90
          : it.kind === "ship" || it.kind === "conflict"
            ? 80
            : it.id.startsWith("attn:staff:")
              ? 60
              : it.kind === "route" || it.kind === "team" || it.kind === "steer"
                ? 55
                : it.id.startsWith("open:")
                  ? 40
                  : it.kind === "message"
                    ? 35
                    : 30
  const waitedMin = Math.max(0, (now - it.createdAt) / 60_000)
  return base + Math.min(30, waitedMin / 2)
}

/** The inbox in order: most pressing first, the older first among equals. */
export function inboxOrder<T extends InboxItem>(items: T[], now: number): T[] {
  return [...items].sort((a, b) => inboxScore(b, now) - inboxScore(a, now) || a.createdAt - b.createdAt)
}

/** One line of the inbox, for the main session's pane: `organic-case-81 asks: Keep the Pi flat? · 12m`. */
export function inboxLine(it: InboxItem, now: number): string {
  const what = shortQuestion(it.question ?? it.text ?? it.id)
  const where = it.thread ? human(it.thread, 24) : it.from ? human(it.from, 24) : ""
  return `${it.thread ? dotFor(it.thread) + " " : ""}${where ? `${where} — ` : ""}${what} · ${ago(it.createdAt, now) || "now"}`
}


// --- one small set of signs, everywhere: tabs, the pane, the status line, questions ---------

/** A thread's colour: the same thread, the same dot, in every tab and line. */
export const DOTS = ["🟠", "🟡", "🟢", "🔵", "🟣", "🟤", "⚪"] as const
export function dotFor(thread: string): string {
  let h = 2166136261
  for (const c of thread.toLowerCase()) h = Math.imul(h ^ c.charCodeAt(0), 16777619)
  return DOTS[(h >>> 0) % DOTS.length] ?? "⚪"
}

/** What a session is doing: ❓ needs you, ⏳ working, ✅ done, 🔴 broken (checks failing, server crashed), 💤 idle a while. */
export const SIGN = { waiting: "❓", working: "⏳", done: "✅", broken: "❗", idle: "💤" } as const
export type Sign = keyof typeof SIGN

/** The legend, said once in the welcome. */
export const LEGEND = `${SIGN.waiting} needs you · ${SIGN.working} working · ${SIGN.done} done · ${SIGN.broken} something broke · ${SIGN.idle} idle · a coloured dot per thread`

// --- plain words: what a person reads, not ids or slugs --------------------------------

const ACRONYMS = new Set(["mcp", "ai", "pr", "ci", "api", "ui", "ux", "led", "pal", "esp32", "sdk", "cli", "id", "ids", "url", "db", "css", "html", "ios", "qr", "llm", "cbmc", "scd30"])

/** A thread or session name as words: `mcp-endpoint-so-any-ai-app-can-control-p` → `MCP endpoint so any AI app…`. */
export function human(name: string, max = 32): string {
  const words = name
    .replace(/[_-]+/g, " ")
    .trim()
    .split(/\s+/)
    .map((w) => (ACRONYMS.has(w.toLowerCase()) ? w.toUpperCase() : w))
  if (!words.length || !words[0]) return name
  words[0] = words[0][0]!.toUpperCase() + words[0].slice(1)
  let out = ""
  for (const w of words) {
    if ((out ? out.length + 1 : 0) + w.length > max) return out ? `${out}…` : `${w.slice(0, max - 1)}…`
    out = out ? `${out} ${w}` : w
  }
  return out
}

/** A question in one line: who asks dropped (the line says it), cut to fit. */
export function shortQuestion(q: string, max = 72): string {
  const t = q
    .replace(/^\s*\S+ asks:\s*/i, "")
    .replace(/\s+/g, " ")
    .trim()
  return t.length > max ? t.slice(0, max - 1) + "…" : t
}
