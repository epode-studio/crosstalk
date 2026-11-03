// A new agent's first prompt goes in a file beside it, not on its command line.
//
// Terminal.app (and others) show the running command in the tab title, so an
// agent started as `claude "<the whole brief>"` gets the brief's last words as
// its title. Instead the brief is written to `.crosstalk-brief-<id>.md` in the
// agent's own folder (inside its working directory, so reading it needs no
// permission), kept out of git through the repository's info/exclude, and the
// agent is started as `claude "Start from .crosstalk-brief-<id>.md"`.
//
// Short prompts, flags (`--resume <id>`) and folders that are not a git
// checkout keep the prompt on the command line, as before.

import crypto from "node:crypto"
import fs from "node:fs"
import path from "node:path"
import { spawnSync } from "node:child_process"

export const LONG = 100
export const PATTERN = ".crosstalk-brief-*.md"

/** The repository's info/exclude for this folder, or null outside git. */
function excludeFile(cwd: string): string | null {
  const r = spawnSync("git", ["-C", cwd, "rev-parse", "--path-format=absolute", "--git-path", "info/exclude"], { encoding: "utf8", timeout: 5000 })
  const p = r.status === 0 ? r.stdout.trim() : ""
  return p && path.isAbsolute(p) ? p : null
}

/** Keep the brief files out of git, once per repository. */
function exclude(file: string): boolean {
  try {
    const now = fs.existsSync(file) ? fs.readFileSync(file, "utf8") : ""
    if (now.split("\n").some((l) => l.trim() === PATTERN)) return true
    fs.mkdirSync(path.dirname(file), { recursive: true })
    fs.appendFileSync(file, `${now && !now.endsWith("\n") ? "\n" : ""}# crosstalk: new agents' first prompts\n${PATTERN}\n`)
    return true
  } catch {
    return false
  }
}

/** The argv to start with: the prompt moved to a file when it is long, else as it was. */
export function shortArgv(argv: string[], cwd: string, o: { excludeFile?: (cwd: string) => string | null } = {}): string[] {
  if (argv.length !== 2) return argv
  const prompt = argv[1]
  if (prompt.length <= LONG || prompt.startsWith("-")) return argv
  try {
    const ex = (o.excludeFile ?? excludeFile)(cwd)
    if (!ex || !exclude(ex)) return argv
    const name = `.crosstalk-brief-${crypto.randomBytes(3).toString("hex")}.md`
    fs.writeFileSync(path.join(cwd, name), prompt.endsWith("\n") ? prompt : prompt + "\n", { mode: 0o600 })
    return [argv[0], `Start from ${name}`]
  } catch {
    return argv
  }
}
