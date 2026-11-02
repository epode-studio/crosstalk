// Copying the selected files (select.ts) into a worktree.
//
// Copied, never linked: an agent in the worktree may write to its .env, and a
// link would write the main checkout's. A file already there is left alone.
// The destination is made inside the worktree only: a folder on the way that
// is a symlink, or that resolves outside the worktree, refuses the file, and
// the file itself is created exclusively (O_EXCL), so a symlink planted where
// it goes is not written through. The source is opened without following a
// symlink. Its mode is kept (a 0600 .env stays 0600).
//
// What is returned and logged is file names. Contents never leave this
// module: not into a thread, the relay, a log or a tool result.

import fs from "node:fs"
import path from "node:path"
import type { Candidate, Git } from "./select.ts"
import { ignored, git as liveGit } from "./select.ts"

export type CopyResult = { copied: string[]; present: string[]; refused: { rel: string; why: string }[] }

function within(root: string, p: string) {
  return p === root || p.startsWith(root + path.sep)
}

/** Whether a folder on the way to `rel` in `worktree` is a symlink (or not a folder), without making anything. */
function throughLink(worktree: string, rel: string): boolean {
  let cur = worktree
  for (const part of rel.split("/").slice(0, -1)) {
    cur = path.join(cur, part)
    try {
      const st = fs.lstatSync(cur)
      if (st.isSymbolicLink() || !st.isDirectory()) return true
    } catch {
      return false
    }
  }
  return false
}

/** Make the folders for `rel` inside `worktree`, refusing any symlinked or outside step. */
function parentIn(worktree: string, rel: string): string | null {
  const parts = rel.split("/").slice(0, -1)
  let cur = worktree
  for (const part of parts) {
    if (!part || part === "." || part === "..") return null
    cur = path.join(cur, part)
    let st: fs.Stats | null = null
    try {
      st = fs.lstatSync(cur)
    } catch {}
    if (!st) fs.mkdirSync(cur, { mode: 0o755 })
    else if (st.isSymbolicLink() || !st.isDirectory()) return null
  }
  return cur
}

export function copyInto(o: { main: string; worktree: string; files: Candidate[]; git?: Git }): CopyResult {
  const out: CopyResult = { copied: [], present: [], refused: [] }
  let realWt: string
  try {
    realWt = fs.realpathSync(o.worktree)
  } catch {
    return out
  }
  if (path.resolve(o.main) === path.resolve(o.worktree)) return out
  // Ignored in the worktree too, so a copy never shows up in its git status (its commit may ignore less).
  const need = o.files.filter((f) => {
    if (throughLink(o.worktree, f.rel)) {
      out.refused.push({ rel: f.rel, why: "a folder on the way is a symlink" })
      return false
    }
    try {
      fs.lstatSync(path.join(o.worktree, f.rel))
      out.present.push(f.rel)
      return false
    } catch {
      return true
    }
  })
  const ign = ignored(o.worktree, need.map((f) => f.rel), o.git ?? liveGit)
  for (const f of need) {
    if (!ign.has(f.rel)) {
      out.refused.push({ rel: f.rel, why: "not ignored by git in the worktree" })
      continue
    }
    const parent = parentIn(o.worktree, f.rel)
    if (!parent) {
      out.refused.push({ rel: f.rel, why: "a folder on the way is a symlink" })
      continue
    }
    try {
      if (!within(realWt, fs.realpathSync(parent))) {
        out.refused.push({ rel: f.rel, why: "outside the worktree" })
        continue
      }
    } catch {
      continue
    }
    let fd: number | undefined
    try {
      fd = fs.openSync(path.join(o.main, f.rel), fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW ?? 0))
      const st = fs.fstatSync(fd)
      if (!st.isFile() || st.size > 1024 * 1024) {
        out.refused.push({ rel: f.rel, why: "not a regular file" })
        continue
      }
      const buf = fs.readFileSync(fd)
      const mode = st.mode & 0o7777
      const dst = path.join(parent, path.basename(f.rel))
      fs.writeFileSync(dst, buf, { flag: "wx", mode })
      fs.chmodSync(dst, mode)
      out.copied.push(f.rel)
    } catch (e) {
      const code = (e as NodeJS.ErrnoException).code
      if (code === "EEXIST") out.present.push(f.rel)
      else out.refused.push({ rel: f.rel, why: code === "ELOOP" ? "a symlink (never followed)" : "could not be copied" })
    } finally {
      if (fd !== undefined) fs.closeSync(fd)
    }
  }
  return out
}
