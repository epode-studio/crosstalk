// Teammates install nothing (docs/design/next-generation.md, "Installing").
//
// In a repo where crosstalk is in use (it has threads here) and repo trust is
// connected (the person said yes to first use), crosstalk asks once:
//
//   "Turn crosstalk on for everyone who clones <repo>?"   Turn it on / Not now
//
// Yes merges two keys into the repo's .claude/settings.json, the project
// settings Claude Code reads for everyone who opens the repo
// (code.claude.com/docs/en/settings-reference, extraKnownMarketplaces and
// enabledPlugins; "Require plugins per repository" in plugins/org):
//
//   "extraKnownMarketplaces": { "epode": { "source": { "source": "github", "repo": "epode-studio/crosstalk" } } }
//   "enabledPlugins": { "crosstalk@epode": true }
//
// crosstalk's marketplace lists the plugin by a relative path, so it loads
// from the marketplace copy once a teammate accepts the folder's workspace
// trust dialog: nothing else to run. Every other key, and any value someone
// already set for these two (a `false` included), is left exactly as it was.
//
// The change is left unstaged for the person to commit, unless the repo's
// .crosstalk/ship names a push mode, in which case it goes through shipping's
// own path for a one-file change on the default branch (a commit, a PR or a
// push, as that mode says).

import fs from "node:fs"
import path from "node:path"
import { ROOT } from "../config.ts"
import { loadShip, SHIP_FILE } from "../shipping/config.ts"
import { commitToDefault } from "../shipping/merge.ts"

export const MARKETPLACE = "epode"
export const PLUGIN = "crosstalk@epode"
export const SOURCE = { source: "github", repo: "epode-studio/crosstalk" } as const
export const SETTINGS = path.join(".claude", "settings.json")
export const YES = "Turn it on"
export const NO = "Not now"

export const installId = (slug: string) => `install:${slug}`
export const questionText = (slug: string) => `Turn crosstalk on for everyone who clones ${slug}?`

export type Merge = { settings: Record<string, any>; changed: boolean; kept: string[] }

/** The two keys merged into whatever is there. Nothing already set is replaced. */
export function mergeSettings(existing: Record<string, any>): Merge {
  const out: Record<string, any> = JSON.parse(JSON.stringify(existing ?? {}))
  const kept: string[] = []
  let changed = false
  const m = out.extraKnownMarketplaces
  if (m !== undefined && (typeof m !== "object" || Array.isArray(m) || m === null)) kept.push("extraKnownMarketplaces is not an object, so it was left alone")
  else {
    out.extraKnownMarketplaces ??= {}
    if (out.extraKnownMarketplaces[MARKETPLACE] === undefined) {
      out.extraKnownMarketplaces[MARKETPLACE] = { source: { ...SOURCE } }
      changed = true
    } else if (JSON.stringify(out.extraKnownMarketplaces[MARKETPLACE]?.source) !== JSON.stringify(SOURCE))
      kept.push(`a marketplace named ${MARKETPLACE} is already set to something else`)
  }
  const e = out.enabledPlugins
  if (e !== undefined && (typeof e !== "object" || Array.isArray(e) || e === null)) kept.push("enabledPlugins is not an object, so it was left alone")
  else {
    out.enabledPlugins ??= {}
    if (out.enabledPlugins[PLUGIN] === undefined) {
      out.enabledPlugins[PLUGIN] = true
      changed = true
    } else if (out.enabledPlugins[PLUGIN] !== true) kept.push(`${PLUGIN} is set to ${JSON.stringify(out.enabledPlugins[PLUGIN])} here, and that was left as it is`)
  }
  return { settings: out, changed, kept }
}

/** Whether the repo's settings already turn crosstalk on. */
export function enabled(root: string): boolean {
  try {
    const s = JSON.parse(fs.readFileSync(path.join(root, SETTINGS), "utf8"))
    return s?.enabledPlugins?.[PLUGIN] === true && !!s?.extraKnownMarketplaces?.[MARKETPLACE]
  } catch {
    return false
  }
}

export type Applied = { ok: boolean; text: string; committed?: boolean }

