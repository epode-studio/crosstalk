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
  console.log(`dist/${name}.js`.padEnd(30) + entry)
}
console.log("\nbuilt for node and bun")
