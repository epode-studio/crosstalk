// Flags instead of staging. Merged means in main and off; shipped means on.
//
// A stage is one of: off, internal (your own accounts), N% (of everyone), on.
//
// The built-in flags file, `.crosstalk/flags`, is for teams with no provider.
// The app reads it at deploy, so turning a flag off takes as long as a deploy.
// Either form is read, and written back in the form it was in:
//
//   # .crosstalk/flags
//   login-v2: internal
//   new-billing: 10%
//
//   { "login-v2": "internal", "new-billing": "10%" }
//
// crosstalk changes it with a commit on the default branch (merge.ts).

export type Stage = "off" | "internal" | "on" | `${number}%`

export const FLAGS_FILE = ".crosstalk/flags"

/** A stage from what someone wrote, or undefined when it is not one. */
export function parseStage(v: unknown): Stage | undefined {
  if (typeof v === "boolean") return v ? "on" : "off"
  if (typeof v === "number") v = `${v}%`
  if (typeof v !== "string") return undefined
  const s = v.trim().toLowerCase()
  if (["off", "false", "disabled", "0", "0%"].includes(s)) return "off"
  if (["on", "true", "enabled", "100", "100%", "everyone"].includes(s)) return "on"
  if (["internal", "dogfood", "team"].includes(s)) return "internal"
  const m = /^(\d{1,3}(?:\.\d+)?)\s*%?$/.exec(s)
  if (m) {
    const n = Number(m[1])
    if (n <= 0) return "off"
    if (n >= 100) return "on"
    return `${n}%` as Stage
  }
  return undefined
}

/** How far out a stage is: off 0, internal 0.5, N% N, on 100. */
export function order(s: Stage): number {
  if (s === "off") return 0
  if (s === "internal") return 0.5
  if (s === "on") return 100
  return Number(s.slice(0, -1))
}

export const percent = (s: Stage) => (s === "on" ? 100 : s === "off" || s === "internal" ? 0 : Number(s.slice(0, -1)))

/** The step after this one on the ramp, or undefined at the end. */
export function nextStage(current: Stage, ramp: string[]): Stage | undefined {
  const steps = ramp.map(parseStage).filter((s): s is Stage => !!s && s !== "off")
  if (!steps.includes("on")) steps.push("on")
  return steps.find((s) => order(s) > order(current))
}

export const isUp = (from: Stage, to: Stage) => order(to) > order(from)

export type FlagsFile = { form: "json" | "lines"; flags: Record<string, Stage>; header: string[] }

export function parseFlags(text: string): FlagsFile {
  const t = text.trim()
  if (t.startsWith("{")) {
    try {
      const o = JSON.parse(t)
      const src = o && typeof o.flags === "object" ? o.flags : o
      const flags: Record<string, Stage> = {}
      for (const [k, v] of Object.entries(src ?? {})) {
        const s = parseStage(v && typeof v === "object" ? (v as any).stage ?? (v as any).value : v)
        if (s) flags[k] = s
      }
      return { form: "json", flags, header: [] }
    } catch {}
  }
  const flags: Record<string, Stage> = {}
  const header: string[] = []
  let seen = false
  for (const raw of text.split("\n")) {
    const line = raw.replace(/(^|\s)#.*$/, "").trim()
    if (!line) {
      if (!seen && raw.trim().startsWith("#")) header.push(raw.trimEnd())
      continue
    }
    const m = /^([A-Za-z0-9._/-]+)\s*[:=]\s*(.+)$/.exec(line)
    if (!m) continue
    const s = parseStage(m[2])
    if (s) {
      flags[m[1]] = s
      seen = true
    }
  }
  return { form: "lines", flags, header }
}

export function renderFlags(f: FlagsFile): string {
  const names = Object.keys(f.flags).sort()
  if (f.form === "json") return JSON.stringify(Object.fromEntries(names.map((n) => [n, f.flags[n]])), null, 2) + "\n"
  const head = f.header.length ? f.header : ["# Feature flags, read by the app at deploy. crosstalk changes this with a commit.", "# Each line: name: off | internal | N% | on"]
  return [...head, ...names.map((n) => `${n}: ${f.flags[n]}`)].join("\n") + "\n"
}

/** The file with one flag set; a new file is written in the simple form. */
export function setFlag(text: string | undefined, name: string, stage: Stage): string {
  const f = text?.trim() ? parseFlags(text) : { form: "lines" as const, flags: {}, header: [] }
  f.flags[name] = stage
  return renderFlags(f)
}

/** A flag name from a feature name. */
export const flagName = (feature: string) =>
  feature
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 48) || "feature"
