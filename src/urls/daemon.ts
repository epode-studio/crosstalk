// URL tracking in the daemon (docs/urls.md): the proxy behind
// `http://auth.localhost`, the services' URLs kept current, and the liveness
// checks. src/daemon.ts starts it once its socket is listening.
//
//   proxy      started here (CROSSTALK_NO_PROXY=1 leaves it off); its port and
//              routes in <crosstalk home>/proxy.json, removed when it stops
//   sync       services → URLs every 10 seconds, the listening ports looked up
//              again every 30
//   checks     every 5 seconds, whatever is due (liveness.ts)
//   prune      hourly

import { urls, syncServices, targets } from "./index.ts"
import * as L from "./liveness.ts"
import { clearState, readState, startProxy, writeState, type Proxy } from "./proxy.ts"
import { rootOf } from "./index.ts"

export type UrlsDaemon = { proxy: Proxy | null; stop: () => Promise<void>; tick: () => Promise<void> }

export async function createUrls(o: { log: (...a: unknown[]) => void; live: () => { sessionId: string; cwd: string }[] }): Promise<UrlsDaemon> {
  const store = urls()
  let proxy: Proxy | null = null
  if (!process.env.CROSSTALK_NO_PROXY) {
    try {
      proxy = await startProxy({
        targets,
        log: (s) => o.log(s),
        onTable: (t, port) => {
          try {
            writeState({ port, routes: t.routes })
          } catch {}
        },
      })
      if (proxy) o.log(`urls: proxy on http://127.0.0.1:${proxy.port} (names: <thread>.localhost)`)
      else o.log("urls: no proxy: no port it could listen on")
    } catch (e) {
      o.log(`urls: no proxy: ${(e as Error).message}`)
    }
  }
  process.on("exit", () => clearState())
  let lastSync = 0
  let lastPorts = 0
  let lastPrune = 0
  let running = false
  const tick = async () => {
    if (running) return
    running = true
    try {
      const now = Date.now()
      const syncEvery = Number(process.env.CROSSTALK_URL_SYNC_MS ?? 10_000)
      if (now - lastSync >= syncEvery) {
        lastSync = now
        const ports = now - lastPorts >= 3 * syncEvery
        if (ports) lastPorts = now
        proxy?.refresh()
        syncServices({ store, ports, state: readState() })
      }
      const live = o.live()
      const liveRoots = new Set<string>()
      for (const s of live)
        try {
          if (s.cwd) liveRoots.add(rootOf(s.cwd))
        } catch {}
      await L.tick(store, { liveRoots, liveSessions: new Set(live.map((s) => s.sessionId)) })
      if (now - lastPrune > 60 * 60_000) {
        lastPrune = now
        store.prune()
      }
    } catch (e) {
      o.log(`urls: ${(e as Error).message}`)
    } finally {
      running = false
    }
  }
  const timer = setInterval(() => void tick(), Number(process.env.CROSSTALK_URL_TICK_MS ?? 5000))
  timer.unref?.()
  void tick()
  return {
    proxy,
    tick,
    stop: async () => {
      clearInterval(timer)
      await proxy?.close()
      clearState()
    },
  }
}
