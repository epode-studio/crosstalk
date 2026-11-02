// Tokens to the first useful edit, read from Claude Code's own transcripts.
//
// A transcript is one JSON object per line. Assistant lines carry the API's
// `usage`; one API message can be split over several lines that repeat the
// same usage under the same message id, so each id counts once. The first
// useful edit is the first tool call that changes a file (Edit, Write,
// MultiEdit, NotebookEdit). Everything the model processed up to and
// including that turn is what it cost to get there.
//
// Read only, and only on this machine.

import fs from "node:fs"
import os from "node:os"
import path from "node:path"

export const EDIT_TOOLS = new Set(["Edit", "Write", "MultiEdit", "NotebookEdit", "apply_patch"])

export type FirstEdit = {
  /** Every token the model processed until the edit: input, cache writes and reads, output. */
  tokens: number
  /** The same without cache reads: what was new to the model. */
  fresh: number
  turns: number
}

/** Claude Code's data directory. */
export const claudeDir = () => process.env.CROSSTALK_CLAUDE_DIR ?? process.env.CLAUDE_CONFIG_DIR ?? path.join(os.homedir(), ".claude")

/** Tokens until the first edit, or null when the session never edited anything. */
export function firstEdit(text: string): FirstEdit | null {
  const seen = new Set<string>()
  let tokens = 0
  let fresh = 0
  let turns = 0
  for (const line of text.split("\n")) {
    if (!line.includes('"assistant"')) continue
    let o: any
    try {
      o = JSON.parse(line)
    } catch {
      continue
    }
    if (o?.type !== "assistant" || !o.message) continue
    const m = o.message
    const id = String(m.id ?? o.uuid ?? turns)
    if (!seen.has(id)) {
      seen.add(id)
      turns++
      const u = m.usage ?? {}
      const n = (k: string) => (Number.isFinite(Number(u[k])) ? Number(u[k]) : 0)
      fresh += n("input_tokens") + n("cache_creation_input_tokens") + n("output_tokens")
      tokens += n("input_tokens") + n("cache_creation_input_tokens") + n("cache_read_input_tokens") + n("output_tokens")
    }
    const content = Array.isArray(m.content) ? m.content : []
    if (content.some((c: any) => c?.type === "tool_use" && EDIT_TOOLS.has(String(c.name)))) return { tokens, fresh, turns }
  }
  return null
}

/** A session's transcript: the path its SessionStart named, else found by id under projects/. */
export function transcriptFor(sid: string, hint?: string, dir = claudeDir()): string | undefined {
  if (hint && fs.existsSync(hint)) return hint
  try {
    for (const p of fs.readdirSync(path.join(dir, "projects"))) {
      const f = path.join(dir, "projects", p, `${sid}.jsonl`)
      if (fs.existsSync(f)) return f
    }
  } catch {}
  return undefined
}

export function firstEditOf(file: string): FirstEdit | null {
  try {
    // Only the start matters; a long session's tail is never read.
    const fd = fs.openSync(file, "r")
    try {
      const buf = Buffer.alloc(Math.min(fs.fstatSync(fd).size, 16 * 1024 * 1024))
      fs.readSync(fd, buf, 0, buf.length, 0)
      return firstEdit(buf.toString("utf8"))
    } finally {
      fs.closeSync(fd)
    }
  } catch {
    return null
  }
}
