#!/usr/bin/env bun
// Bump, build, commit, push. An installed plugin only updates when the version
// in .claude-plugin/plugin.json changes, so pushing a fix without bumping means
// nobody gets it.
//
//   bun scripts/release.ts "what changed"
//   bun scripts/release.ts --minor "bigger thing"

import fs from "node:fs"
import { $ } from "bun"

const argv = process.argv.slice(2)
const minor = argv.includes("--minor")
const major = argv.includes("--major")
const message = argv.filter((a) => !a.startsWith("--")).join(" ")
if (!message) {
  console.error('usage: bun scripts/release.ts "what changed"')
  process.exit(64)
}

const manifest = ".claude-plugin/plugin.json"
const plugin = JSON.parse(fs.readFileSync(manifest, "utf8"))
const [ma, mi, pa] = String(plugin.version).split(".").map(Number)
const next = major ? `${ma + 1}.0.0` : minor ? `${ma}.${mi + 1}.0` : `${ma}.${mi}.${pa + 1}`
plugin.version = next
fs.writeFileSync(manifest, JSON.stringify(plugin, null, 2) + "\n")

const pkg = JSON.parse(fs.readFileSync("package.json", "utf8"))
pkg.version = next
fs.writeFileSync("package.json", JSON.stringify(pkg, null, 2) + "\n")

await $`bun scripts/build.ts`
await $`git add -A`
await $`git commit -q -m ${`${next}: ${message}`}`
await $`git push -q origin main`
console.log(`\nreleased ${next}. On another machine: /plugin marketplace update epode && /plugin update crosstalk@epode`)
