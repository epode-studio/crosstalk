// A cheap outline of a source file: its top-level symbols and the lines each
// one spans. Regular expressions, no parser, because it runs in a hook after
// every edit and only has to be right about "which top-level thing changed".
//
//   TS / JS   function, class, interface, type, enum, const/let/var at column 0,
//             with export / default / async / declare / abstract in front
//   Python    def, async def, class, NAME = at column 0
//   anything  the whole file, as the symbol "*"

export type Symbol = { name: string; start: number; end: number }

export const WHOLE = "*"

export function langOf(file: string): "ts" | "py" | null {
  if (/\.(m|c)?(t|j)sx?$/i.test(file)) return "ts"
  if (/\.pyi?$/i.test(file)) return "py"
  return null
}

const TS = /^(?:export\s+)?(?:default\s+)?(?:declare\s+)?(?:abstract\s+)?(?:async\s+)?(?:function\s*\*?|class|interface|type|enum|const|let|var|namespace)\s+([A-Za-z_$][\w$]*)/
const PY = /^(?:async\s+)?(?:def|class)\s+([A-Za-z_]\w*)|^([A-Za-z_]\w*)\s*(?::[^=]*)?=(?!=)/

/** Top-level symbols, in order, 1-based inclusive line ranges. */
export function outline(text: string, lang: "ts" | "py" | null): Symbol[] {
  if (!lang) return []
  const lines = text.split("\n")
  const re = lang === "ts" ? TS : PY
  const starts: { name: string; line: number }[] = []
  for (let i = 0; i < lines.length; i++) {
    const m = re.exec(lines[i])
    if (m) starts.push({ name: m[1] ?? m[2], line: i + 1 })
  }
  return starts.map((s, i) => ({ name: s.name, start: s.line, end: (starts[i + 1]?.line ?? lines.length + 1) - 1 }))
}

/** The symbols lines [from, to] fall in. Lines before the first symbol (imports) belong to none. */
export function symbolsAt(syms: Symbol[], from: number, to: number): string[] {
  return syms.filter((s) => s.start <= to && s.end >= from).map((s) => s.name)
}

/** Each symbol's text, to tell which changed between two versions of a file. */
function bodies(text: string, lang: "ts" | "py"): Map<string, string> {
  const lines = text.split("\n")
  const out = new Map<string, string>()
  for (const s of outline(text, lang)) out.set(s.name, lines.slice(s.start - 1, s.end).join("\n").trimEnd())
  return out
}

/**
 * The top-level symbols that differ between two versions of a file: changed,
 * added or removed. A file with no outline is the whole file, when it changed.
 */
export function changedSymbols(file: string, before: string | null, after: string | null): string[] {
  if ((before ?? "") === (after ?? "")) return []
  const lang = langOf(file)
  if (!lang) return [WHOLE]
  const a = bodies(before ?? "", lang)
  const b = bodies(after ?? "", lang)
  const out = new Set<string>()
  for (const [n, t] of b) if (a.get(n) !== t) out.add(n)
  for (const n of a.keys()) if (!b.has(n)) out.add(n)
  return [...out]
}

/** The symbols an edit's new text lands in, by finding it in the file after the edit. */
export function symbolsOfEdit(file: string, after: string, newText: string): string[] | null {
  const lang = langOf(file)
  if (!lang) return [WHOLE]
  if (!newText) return null
  const at = after.indexOf(newText)
  if (at === -1) return null
  const from = after.slice(0, at).split("\n").length
  const to = from + newText.split("\n").length - 1
  return symbolsAt(outline(after, lang), from, to)
}

/** Whether two symbol sets for one file overlap. The whole file overlaps everything. */
export function overlapping(a: string[], b: string[]): string[] {
  if (a.includes(WHOLE) && b.length) return b.includes(WHOLE) ? [WHOLE] : [...b]
  if (b.includes(WHOLE) && a.length) return [...a]
  return a.filter((x) => b.includes(x))
}
