// What an edit changed, worked out in the PostToolUse hook from the file on
// disk and git, and handed to the daemon (op "edited"), which decides who
// needs to hear about it (service.ts).
//
//   symbols   the top-level symbols this edit landed in
//   pending   every top-level symbol that differs from where this branch
//             left the default branch (or from HEAD): edits not merged yet,
//             which is what two threads can conflict on
//   diff      git's diff of the file against that same base, for the slice

import fs from "node:fs"
import path from "node:path"
import { spawnSync } from "node:child_process"
import { changedSymbols, symbolsOfEdit, WHOLE } from "./outline.ts"

export type EditReport = { file: string; root: string; symbols: string[]; pending: string[]; diff: string }

const EDIT_TOOLS = /^(Edit|MultiEdit|Write|NotebookEdit|str_replace_based_edit_tool|apply_patch)$/

const MAX_DIFF = 32 * 1024

function git(cwd: string, args: string[]): { ok: boolean; out: string } {
  try {
    const r = spawnSync("git", ["-C", cwd, ...args], { encoding: "utf8", timeout: 3000, maxBuffer: 8 << 20 })
    return { ok: r.status === 0, out: r.stdout ?? "" }
  } catch {
    return { ok: false, out: "" }
  }
}

/** Where this branch's own changes start: the merge base with the remote default branch, else HEAD. */
export function baseOf(root: string): string | undefined {
  const head = git(root, ["rev-parse", "-q", "--verify", "HEAD"])
  if (!head.ok) return undefined
  for (const ref of ["refs/remotes/origin/HEAD", "refs/remotes/origin/main", "refs/remotes/origin/master"]) {
    if (!git(root, ["rev-parse", "-q", "--verify", ref]).ok) continue
    const mb = git(root, ["merge-base", "HEAD", ref])
    if (mb.ok && mb.out.trim()) return mb.out.trim()
  }
  return head.out.trim()
}

export function editReport(o: { cwd: string; tool: string; input: any }): EditReport | null {
  if (!EDIT_TOOLS.test(o.tool)) return null
  const raw = o.input?.file_path ?? o.input?.notebook_path ?? o.input?.path
  if (typeof raw !== "string" || !raw) return null
  const abs = path.resolve(o.cwd || "/", raw)
  const top = git(path.dirname(abs), ["rev-parse", "--show-toplevel"])
  if (!top.ok) return null
  const root = top.out.trim()
  const file = path.relative(root, abs).split(path.sep).join("/")
  if (!file || file.startsWith("..")) return null
  let after: string | null = null
  try {
    after = fs.readFileSync(abs, "utf8")
  } catch {}
  const base = baseOf(root)
  const before = base ? (() => {
    const r = git(root, ["show", `${base}:${file}`])
    return r.ok ? r.out : null
  })() : null
  const pending = changedSymbols(file, before, after)
  let symbols: string[] | null = null
  const news: string[] = [
    ...(typeof o.input?.new_string === "string" ? [o.input.new_string] : []),
    ...(Array.isArray(o.input?.edits) ? o.input.edits.map((e: any) => e?.new_string).filter((s: unknown) => typeof s === "string") : []),
  ]
  if (news.length && after !== null) {
    const found = news.map((n) => symbolsOfEdit(file, after!, n))
    if (found.every((f) => f !== null)) symbols = [...new Set(found.flat() as string[])]
  }
  if (!symbols || !symbols.length) symbols = pending.length ? pending : [WHOLE]
  let diff = base ? git(root, ["diff", base, "--", file]).out : ""
  if (!diff.trim()) diff = `--- /dev/null\n+++ b/${file}\n${(after ?? "").split("\n").slice(0, 200).map((l) => `+${l}`).join("\n")}\n`
  if (diff.length > MAX_DIFF) diff = diff.slice(0, MAX_DIFF) + "\n… truncated\n"
  return { file, root, symbols, pending, diff }
}
