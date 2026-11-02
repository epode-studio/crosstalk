// Recaps: what a session has been doing, in a line, from its own last turns.
//
// docs/design/next-generation.md, "Recap". A session's files usually say which
// thread it is in (src/threads/infer.ts). When they do not (it touches two
// threads' files equally, or files no thread covers yet), what it was asked and
// what it answered is the tiebreaker: the words of its last turns against each
// candidate thread's recap and name.
//
// No model by default: the recap is the last user prompt and the last
// assistant answer from the transcript, cut short. With CROSSTALK_RECAP_MODEL
// set (e.g. "haiku"), `claude -p --model <it>` summarises those two in one
// sentence instead, in the background, and the line it writes replaces the
// extract once it arrives.
//
// The transcript is only ever read from its tail: a long session's file is
// tens of megabytes, and the last turns are all a recap needs.

import fs from "node:fs"
import { spawn } from "node:child_process"

/** How much of the end of a transcript is read. */
export const TAIL_BYTES = 512 * 1024
export const USER_MAX = 200
export const ASSISTANT_MAX = 300
export const RECAP_MAX = 600

/** The last `bytes` of a file, starting at a line boundary. Empty when unreadable. */
export function tail(file: string | undefined, bytes = TAIL_BYTES): string {
  if (!file) return ""
  let fd = -1
  try {
    fd = fs.openSync(file, "r")
    const size = fs.fstatSync(fd).size
    const start = Math.max(0, size - bytes)
    const buf = Buffer.alloc(size - start)
    fs.readSync(fd, buf, 0, buf.length, start)
    const text = buf.toString("utf8")
    return start > 0 ? text.slice(text.indexOf("\n") + 1) : text
  } catch {
    return ""
  } finally {
    if (fd >= 0) fs.closeSync(fd)
  }
}

/** Each JSON line that parses, in order. */
export function lines(text: string): any[] {
  const out: any[] = []
  for (const l of text.split("\n")) {
    if (!l.trim()) continue
    try {
      out.push(JSON.parse(l))
    } catch {}
  }
  return out
}

/** The plain text of a message's content: a string, or its text blocks. Tool results and tool calls are not words the person or agent said. */
export function textOf(content: unknown): string {
  if (typeof content === "string") return content
  if (!Array.isArray(content)) return ""
  return content
    .filter((b) => b && typeof b === "object" && (b as any).type === "text" && typeof (b as any).text === "string")
    .map((b) => (b as any).text as string)
    .join("\n")
}

const oneLine = (s: string) => s.replace(/\s+/g, " ").trim()
export const cut = (s: string, n: number) => (s.length > n ? s.slice(0, n - 1).trimEnd() + "…" : s)

