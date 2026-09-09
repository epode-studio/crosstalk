#!/usr/bin/env bun
// ray.so embeds every font it offers, not the ones it used. That is 89% of a
// 1.3 MB export, for eleven families where the image references three.
//
//   bun scripts/slim-svg.ts assets/1-you-dark.svg …
//
// Rewrites in place. Keeps a @font-face only if its family is named somewhere
// outside the @font-face blocks themselves, which is the only place a family
// can actually be applied.

import fs from "node:fs"

const FACE = /@font-face\s*\{[^}]*\}/g
const FAMILY = /font-family:\s*([^;}]+)/

const bare = (v: string) => v.trim().replace(/^["']|["']$/g, "").toLowerCase()

for (const file of process.argv.slice(2)) {
  const before = fs.readFileSync(file, "utf8")
  const faces = before.match(FACE) ?? []
  if (!faces.length) {
    console.log(`${file}: no embedded fonts, left alone`)
    continue
  }

  // Everything that is not a @font-face block. A family named only inside one
  // is a font nothing uses. Families appear HTML-escaped inside the
  // foreignObject, so &quot; has to come off before anything will match.
  const content = before.replace(FACE, "").replaceAll("&quot;", '"').replaceAll("&#39;", "'")
  const used = new Set<string>()
  // Quotes stay in the class: a family is usually written "JetBrains Mono",
  // and excluding them captures the empty string before the opening quote.
  for (const m of content.matchAll(/font-family:\s*([^;}]+)/g))
    for (const part of m[1].split(",")) used.add(bare(part))

  let dropped = 0
  const after = before.replace(FACE, (block) => {
    const fam = block.match(FAMILY)?.[1]
    if (fam && used.has(bare(fam))) return block
    dropped++
    return ""
  })

  fs.writeFileSync(file, after)
  const pct = Math.round((1 - after.length / before.length) * 100)
  console.log(
    `${file}: dropped ${dropped}/${faces.length} fonts, ` +
      `${(before.length / 1024).toFixed(0)} KB → ${(after.length / 1024).toFixed(0)} KB (${pct}% smaller)`,
  )
}
