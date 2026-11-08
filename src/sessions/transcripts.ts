// Claude Code's own transcripts, read-only.
//
// Every Claude Code session, crosstalk or not, leaves one JSON line per event
// in <config>/projects/<folder>/<session id>.jsonl, where <config> is
// CLAUDE_CONFIG_DIR or ~/.claude and <folder> is the session's folder with
// every character that is not a letter or digit made "-". Each line carries
// the session's folder (cwd), its git branch and a timestamp; the person's
// prompts, the agent's answers and its tool calls (with the files they named)
// are in there too, and /rename leaves a `custom-title` line.
//
// Only the head and the tail of a file are read: a long session's transcript
// is tens of megabytes, and the folder, the start, the end, the title, the
// recap and the last files touched are all in its first and last few hundred
// kilobytes. Nothing is ever written here.

import fs from "node:fs"
import path from "node:path"
import { claudeConfigDir } from "../registry.ts"
import * as recap from "../attention/recap.ts"

export const projectsDir = (env: NodeJS.ProcessEnv = process.env) => path.join(claudeConfigDir(env), "projects")

/** The folder name Claude Code files a session's transcript under. */
export const projectSlug = (cwd: string) => cwd.replace(/[^A-Za-z0-9]/g, "-")

const HEAD_BYTES = 64 * 1024
const TAIL_BYTES = 256 * 1024

function head(file: string, bytes = HEAD_BYTES): string {
  let fd = -1
  try {
    fd = fs.openSync(file, "r")
    const buf = Buffer.alloc(Math.min(bytes, fs.fstatSync(fd).size))
    fs.readSync(fd, buf, 0, buf.length, 0)
    const text = buf.toString("utf8")
    // The last line may be cut: drop it unless the whole file was read.
    return buf.length === bytes ? text.slice(0, text.lastIndexOf("\n") + 1) : text
  } catch {
    return ""
  } finally {
    if (fd >= 0) fs.closeSync(fd)
  }
}

/** Where a session's transcript is: under its folder's slug, else wherever a file of that id is. */
export function transcriptOf(sessionId: string, cwd?: string, env: NodeJS.ProcessEnv = process.env): string | null {
  if (!/^[A-Za-z0-9._-]+$/.test(sessionId)) return null
  const root = projectsDir(env)
  if (cwd) {
    const f = path.join(root, projectSlug(cwd), `${sessionId}.jsonl`)
    if (fs.existsSync(f)) return f
  }
  try {
    for (const d of fs.readdirSync(root)) {
      const f = path.join(root, d, `${sessionId}.jsonl`)
      if (fs.existsSync(f)) return f
    }
  } catch {}
  return null
}

export type Summary = {
  sessionId: string
  cwd: string
  branch?: string
  title?: string
  recap?: string
  files: string[]
  startedAt?: number
  endedAt?: number
  file: string
}

const ts = (e: any): number | undefined => {
  const t = typeof e?.timestamp === "string" ? Date.parse(e.timestamp) : NaN
  return Number.isFinite(t) ? t : undefined
}

/** The files a tool call named: Read, Edit, Write, NotebookEdit and the like. */
function filesOf(e: any): string[] {
  const c = e?.message?.content
  if (!Array.isArray(c)) return []
  const out: string[] = []
  for (const b of c) {
    if (b?.type !== "tool_use" || !b.input || typeof b.input !== "object") continue
    for (const k of ["file_path", "notebook_path", "path"]) if (typeof b.input[k] === "string" && b.input[k].length < 1024) out.push(b.input[k])
  }
  return out
}

/** One transcript, summed up from its head and tail. Null when it is not a session's (no folder). */
export function summarize(file: string): Summary | null {
  const first = recap.lines(head(file))
  const last = recap.lines(recap.tail(file, TAIL_BYTES))
  const all = [...first, ...last]
  const withCwd = all.find((e) => typeof e?.cwd === "string" && e.cwd)
  if (!withCwd) return null
  const sessionId = String(withCwd.sessionId ?? path.basename(file, ".jsonl"))
  let title: string | undefined
  let summaryLine: string | undefined
  let branch: string | undefined
  for (const e of all) {
    if (e?.type === "custom-title" && typeof e.customTitle === "string") title = e.customTitle
    if (e?.type === "summary" && typeof e.summary === "string") summaryLine = e.summary
    if (typeof e?.gitBranch === "string" && e.gitBranch && e.gitBranch !== "HEAD") branch = e.gitBranch
  }
  const files: string[] = []
  for (let i = last.length - 1; i >= 0 && files.length < 30; i--) {
    if (last[i]?.isSidechain) continue
    for (const f of filesOf(last[i])) if (!files.includes(f)) files.push(f)
  }
  const cwd = String(withCwd.cwd)
  const rel = files.map((f) => (f.startsWith(cwd + path.sep) ? f.slice(cwd.length + 1) : f))
  let startedAt: number | undefined
  for (const e of first) if ((startedAt = ts(e))) break
  let endedAt: number | undefined
  for (let i = last.length - 1; i >= 0; i--) if ((endedAt = ts(last[i]))) break
  if (!endedAt)
    try {
      endedAt = fs.statSync(file).mtimeMs
    } catch {}
  const r = recap.extract(last.filter((e) => !e?.isSidechain))
  return {
    sessionId,
    cwd,
    ...(branch ? { branch } : {}),
    ...(title || summaryLine ? { title: title ?? summaryLine } : {}),
    ...(r ? { recap: r } : {}),
    files: rel,
    ...(startedAt ? { startedAt } : {}),
    ...(endedAt ? { endedAt } : {}),
    file,
  }
}