/** Lines Claude Code writes as the user that the person did not type. */
const NOT_TYPED = /^(<command-|<local-command|<system-reminder>|Caveat:|\[Request interrupted)/

/** The last prompt the person typed and the last thing the agent said, from transcript entries. */
export function lastTurns(entries: any[]): { user?: string; assistant?: string } {
  let user: string | undefined
  let assistant: string | undefined
  for (let i = entries.length - 1; i >= 0 && (!user || !assistant); i--) {
    const e = entries[i]
    if (!e || e.isMeta || e.isSidechain) continue
    const role = e.message?.role ?? e.type
    const text = oneLine(textOf(e.message?.content))
    if (!text) continue
    if (role === "assistant" && !assistant) assistant = text
    else if (role === "user" && !user && !NOT_TYPED.test(text)) user = text
  }
  return { user, assistant }
}

/** The recap from a transcript's last turns, or "" when it has none yet. */
export function extract(entries: any[]): string {
  const { user, assistant } = lastTurns(entries)
  const parts = [user ? cut(user, USER_MAX) : "", assistant ? cut(assistant, ASSISTANT_MAX) : ""].filter(Boolean)
  return cut(parts.join(" — "), RECAP_MAX)
}

export const fromTranscript = (file: string | undefined) => extract(lines(tail(file)))

// --- words --------------------------------------------------------------------

const STOP = new Set(
  (
    "a an the and or but of to in on at by for from with into onto over under is are was were be been being am it its this that these those " +
    "i you we they he she me my our your their them us so if then than as do does did done doing have has had having can could would should will " +
    "shall may might must not no yes ok okay please thanks thank just also very really let lets let's here there what which who whom when where why how " +
    "now all any some more most other such only own same too up down out off again further once about after before while because until both each few " +
    "file files code change changes changed make made use used using want need get got go going see look fix fixed fixing add added adding sure done"
  ).split(" "),
)

/** The words that say what something is about: lower case, no stop words, crude stems. */
export function words(s: string): Set<string> {
  const out = new Set<string>()
  for (const raw of String(s ?? "").toLowerCase().split(/[^a-z0-9]+/)) {
    if (raw.length < 3 || STOP.has(raw) || /^\d+$/.test(raw)) continue
    out.add(stem(raw))
  }
  return out
}

/** tokens → token, refreshing → refresh, expiry stays: enough for overlap, not linguistics. */
export function stem(w: string): string {
  if (w.length > 5 && w.endsWith("ing")) return w.slice(0, -3)
  if (w.length > 4 && w.endsWith("ies")) return w.slice(0, -3) + "y"
  if (w.length > 4 && w.endsWith("es") && /(ss|sh|ch|x)es$/.test(w)) return w.slice(0, -2)
  if (w.length > 3 && w.endsWith("s") && !w.endsWith("ss")) return w.slice(0, -1)
  if (w.length > 5 && w.endsWith("ed")) return w.slice(0, -2)
  return w
}

/** How many of a recap's words a thread's text shares. */
export function overlap(recap: string, other: string): number {
  const a = words(recap)
  const b = words(other)
  let n = 0
  for (const w of a) if (b.has(w)) n++
  return n
}

export type Candidate = { id: string; name: string; text: string }

/**
 * Which candidate a recap points at, or undefined when none clearly does.
 *
 *   ask      the files already narrowed it to exactly these: the most shared
 *            words wins, if at least one and strictly more than the next
 *   create   the files point at no thread: joining one instead of starting a
 *            new thread needs a stronger signal, three shared words
 */
export function tiebreak(recap: string, cands: Candidate[], mode: "ask" | "create" = "ask", min = mode === "create" ? 3 : 1): { id: string; score: number; shared: string[] } | undefined {
  if (!recap.trim() || !cands.length) return undefined
  const mine = words(recap)
  const scored = cands
    .map((c) => {
      const theirs = words(`${c.name.replace(/-/g, " ")} ${c.text}`)
      const shared = [...mine].filter((w) => theirs.has(w))
      return { id: c.id, score: shared.length, shared }
    })
    .sort((x, y) => y.score - x.score)
  const best = scored[0]
  if (!best || best.score < min) return undefined
  if (scored[1] && scored[1].score >= best.score) return undefined
  return best
}

// --- the optional model summary ---------------------------------------------------

export const recapModel = (env: NodeJS.ProcessEnv = process.env) => (env.CROSSTALK_RECAP_MODEL ?? "").trim()

export const summaryPrompt = (extracted: string) =>
  `In one plain sentence of at most 25 words, say what this coding session is working on. Only the sentence.\n\n${extracted}`

/**
 * Summarise with `claude -p --model <model>`, in the background. Calls back with
 * the sentence, or not at all when it fails or takes longer than a minute.
 */
export function summarise(extracted: string, model: string, done: (line: string) => void, bin = process.env.CROSSTALK_CLAUDE_BIN ?? "claude") {
  if (!extracted || !model) return
  try {
    const p = spawn(bin, ["-p", "--model", model, summaryPrompt(extracted)], {
      stdio: ["ignore", "pipe", "ignore"],
      // Its own hooks would register it as a session of its own.
      env: { ...process.env, CROSSTALK_NO_TERM: "1", CROSSTALK_NO_RESTORE: "1", CROSSTALK_NO_ATTENTION: "1" },
    })
    let out = ""
    const t = setTimeout(() => p.kill("SIGTERM"), 60_000)
    p.stdout?.on("data", (d) => (out += d))
    p.on("error", () => clearTimeout(t))
    p.on("close", (code) => {
      clearTimeout(t)
      const line = oneLine(out)
      if (code === 0 && line) done(cut(line, RECAP_MAX))
    })
  } catch {}
}
