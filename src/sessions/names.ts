// Names the person gave sessions ("call the api one billing"). One small file,
// read by the hook (the session's title on its next event), the daemon (what
// the session is called when it registers again) and the session list.

import fs from "node:fs"
import path from "node:path"
import { P } from "../config.ts"

const file = () => path.join(P.root, "sessions", "names.json")

export function all(): Record<string, string> {
  try {
    const o = JSON.parse(fs.readFileSync(file(), "utf8"))
    return o && typeof o === "object" ? o : {}
  } catch {
    return {}
  }
}

export const nameOf = (sessionId: string): string | undefined => {
  const n = all()[sessionId]
  return typeof n === "string" && n ? n : undefined
}

/** A name a person can type and a tab can show: printable, one line, short. */
export function clean(name: string): string {
  return String(name ?? "")
    .normalize("NFKC")
    .replace(/[\u0000-\u001f\u007f-\u009f]/g, "")
    .replace(/[^\p{L}\p{N} ._@:-]+/gu, "-")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 40)
}

export function setName(sessionId: string, name: string | null) {
  const o = all()
  if (name) o[sessionId] = name
  else delete o[sessionId]
  // Only the newest few hundred: a name for a session long gone does no harm, but need not stay forever.
  const keep = Object.entries(o).slice(-500)
  fs.mkdirSync(path.dirname(file()), { recursive: true, mode: 0o700 })
  const tmp = `${file()}.${process.pid}.tmp`
  fs.writeFileSync(tmp, JSON.stringify(Object.fromEntries(keep), null, 2), { mode: 0o600 })
  fs.renameSync(tmp, file())
}
