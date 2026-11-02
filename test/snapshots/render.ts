// A small text renderer for the mod's trees (mod/draw.tsx), for snapshots.
//
// Claude Code's test kit hands a test the tree a render hook returned, never a
// surface's paint, so this lays the same tree out the way the terminal does,
// closely enough to read: Box rows and columns, a fixed `width`, `flexGrow`
// taking what is left, `marginTop`; Text that truncates with an ellipsis or
// wraps at words; nested Text and Link runs carrying their style. A theme key
// (`suggestion`, `inactive`, …) resolves through a light or a dark palette; a
// raw colour stays as written.
//
// A frame comes out twice: as the plain text in a box of its width, and as
// the same lines with each styled run marked, `[bold fg=suggestion:#b1b9f9]◢
// auth[/]`, so a diff of either reads on its own. Nothing here is a runtime
// dependency of crosstalk; it is test code over plain data.

export type Theme = "light" | "dark"

/** Stand-ins for Claude Code's light and dark theme colours, by theme key. */
export const PALETTE: Record<Theme, Record<string, string>> = {
  dark: { text: "#ffffff", inactive: "#999999", subtle: "#505050", suggestion: "#b1b9f9", claude: "#d77757", error: "#ff6b80", success: "#4eba65", warning: "#ffc107" },
  light: { text: "#000000", inactive: "#666666", subtle: "#afafaf", suggestion: "#5769f7", claude: "#d77757", error: "#ab2b3f", success: "#2c7a39", warning: "#966c1e" },
}

type Style = { fg?: string; bg?: string; bold?: boolean; dim?: boolean; link?: string }
type Span = { text: string; style: Style }
type Line = Span[]
type El = { type: string; props: Record<string, any> & { children?: any[] } }

/** The JSX factory the trees are built with in a test: plain data, as the engine's is. */
export function h(type: unknown, props: Record<string, unknown> | null, ...children: unknown[]) {
  return { type, props: { ...(props ?? {}), children } }
}

/** The element table a test hands the drawing functions: tags by name. */
export const ELS = { Box: "Box", Text: "Text", Link: "Link" }

const flat = (xs: any): any[] => (Array.isArray(xs) ? xs.flatMap(flat) : xs === null || xs === undefined || xs === false || xs === true ? [] : [xs])
const kids = (n: El) => flat(n.props.children ?? [])
const len = (l: Line) => l.reduce((a, s) => a + [...s.text].length, 0)

function styleOf(p: Record<string, any>, base: Style): Style {
  const s: Style = { ...base }
  if (p.color) s.fg = p.color
  if (p.backgroundColor) s.bg = p.backgroundColor
  if (p.bold) s.bold = true
  if (p.dimColor) s.dim = true
  return s
}

/** A Text's runs, in order: nested Text and Link merge their style into the parent's. */
function spans(n: any, style: Style): Span[] {
  if (typeof n === "string" || typeof n === "number") return [{ text: String(n), style }]
  if (!n || typeof n !== "object") return []
  const el = n as El
  const s = el.type === "Link" ? { ...style, link: el.props.href } : styleOf(el.props, style)
  return kids(el).flatMap((c) => spans(c, s))
}

function cutLine(l: Line, w: number): Line {
  const out: Line = []
  let left = w
  for (const s of l) {
    if (left <= 0) break
    const chars = [...s.text]
    out.push({ text: chars.slice(0, left).join(""), style: s.style })
    left -= Math.min(left, chars.length)
  }
  return out
}

/** Ink's truncate: past the width, cut to one less and end in an ellipsis. */
function truncate(l: Line, w: number): Line {
  if (len(l) <= w) return l
  const out = cutLine(l, Math.max(0, w - 1))
  const last = out[out.length - 1]?.style ?? {}
  return [...out, { text: "…", style: last }]
}

/** Ink's wrap: at spaces, a word longer than the width broken. */
function wrap(l: Line, w: number): Line[] {
  if (len(l) <= w) return [l]
  // Characters with their style, then break at the last space that fits.
  const cs = l.flatMap((s) => [...s.text].map((c) => ({ c, style: s.style })))
  const lines: Line[] = []
  let i = 0
  while (i < cs.length) {
    let end = Math.min(cs.length, i + w)
    if (end < cs.length) {
      const sp = cs.slice(i, end + 1).map((x) => x.c).lastIndexOf(" ")
      if (sp > 0) end = i + sp
    }
    const part = cs.slice(i, end)
    lines.push(join(part))
    i = end
    while (cs[i]?.c === " ") i++
  }
  return lines
}