/** Yes: merge, then leave it unstaged, or commit it the way .crosstalk/ship says. */
export function apply(root: string, o: { slug?: string; commit?: typeof commitToDefault } = {}): Applied {
  const f = path.join(root, SETTINGS)
  let existing: Record<string, any> = {}
  if (fs.existsSync(f)) {
    try {
      existing = JSON.parse(fs.readFileSync(f, "utf8"))
    } catch {
      return { ok: false, text: `${SETTINGS} in ${path.basename(root)} is not valid JSON, so crosstalk did not touch it. Fix it and ask again.` }
    }
    if (!existing || typeof existing !== "object" || Array.isArray(existing)) return { ok: false, text: `${SETTINGS} is not a JSON object, so crosstalk did not touch it.` }
  }
  const m = mergeSettings(existing)
  const note = m.kept.length ? ` Left alone: ${m.kept.join("; ")}.` : ""
  if (!m.changed) return { ok: true, text: `◢ crosstalk: ${SETTINGS} already turns crosstalk on.${note}` }
  const content = JSON.stringify(m.settings, null, 2) + "\n"
  const ship = fs.existsSync(path.join(root, SHIP_FILE)) ? loadShip(root) : undefined
  if (ship?.push) {
    const r = (o.commit ?? commitToDefault)(root, SETTINGS, content, "Turn crosstalk on for everyone who clones this repo", { push: ship.push })
    if (r.ok) return { ok: true, committed: true, text: `◢ crosstalk: turned crosstalk on for everyone who clones ${o.slug ?? path.basename(root)}: ${SETTINGS} ${r.text} (as ${SHIP_FILE} says).${note}` }
    // Falls back to the working tree: the person can still commit it.
  }
  fs.mkdirSync(path.dirname(f), { recursive: true })
  fs.writeFileSync(f, content)
  return {
    ok: true,
    text: `◢ crosstalk: wrote ${SETTINGS} in ${path.basename(root)} so everyone who clones ${o.slug ?? "it"} gets crosstalk once they trust the folder. It is an unstaged change: commit it to turn it on for them (git add ${SETTINGS} && git commit).${note}`,
  }
}

// --- asked once per repo ------------------------------------------------------------

type State = { v: 1; repos: Record<string, { state: "asked" | "yes" | "no"; at: number; root: string }> }
const file = () => path.join(process.env.CROSSTALK_HOME ?? ROOT, "install.json")

export function load(): State {
  try {
    const s = JSON.parse(fs.readFileSync(file(), "utf8"))
    if (s?.v === 1 && s.repos) return s
  } catch {}
  return { v: 1, repos: {} }
}

export function save(s: State) {
  fs.mkdirSync(path.dirname(file()), { recursive: true, mode: 0o700 })
  const tmp = `${file()}.${process.pid}.tmp`
  fs.writeFileSync(tmp, JSON.stringify(s, null, 2), { mode: 0o600 })
  fs.renameSync(tmp, file())
}

/** Whether to ask now: crosstalk in use, repo trust connected, not enabled yet, never asked. */
export function shouldOffer(o: { slug: string; root: string; inUse: boolean; connected: boolean }, s = load()): boolean {
  if (process.env.CROSSTALK_NO_TEAM_INSTALL === "1") return false
  if (!o.inUse || !o.connected || s.repos[o.slug]) return false
  return !enabled(o.root)
}

export function markAsked(slug: string, root: string, now = Date.now()) {
  const s = load()
  s.repos[slug] = { state: "asked", at: now, root }
  save(s)
}

/** The answer, from the picker or crosstalk_team_install. */
export function answer(slug: string | undefined, yes: boolean, o: { root?: string; now?: number; commit?: typeof commitToDefault } = {}): Applied {
  const s = load()
  const name = slug ?? Object.entries(s.repos).filter(([, e]) => e.state === "asked").sort((a, b) => b[1].at - a[1].at)[0]?.[0]
  const root = o.root ?? (name ? s.repos[name]?.root : undefined)
  if (!root) return { ok: false, text: "no repo to turn crosstalk on in: run it from inside the repo" }
  const key = name ?? path.basename(root)
  s.repos[key] = { state: yes ? "yes" : "no", at: o.now ?? Date.now(), root }
  save(s)
  if (!yes) return { ok: true, text: `Not now. crosstalk will not ask about ${key} again; say "turn crosstalk on for this repo" any time.` }
  return apply(root, { slug: key, commit: o.commit })
}
