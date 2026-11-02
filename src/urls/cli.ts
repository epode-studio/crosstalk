// `crosstalk urls`: the same list as crosstalk_urls, for scripts and people.
//
//   crosstalk urls [--thread T] [--kind K] [--json]   the list
//   crosstalk urls check                              sync services and check what is due, once
//   crosstalk urls routes                             the proxy's names, when it is up
//   crosstalk urls proxy                              run the proxy in the foreground (without a daemon)

import * as U from "./index.ts"
import * as L from "./liveness.ts"
import { readState, startProxy, writeState, clearState } from "./proxy.ts"
import { proxyUrl } from "./routes.ts"
import { listText, gather } from "./tools.ts"

const flag = (argv: string[], f: string) => {
  const i = argv.indexOf(f)
  return i === -1 ? undefined : argv[i + 1]
}

export async function urlsCmd(argv: string[]) {
  const sub = argv[1] && !argv[1].startsWith("--") ? argv[1] : "list"
  const session = flag(argv, "--session") ?? process.env.CLAUDE_CODE_SESSION_ID ?? ""
  const cwd = flag(argv, "--cwd") ?? process.cwd()
  if (sub === "check") {
    const store = U.urls()
    U.syncServices({ store, ports: true })
    const checked = await L.tick(store, { liveRoots: new Set([U.rootOf(cwd)]), now: Date.now() + (argv.includes("--force") ? 24 * 3600_000 : 0) })
    return void console.log(JSON.stringify({ ok: true, checked: checked.map((u) => ({ id: u.id, url: u.url, alive: u.alive, status: u.status })) }))
  }
  if (sub === "routes") {
    const s = readState()
    if (!s) return void console.log("◢ crosstalk: the proxy is not running (the daemon starts it).")
    if (argv.includes("--json")) return void console.log(JSON.stringify(s))
    console.log(`◢ crosstalk: proxy on 127.0.0.1:${s.port}`)
    for (const r of s.routes) console.log(`  ${proxyUrl(r.host, s.port).padEnd(44)} → :${r.port}  ${r.group} · ${r.service}`)
    return
  }
  if (sub === "proxy") {
    const p = await startProxy({ targets: U.targets, log: (s) => console.error(s), onTable: (t, port) => writeState({ port, routes: t.routes }) })
    if (!p) {
      console.error("crosstalk: the proxy could not listen")
      process.exit(1)
    }
    console.log(`◢ crosstalk: proxy on 127.0.0.1:${p.port}`)
    const bye = () => {
      clearState()
      process.exit(0)
    }
    for (const s of ["SIGINT", "SIGTERM", "SIGHUP"] as const) process.on(s, bye)
    await new Promise(() => {})
  }
  const kind = flag(argv, "--kind") as any
  const thread = flag(argv, "--thread")
  if (argv.includes("--json")) return void console.log(JSON.stringify({ ok: true, urls: gather({ sessionId: session, cwd, thread, kind }) }))
  console.log(listText({ sessionId: session, cwd, thread, kind }))
}