function join(cs: { c: string; style: Style }[]): Line {
  const out: Line = []
  for (const x of cs) {
    const last = out[out.length - 1]
    if (last && same(last.style, x.style)) last.text += x.c
    else out.push({ text: x.c, style: x.style })
  }
  return out
}

const same = (a: Style, b: Style) => a.fg === b.fg && a.bg === b.bg && !!a.bold === !!b.bold && !!a.dim === !!b.dim && a.link === b.link

/** How wide a node is when nothing holds it in: a Text's run, a Box's width or its widest child. */
function natural(n: any): number {
  if (typeof n === "string") return [...n].length
  const el = n as El
  if (el.type === "Text" || el.type === "Link") return len(spans(el, {}))
  if (el.props.width) return el.props.width
  const cs = kids(el)
  return el.props.flexDirection === "column" ? Math.max(0, ...cs.map(natural)) : cs.reduce((a, c) => a + natural(c), 0)
}

/** Lay a node out at most `w` wide: its lines, top to bottom. */
export function layout(n: any, w: number): Line[] {
  if (typeof n === "string") return [[{ text: n, style: {} }]]
  const el = n as El
  if (el.type === "Text" || el.type === "Link") {
    const line = spans(el, {})
    return el.props.wrap === "truncate" ? [truncate(line, w)] : wrap(line, w)
  }
  const W = Math.min(w, el.props.width ?? w)
  const cs = kids(el)
  let lines: Line[]
  if (el.props.flexDirection === "column") {
    lines = []
    for (const c of cs) {
      for (let i = 0; i < (c?.props?.marginTop ?? 0); i++) lines.push([])
      lines.push(...layout(c, W))
    }
  } else {
    // A row: fixed children at their own width, flexGrow ones share the rest.
    const grow = cs.map((c) => (typeof c === "object" && c.props?.flexGrow ? c.props.flexGrow : 0))
    const fixed = cs.map((c, i) => (grow[i] ? 0 : Math.min(natural(c), W)))
    const rest = Math.max(0, W - fixed.reduce((a, b) => a + b, 0))
    const total = grow.reduce((a, b) => a + b, 0)
    const widths = cs.map((_, i) => (grow[i] ? Math.floor((rest * grow[i]) / total) : fixed[i]))
    const cols = cs.map((c, i) => layout(c, widths[i]))
    const height = Math.max(0, ...cols.map((c) => c.length))
    lines = []
    for (let r = 0; r < height; r++) {
      const line: Line = []
      cols.forEach((col, i) => {
        const part = col[r] ?? []
        line.push(...part)
        // Every column but the last is padded to its width, so the next starts where it should.
        if (i < cols.length - 1 && len(part) < widths[i]) line.push({ text: " ".repeat(widths[i] - len(part)), style: {} })
      })
      lines.push(line)
    }
  }
  return lines.map((l) => cutLine(l, W))
}

function mark(s: Style, theme: Theme): string {
  const c = (v: string) => (PALETTE[theme][v] ? `${v}:${PALETTE[theme][v]}` : v)
  return [s.bold ? "bold" : "", s.dim ? "dim" : "", s.fg ? `fg=${c(s.fg)}` : "", s.bg ? `bg=${c(s.bg)}` : "", s.link ? `link=${s.link}` : ""].filter(Boolean).join(" ")
}

/** A frame: the plain text in a box `width` wide, then each line with its styled runs marked. */
export function frame(title: string, tree: any, width: number, theme: Theme): string {
  // Runs of one style read as one, however the tree split them.
  const lines = layout(tree, width).map((l) => join(l.flatMap((s) => [...s.text].map((c) => ({ c, style: s.style })))))
  const plain = lines.map((l) => l.map((s) => s.text).join(""))
  const top = `┌─ ${title} ${"─".repeat(Math.max(0, width - title.length - 3))}┐`
  const box = [top, ...plain.map((p) => `│${p}${" ".repeat(Math.max(0, width - [...p].length))}│`), `└${"─".repeat(width)}┘`]
  const styled = lines.map((l, i) => {
    const body = l.map((s) => (mark(s.style, theme) ? `[${mark(s.style, theme)}]${s.text}[/]` : s.text)).join("")
    return `${String(i + 1).padStart(3)} ${body.replace(/\s+$/, "")}`
  })
  return [...box, "", `styles (${theme} theme):`, ...styled, ""].join("\n")
}
