#!/usr/bin/env bun
// Builds dist/ so the plugin runs on either Bun or Node with nothing to install.
// dist/ is committed: installing crosstalk should never mean running a build.

import { $ } from "bun"

const ENTRIES: Record<string, string> = {
  daemon: "src/daemon.ts",
  server: "src/server.ts",
  cli: "src/cli.ts",
  hook: "src/hook.ts",
  relay: "relay/relay.ts",
}

await $`rm -rf dist`
await $`mkdir -p dist`
for (const [name, entry] of Object.entries(ENTRIES)) {
  await $`bun build --target=node --outfile dist/${name}.js ${entry}`.quiet()
  // The bundle starts `// @bun`, and Bun reads a file marked so as Latin-1:
  // every "◢" it printed came out as "â\u0097¢", which a mod's UI refuses as a
  // control character. Escaped, the text means the same under Bun and Node.
  const file = `dist/${name}.js`
  const src = await Bun.file(file).text()
  await Bun.write(file, src.replace(/[^\x00-\x7f]/g, (c) => `\\u${c.charCodeAt(0).toString(16).padStart(4, "0")}`))
  console.log(file.padEnd(30) + entry)
}
console.log("\nbuilt for node and bun")
