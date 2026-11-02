// The thread file: one per thread on refs/crosstalk/threads.
//
// A public thread is the markdown from docs/design/next-generation.md, readable
// by anyone browsing the ref, followed by a comment holding the exact state
// (clocks and item ids), which is what crosstalk reads back. A file without
// that comment, one somebody wrote by hand, is read from the markdown itself.
//
//   ---
//   crosstalk: thread/v1
//   id: 3f9a1c0e5b7d2468
//   status: active
//   people: [paul, marie]
//   …
//   ---
//   ## Recap …  ## Questions …  ## Decisions …
//   <!-- crosstalk:state {…} -->
//
// A sealed thread shows nothing but its id and who it is wrapped for. Each
// section is one line, sealed on its own (see seal.ts), so git diffs and merges
// it a section at a time:
//
//   ---
//   crosstalk: thread/v1
//   id: 3f9a1c0e5b7d2468
//   sealed: true
//   keys:
//     - <to fingerprint> <from fingerprint> <wrapped key>
//   ---
//   meta: <sealed>
//   recap: <sealed>
//   …

import * as M from "./model.ts"
import { openSection, sealSection, type Wrap } from "./seal.ts"

export const HEADER = "crosstalk: thread/v1"
const STATE_OPEN = "<!-- crosstalk:state"
const STATE_CLOSE = "-->"
/** Sections added after the format first shipped: a file written before them has no line for them. */
const LATER: ReadonlySet<string> = new Set(["links"])

