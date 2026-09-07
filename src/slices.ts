// Context slices. A message can carry a diff, a file, or the last few turns,
// so the receiver's Claude can see what you did instead of reading a summary
// of it. The content travels sealed but is not put into the receiver's context
// until its Claude asks for that slice by name.

import crypto from "node:crypto"
import fs from "node:fs"
import path from "node:path"
import { execFileSync } from "node:child_process"
import type { Slice } from "./protocol.ts"

const MAX_SLICE_BYTES = 128 * 1024

function make(kind: Slice["kind"], label: string, content: string): Slice {
  let body = content
  if (Buffer.byteLength(body, "utf8") > MAX_SLICE_BYTES) {
    body = body.slice(0, MAX_SLICE_BYTES) + `\n… truncated at ${MAX_SLICE_BYTES} bytes`
  }
  return {
    kind,
    label,
    content: body,
    bytes: Buffer.byteLength(body, "utf8"),
    sha256: crypto.createHash("sha256").update(body).digest("hex").slice(0, 16),
  }
}

export function diffSlice(cwd: string, ref = "HEAD"): Slice | null {
  try {
    const out = execFileSync("git", ["diff", ref], { cwd, encoding: "utf8", maxBuffer: 8 << 20 })
    if (!out.trim()) return null
    return make("diff", `git diff ${ref} in ${cwd}`, out)
  } catch {
    return null
  }
}

const SECRET_PATTERNS = [
  /(^|\/)\.env(\.|$)/i,
  /(^|\/)\.ssh\//,
  /(^|\/)\.aws\//,
  /(^|\/)\.gnupg\//,
  /(^|\/)\.netrc$/,
  /(^|\/)\.npmrc$/,
  /(^|\/)id_(rsa|dsa|ecdsa|ed25519)$/,
  /\.(pem|key|p12|pfx|keystore)$/i,
  /(^|\/)credentials(\.json)?$/i,
  /(^|\/)\.claude\/(crosstalk|\.credentials)/,
  /(^|\/)secrets?\b/i,
]

export class SliceRefused extends Error {}

/**
 * A peer cannot read your files, but a peer can ask your Claude to send one.
 * Keep the obvious secrets out of reach and stay inside the working tree.
 */
export function fileSlice(file: string, root?: string): Slice | null {
  const full = path.resolve(file)
  if (SECRET_PATTERNS.some((re) => re.test(full)))
    throw new SliceRefused(
      `refusing to attach ${file}: it looks like a credential. If you really mean to send it, paste the specific lines instead.`,
    )
  if (root) {
    const base = path.resolve(root)
    if (full !== base && !full.startsWith(base + path.sep))
      throw new SliceRefused(
        `refusing to attach ${file}: it is outside ${base}. Attach files from the project you are working in.`,
      )
  }
  try {
    return make("file", full, fs.readFileSync(full, "utf8"))
  } catch {
    return null
  }
}

/**
 * The last N exchanges from a session's own transcript. Only ever the sending
 * session's own transcript, and only when the sender asks for it, this is the
 * one place crosstalk touches conversation content, so it stays explicit.
 */
export function turnsSlice(transcriptPath: string, turns = 6): Slice | null {
  try {
    const raw = fs.readFileSync(transcriptPath, "utf8").trimEnd().split("\n")
    const picked: string[] = []
    for (let i = raw.length - 1; i >= 0 && picked.length < turns * 2; i--) {
      try {
        const r = JSON.parse(raw[i])
        if (r.type !== "user" && r.type !== "assistant") continue
        const c = r.message?.content
        const text =
          typeof c === "string"
            ? c
            : Array.isArray(c)
              ? c.map((x: any) => x.text ?? `[${x.type}]`).join(" ")
              : ""
        if (!text.trim()) continue
        picked.unshift(`${r.type}: ${text.slice(0, 2000)}`)
      } catch {
        continue
      }
    }
    if (!picked.length) return null
    return make("turns", `last ${picked.length} turns`, picked.join("\n\n"))
  } catch {
    return null
  }
}

export const textSlice = (label: string, content: string) => make("text", label, content)