/**
 * The most recent transcripts, newest first, at most `limit`. Subagents'
 * transcripts (agent-*.jsonl, and those in a session's own subfolder) are not
 * sessions anyone resumes.
 */
export function recent(env: NodeJS.ProcessEnv = process.env, limit = 400): string[] {
  const root = projectsDir(env)
  const found: { f: string; m: number }[] = []
  let dirs: string[] = []
  try {
    dirs = fs.readdirSync(root)
  } catch {
    return []
  }
  for (const d of dirs) {
    let names: string[] = []
    try {
      names = fs.readdirSync(path.join(root, d))
    } catch {
      continue
    }
    for (const n of names) {
      if (!n.endsWith(".jsonl") || n.startsWith("agent-")) continue
      const f = path.join(root, d, n)
      try {
        found.push({ f, m: fs.statSync(f).mtimeMs })
      } catch {}
    }
  }
  return found
    .sort((a, b) => b.m - a.m)
    .slice(0, limit)
    .map((x) => x.f)
}

/** Lines Claude Code writes as the user that the person did not type, or that came from elsewhere (a channel, a hook). */
// Also what crosstalk's mod submitted for the person (a handed message, tackling open items):
// never counted as their own words for anything that needs them.
const NOT_TYPED = /^\s*(<|Caveat:|\[Request interrupted|I handed you the crosstalk message|Tackle the open items you listed|◢ crosstalk)/

/**
 * The last prompt the person typed in a session, and when. Tool results,
 * Claude Code's own meta lines and anything that arrived wrapped in a tag
 * (a channel message, a hook's context, a command) are not typed.
 */
export function lastPrompt(file: string | null): { text: string; at: number } | null {
  if (!file) return null
  const es = recap.lines(recap.tail(file, TAIL_BYTES))
  for (let i = es.length - 1; i >= 0; i--) {
    const e = es[i]
    if (!e || e.isMeta || e.isSidechain || e.toolUseResult !== undefined) continue
    if ((e.message?.role ?? e.type) !== "user") continue
    const c = e.message?.content
    if (Array.isArray(c) && c.some((b: any) => b?.type === "tool_result")) continue
    const text = recap.textOf(c).trim()
    if (!text || NOT_TYPED.test(text)) continue
    return { text, at: ts(e) ?? 0 }
  }
  return null
}

/**
 * The question a session's agent has put to the person and is waiting on
 * (Claude Code's AskUserQuestion with no answer yet), from its transcript's
 * tail: the question and its options' labels. Null when none is open.
 */
export function openQuestion(file: string | null): { question: string; options: string[]; at: number } | null {
  if (!file) return null
  const es = recap.lines(recap.tail(file, 64 * 1024))
  const answered = new Set<string>()
  for (let i = es.length - 1; i >= 0; i--) {
    const c = es[i]?.message?.content
    if (!Array.isArray(c)) continue
    for (const b of c) if (b?.type === "tool_result" && typeof b.tool_use_id === "string") answered.add(b.tool_use_id)
    for (const b of c) {
      if (b?.type !== "tool_use" || b.name !== "AskUserQuestion") continue
      if (answered.has(b.id)) return null // the latest one is answered: nothing open
      const q = Array.isArray(b.input?.questions) ? b.input.questions[0] : null
      if (!q || typeof q.question !== "string") return null
      const options = Array.isArray(q.options) ? q.options.map((o: any) => String(o?.label ?? "")).filter(Boolean).slice(0, 4) : []
      return { question: q.question.replace(/\s+/g, " ").trim().slice(0, 300), options, at: ts(es[i]) ?? 0 }
    }
  }
  return null
}
