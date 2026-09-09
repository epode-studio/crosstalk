// Renders assets/snippets/*.txt into 2x PNGs of a Claude Code window.
//
// Not ray.so: its SVGs embed HTML in a foreignObject, which browsers re-lay-out
// at the reader's zoom level and then clip against the fixed frame. A raster
// cannot reflow. Rendering here also means the font is ours to choose, and the
// input field's rules need one where U+2500 is exactly one cell wide — Menlo is,
// JetBrains Mono is 1.42x.
//
// The window chrome below was read off a live Claude Code 2.1.266 through a pty.

import fs from "node:fs"
import path from "node:path"
import { spawnSync } from "node:child_process"

const CHROME = "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"
const ROOT = path.resolve(import.meta.dir, "..")
const SRC = path.join(ROOT, "assets/snippets")
const OUT = path.join(ROOT, "assets")
const TMP = fs.mkdtempSync("/tmp/crosstalk-snip-")

const COLS = 76
const FONT_PX = 13
const LINE = 1.5
const PAD = 16

const THEMES = {
  dark: { bg: "#0D0D0D", fg: "#D9D9D9", dim: "#8A8A8A", light: "#3A3A3A", dot: "#4E4E4E" },
  light: { bg: "#FFFFFF", fg: "#24292F", dim: "#6E7781", light: "#D8DEE4", dot: "#BFC6CE" },
} as const

/** Lines Claude Code prints dim: tool-call receipts and delivery notices. */
const DIM = /^\s*(Called crosstalk\b|Ran \d+ shell command|Read \d+|Message from crosstalk\b)/

const esc = (s: string) =>
  s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")

function body(text: string) {
  return text
    .replace(/\s+$/, "")
    .split("\n")
    .map((l) => `<div class="l${DIM.test(l) ? " dim" : ""}">${esc(l) || "&nbsp;"}</div>`)
    .join("")
}

function page(title: string, text: string, t: (typeof THEMES)[keyof typeof THEMES]) {
  const rule = "─".repeat(COLS)
  return `<!doctype html><meta charset="utf-8"><style>
html,body{margin:0;padding:0;background:transparent}
#card{display:inline-block;background:${t.bg};border-radius:12px;
  border:1px solid ${t.light};padding:${PAD}px;font-family:Menlo,Monaco,monospace;
  font-size:${FONT_PX}px;line-height:${LINE};color:${t.fg};
  font-variant-ligatures:none;-webkit-font-smoothing:antialiased}
#bar{display:flex;align-items:center;height:20px;margin:0 0 10px}
#lights{display:flex;gap:6px}
#lights i{width:9px;height:9px;border-radius:50%;background:${t.dot}}
#title{flex:1;text-align:center;color:${t.dim};font-family:-apple-system,system-ui,sans-serif;
  font-size:11px;margin-left:-33px}
.l{white-space:pre}
.dim{color:${t.dim}}
.rule{color:${t.dim};white-space:pre}
#input{margin-top:14px}
#mode{color:${t.dim};white-space:pre}
</style><div id="card"><div id="bar"><div id="lights"><i></i><i></i><i></i></div>
<div id="title">${esc(title)}</div></div>
${body(text)}
<div id="input"><div class="rule">${rule}</div><div class="l">❯</div><div class="rule">${rule}</div>
<div id="mode">  ⏵⏵ auto mode on (shift+tab to cycle)</div></div></div>`
}

const titles = JSON.parse(fs.readFileSync(path.join(SRC, "titles.json"), "utf8"))
const names = Object.keys(titles)

// Serve from a directory so Chrome treats it as a normal page load.
for (const name of names) {
  const text = fs.readFileSync(path.join(SRC, `${name}.txt`), "utf8")
  for (const [mode, t] of Object.entries(THEMES)) {
    const html = path.join(TMP, `${name}-${mode}.html`)
    fs.writeFileSync(html, page(titles[name], text, t))
    const png = path.join(OUT, `${name}-${mode}.png`)
    const r = spawnSync(CHROME, [
      "--headless", "--disable-gpu", "--hide-scrollbars",
      "--default-background-color=00000000",
      "--force-device-scale-factor=2",
      "--window-size=1400,1400",
      `--screenshot=${png}`,
      `file://${html}`,
    ], { encoding: "utf8" })
    if (r.status !== 0) throw new Error(`chrome failed for ${name}-${mode}: ${r.stderr}`)
    // Chrome shoots the whole window; crop to the card.
    spawnSync("python3", [path.join(ROOT, "scripts/crop-alpha.py"), png], { stdio: "inherit" })
    console.log(`${path.relative(ROOT, png)}  ${(fs.statSync(png).size / 1024) | 0} KB`)
  }
}