/** A JSON string or bare word, whichever reads back the same. */
const word = (s: string) => (/^[A-Za-z0-9][A-Za-z0-9 ._/*@+-]*$/.test(s) && !/[ ]$/.test(s) ? s : JSON.stringify(s))
const list = (xs: string[]) => `[${xs.map(word).join(", ")}]`
const day = (ms: number) => new Date(ms).toISOString().slice(0, 10)
const oneLine = (s: string) => s.replace(/\s+/g, " ").trim()

/** The file name on the ref. Public threads go by name so people browsing find them; sealed ones by id. */
export function fileName(t: M.Thread, taken: Set<string> = new Set()): string {
  if (!t.meta.value.public) return `${t.id}.md`
  const plain = `${t.meta.value.name}.md`
  return taken.has(plain) ? `${t.meta.value.name}.${t.id.slice(0, 8)}.md` : plain
}

export function renderPublic(t: M.Thread): string {
  const v = M.view(t)
  const fm = [
    "---",
    HEADER,
    `id: ${t.id}`,
    `name: ${word(v.name)}`,
    `status: ${v.status}`,
    `public: true`,
    `repo: ${word(v.repo)}`,
    `people: ${list(v.people)}`,
    `files: ${list(v.files)}`,
    `branches: ${list(v.branches)}`,
    ...(v.combinedInto ? [`combined-into: ${v.combinedInto}`] : []),
  ]
  if (v.features.length) {
    fm.push("features:")
    for (const f of v.features) {
      fm.push(`  - name: ${word(f.name)}`)
      if (f.risk === "risky") fm.push(`    risk: risky`)
      if (f.flag) fm.push(`    flag: ${word(f.flag)}`)
    }
  } else fm.push("features: []")
  fm.push("---")
  const body: string[] = ["", "## Recap", v.recap ? oneLine(v.recap) : "", ""]
  body.push("## Questions", ...M.live(t, "questions").map((q) => `- ${oneLine(q.text)}${q.blocking ? " (blocking)" : ""}${q.answer ? ` → ${oneLine(q.answer)}` : ""}`), "")
  body.push("## Decisions", ...M.live(t, "decisions").map((d) => `- ${day(d.at)} · ${d.who} · ${oneLine(d.text)}`), "")
  body.push("## Facts", ...M.live(t, "facts").map((f) => `- ${oneLine(f.text)}`), "")
  body.push("## Tasks", ...M.live(t, "tasks").map((k) => `- [${k.state === "done" ? "x" : " "}] ${oneLine(k.text)}`), "")
  body.push("## Rules", ...M.live(t, "rules").map((r) => `- ${oneLine(r.text)}`), "")
  // Exact state for crosstalk. "-->" can only occur inside a JSON string, where
  // its escaped form means the same.
  const state = M.canonical(t).replace(/-->/g, "--\\u003e")
  body.push(STATE_OPEN, state, STATE_CLOSE, "")
  return [...fm, ...body].join("\n")
}

/** Seals one section. The service passes one that reuses a section's blob while its content is unchanged. */
export type Sealer = (section: string, value: unknown) => string

/**
 * Sealing uses a fresh nonce each time, so without reuse every commit would
 * rewrite every line. With a caching sealer only the sections that changed do.
 */
export function renderSealed(t: M.Thread, key: Buffer | Sealer, wraps: Wrap[], epoch = 0): string {
  const seal: Sealer = typeof key === "function" ? key : (s, v) => sealSection(key, t.id, s, v)
  // The key's epoch (rekey.ts): absent means 0, so files from before it read the same.
  const lines = ["---", HEADER, `id: ${t.id}`, "sealed: true", ...(epoch > 0 ? [`epoch: ${epoch}`] : []), "keys:"]
  for (const w of wraps) lines.push(`  - ${w.to} ${w.from} ${w.k}`)
  lines.push("---")
  for (const s of M.SECTIONS) lines.push(`${s}: ${seal(s, (t as any)[s])}`)
  lines.push(`clock: ${seal("clock", { lamport: t.lamport, touchedAt: t.touchedAt })}`)
  return lines.join("\n") + "\n"
}

export type Parsed =
  | { kind: "public"; id: string; thread: M.Thread }
  | { kind: "sealed"; id: string; wraps: Wrap[]; epoch: number; open: (key: Buffer) => M.Thread | null }
  | { kind: "unknown" }

function frontmatter(text: string): { fm: string[]; body: string } | null {
  const m = /^---\n([\s\S]*?)\n---\n?/.exec(text)
  return m ? { fm: m[1].split("\n"), body: text.slice(m[0].length) } : null
}

const unword = (s: string) => {
  const t = s.trim()
  if (t.startsWith('"')) {
    try {
      return String(JSON.parse(t))
    } catch {}
  }
  return t.replace(/\s+#.*$/, "").trim()
}

function unlist(s: string): string[] {
  const t = s.replace(/\s+#.*$/, "").trim()
  if (!t.startsWith("[")) return t ? [unword(t)] : []
  const inner = t.replace(/^\[|\]$/g, "")
  const out: string[] = []
  for (const m of inner.matchAll(/"(?:[^"\\]|\\.)*"|[^,]+/g)) {
    const v = unword(m[0])
    if (v) out.push(v)
  }
  return out
}

export function parse(text: string): Parsed {
  const f = frontmatter(text)
  if (!f) return { kind: "unknown" }
  const get = (k: string) => f.fm.find((l) => l.startsWith(`${k}:`))?.slice(k.length + 1).trim()
  const id = get("id") ?? ""
  if (!/^[0-9a-f]{8,32}$/.test(id)) return { kind: "unknown" }

  if (get("sealed") === "true") {
    const wraps: Wrap[] = []
    for (const l of f.fm) {
      const m = /^\s+-\s+(\S+)\s+(\S+)\s+(\S+)\s*$/.exec(l)
      if (m) wraps.push({ to: m[1], from: m[2], k: m[3] })
    }
    const blobs = new Map<string, string>()
    for (const l of f.body.split("\n")) {
      const m = /^([a-z]+): (\S+)$/.exec(l)
      if (m) blobs.set(m[1], m[2])
    }
    return {
      kind: "sealed",
      id,
      wraps,
      epoch: Number(get("epoch")) || 0,
      open: (key) => {
        try {
          const o: any = { v: 1, id }
          // A section newer than the file (links) is empty, not a reason to refuse it.
          for (const s of M.SECTIONS) o[s] = !blobs.has(s) && LATER.has(s) ? {} : openSection(key, id, s, blobs.get(s) ?? "")
          const c: any = openSection(key, id, "clock", blobs.get("clock") ?? "")
          o.lamport = c.lamport
          o.touchedAt = c.touchedAt
          return M.parseThread(o)
        } catch {
          return null
        }
      },
    }
  }

  const s = f.body.indexOf(STATE_OPEN)
  if (s !== -1) {
    const e = f.body.indexOf(STATE_CLOSE, s + STATE_OPEN.length)
    try {
      const t = M.parseThread(JSON.parse(f.body.slice(s + STATE_OPEN.length, e === -1 ? undefined : e)))
      if (t && t.id === id) return { kind: "public", id, thread: t }
    } catch {}
  }
  const t = fromMarkdown(id, f.fm, f.body)
  return t ? { kind: "public", id, thread: t } : { kind: "unknown" }
}

/**
 * A public thread written or edited by hand: frontmatter and sections, with
 * every stamp at zero, so anything crosstalk already knows wins a merge with it.
 */
function fromMarkdown(id: string, fm: string[], body: string): M.Thread | null {
  const get = (k: string) => fm.find((l) => l.startsWith(`${k}:`))?.slice(k.length + 1).trim()
  const status = (get("status") ?? "active").replace(/\s+#.*$/, "") as M.Status
  if (!M.STATUSES.includes(status)) return null
  const by = "markdown"
  const t = M.create({ id, name: unword(get("name") ?? id), repo: unword(get("repo") ?? ""), by, label: by, now: 0, public: true })
  t.people = {}
  t.meta = { l: 0, by, value: { ...t.meta.value, status, combinedInto: get("combined-into") || undefined } }
  t.recap.l = 0
  t.lamport = 0
  const mark = (list: M.ListName, key: string, data: object) =>
    ((t as any)[list][key] = { ...data, l: 0, by, id: key })
  for (const p of unlist(get("people") ?? "")) mark("people", `label:${p}`, { label: p })
  // Their order in the file is their order: `at` is all live() sorts by.
  unlist(get("files") ?? "").forEach((p, i) => mark("files", p, { at: i }))
  unlist(get("branches") ?? "").forEach((b, i) => mark("branches", b, { at: i }))
  // features: a list of maps, two-space indented.
  let cur: M.Feature | null = null
  const flush = () => cur && mark("features", M.slug(cur.name), cur)
  const fi = fm.findIndex((l) => /^features:\s*$/.test(l))
  if (fi !== -1)
    for (const l of fm.slice(fi + 1)) {
      if (!/^\s/.test(l)) break
      const item = /^\s+-\s+name:\s*(.+)$/.exec(l)
      const kv = /^\s+(risk|flag):\s*(.+)$/.exec(l)
      if (item) {
        flush()
        cur = { name: unword(item[1]), risk: "everyday" }
      } else if (kv && cur) {
        if (kv[1] === "risk") cur.risk = unword(kv[2]) === "risky" ? "risky" : "everyday"
        else cur.flag = unword(kv[2])
      }
    }
  flush()
  const sections = new Map<string, string[]>()
  let at: string | null = null
  for (const l of body.split("\n")) {
    const h = /^## (.+)$/.exec(l)
    if (h) {
      at = h[1].trim().toLowerCase()
      sections.set(at, [])
    } else if (at && l.trim()) sections.get(at)!.push(l)
  }
  t.recap.value = (sections.get("recap") ?? []).join(" ").trim()
  const bullets = (k: string) => (sections.get(k) ?? []).filter((l) => l.startsWith("- ")).map((l) => l.slice(2).trim())
  bullets("questions").forEach((q, i) => {
    const blocking = /\(blocking\)\s*$/.test(q)
    mark("questions", `md_q${i}`, { text: q.replace(/\s*\(blocking\)\s*$/, ""), blocking, who: "", at: 0 })
  })
  bullets("decisions").forEach((d, i) => {
    const m = /^(\d{4}-\d{2}-\d{2})\s+·\s+([^·]+?)\s+·\s+(.+)$/.exec(d)
    mark("decisions", `md_d${i}`, m ? { text: m[3], who: m[2], at: Date.parse(m[1]) } : { text: d, who: "", at: 0 })
  })
  bullets("facts").forEach((x, i) => mark("facts", `md_f${i}`, { text: x, who: "", at: 0 }))
  bullets("tasks").forEach((x, i) => {
    const m = /^\[( |x)\]\s+(.+)$/.exec(x)
    mark("tasks", `md_t${i}`, { text: m ? m[2] : x, who: "", at: 0, state: m?.[1] === "x" ? "done" : "open" })
  })
  bullets("rules").forEach((x, i) => mark("rules", `md_r${i}`, { text: x, who: "", at: 0 }))
  return t
}

// --- THREADS.md ------------------------------------------------------------------

/** The working-tree summary: public threads only, a line or two each. */
export function summary(threads: M.Thread[]): string {
  const pub = threads.filter((t) => t.meta.value.public && !t.meta.value.combinedInto).sort((a, b) => (a.meta.value.name < b.meta.value.name ? -1 : 1))
  const lines = [
    "# Threads",
    "",
    "Public crosstalk threads in this repository. Written by crosstalk when a",
    "thread's status changes; the threads themselves live on refs/crosstalk/threads.",
    "Sealed threads never appear here.",
    "",
  ]
  for (const t of pub) {
    const v = M.view(t)
    const open = v.questions.filter((q) => !q.answer)
    const last = v.decisions[v.decisions.length - 1]
    lines.push(`- **${v.name}** · ${v.status} · ${v.people.join(", ") || "nobody yet"}`)
    const more: string[] = []
    if (open.length) more.push(`${open.length} open question${open.length === 1 ? "" : "s"}: ${oneLine(open[0].text)}`)
    if (last) more.push(`latest decision: ${oneLine(last.text)}`)
    if (more.length) lines.push(`  ${more.join(" · ")}`)
  }
  if (!pub.length) lines.push("_No public threads._")
  return lines.join("\n") + "\n"
}
