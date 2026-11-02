// Local stand-ins for Unleash's Admin API and GrowthBook's and Statsig's REST APIs, as much of them
// as crosstalk uses, for test/shipping.test.ts and test/shipping.sh.
//
//   GrowthBook   GET/POST /api/v1/features/:id, POST /api/v1/features
//                (Authorization: Bearer <key>)
//   Statsig      GET/PATCH /console/v1/gates/:id, POST /console/v1/gates
//                (STATSIG-API-KEY: <key>)
//   Unleash      /api/admin/projects/:p/features[/:f[/environments/:env/(on|off|strategies[/:id])]],
//                /api/admin/client-metrics/features/:f  (Authorization: <token>)
//   all          GET /__state shows everything (no auth), for assertions
//
//   bun test/flag-mocks.ts <port file>     serve them all on one free port, write the port there

export type MockState = {
  features: Record<string, any>
  gates: Record<string, any>
  calls: string[]
  unleash: { features: Record<string, any>; usage: Record<string, any[]>; segments: number[]; seq: number }
}

export const GB_KEY = "secret_gb"
export const SS_KEY = "console-ss"
export const UL_KEY = "user:unleash-admin-token"

export function serveFlagMocks(state: MockState = { features: {}, gates: {}, calls: [], unleash: { features: {}, usage: {}, segments: [7], seq: 0 } }) {
  const server = Bun.serve({
    port: 0,
    hostname: "127.0.0.1",
    async fetch(req) {
      const u = new URL(req.url)
      const p = u.pathname
      if (p === "/__state") return Response.json(state)
      state.calls.push(`${req.method} ${p}`)
      // --- GrowthBook ---
      if (p.startsWith("/api/v1/features")) {
        if (req.headers.get("authorization") !== `Bearer ${GB_KEY}`) return Response.json({ message: "Invalid API key" }, { status: 401 })
        const id = decodeURIComponent(p.slice("/api/v1/features".length).replace(/^\//, ""))
        if (!id && req.method === "POST") {
          const body = await req.json()
          if (!body.id || state.features[body.id]) return Response.json({ message: "bad id" }, { status: 400 })
          if (body.valueType !== "boolean") return Response.json({ message: "valueType" }, { status: 400 })
          const f = { id: body.id, valueType: body.valueType, defaultValue: body.defaultValue ?? "false", owner: body.owner, project: body.project ?? "", environments: body.environments ?? {} }
          state.features[body.id] = f
          return Response.json({ feature: f })
        }
        const f = state.features[id]
        if (!f) return Response.json({ message: "Could not find feature" }, { status: 404 })
        if (req.method === "GET") return Response.json({ feature: f })
        if (req.method === "POST") {
          const body = await req.json()
          for (const [env, e] of Object.entries<any>(body.environments ?? {})) {
            const rules = (e.rules ?? f.environments[env]?.rules ?? []).map((r: any, i: number) => {
              if (!["force", "rollout", "experiment"].includes(r.type)) throw new Error(`bad rule type ${r.type}`)
              if (r.type === "rollout" && (typeof r.coverage !== "number" || r.coverage < 0 || r.coverage > 1)) throw new Error("coverage must be 0..1")
              return { id: r.id ?? `fr_${env}_${i}_${Math.random().toString(36).slice(2, 7)}`, ...r }
            })
            f.environments[env] = { ...(f.environments[env] ?? {}), enabled: !!e.enabled, rules }
          }
          return Response.json({ feature: f })
        }
        return new Response("method", { status: 405 })
      }
      // --- Unleash (Admin API, v5+) ---
      if (p.startsWith("/api/admin/")) {
        if (req.headers.get("authorization") !== UL_KEY) return Response.json({ name: "AuthenticationRequired", message: "You must log in" }, { status: 401 })
        const mm = /^\/api\/admin\/client-metrics\/features\/([^/]+)$/.exec(p)
        if (mm && req.method === "GET") {
          const name = decodeURIComponent(mm[1])
          if (!state.unleash.features[name]) return Response.json({ message: "not found" }, { status: 404 })
          return Response.json({ version: 1, maturity: "stable", featureName: name, lastHourUsage: state.unleash.usage[name] ?? [], seenApplications: [] })
        }
        const m = /^\/api\/admin\/projects\/([^/]+)\/features(?:\/([^/]+)(?:\/environments\/([^/]+)(?:\/(on|off|strategies)(?:\/([^/]+))?)?)?)?$/.exec(p)
        if (!m) return Response.json({ message: "no route" }, { status: 404 })
        const [, project, fname, env, what, sid] = m.map((x) => (x ? decodeURIComponent(x) : x))
        if (project !== "default" && project !== "shop") return Response.json({ message: "no project" }, { status: 404 })
        if (!fname && req.method === "POST") {
          const body = await req.json()
          if (!/^[a-zA-Z0-9._~-]+$/.test(body.name ?? "")) return Response.json({ message: "bad name" }, { status: 400 })
          if (state.unleash.features[body.name]) return Response.json({ message: "exists" }, { status: 409 })
          const f = { name: body.name, type: body.type ?? "release", project, description: body.description, environments: ["development", "production"].map((n) => ({ name: n, enabled: false, strategies: [] })) }
          state.unleash.features[body.name] = f
          return Response.json(f, { status: 201 })
        }
        const f = state.unleash.features[fname!]
        if (!f || f.project !== project) return Response.json({ message: `Could not find feature ${fname}` }, { status: 404 })
        if (!env && req.method === "GET") return Response.json(f)
        const e = f.environments.find((x: any) => x.name === env)
        if (!e) return Response.json({ message: "no environment" }, { status: 404 })
        if ((what === "on" || what === "off") && req.method === "POST") {
          e.enabled = what === "on"
          return new Response(null, { status: 200 })
        }
        if (what === "strategies" && !sid && req.method === "POST") {
          const s = await req.json()
          if (s.name !== "flexibleRollout" && s.name !== "default") return Response.json({ message: "strategy" }, { status: 400 })
          const r = Number(s.parameters?.rollout)
          if (s.name === "flexibleRollout" && (typeof s.parameters?.rollout !== "string" || !(r >= 0 && r <= 100) || !s.parameters?.stickiness)) return Response.json({ message: "rollout" }, { status: 400 })
          for (const seg of s.segments ?? []) if (!state.unleash.segments.includes(seg)) return Response.json({ message: `no segment ${seg}` }, { status: 400 })
          for (const c of s.constraints ?? []) if (!["IN", "NOT_IN", "STR_ENDS_WITH", "STR_STARTS_WITH", "STR_CONTAINS", "NUM_EQ"].includes(c.operator)) return Response.json({ message: `operator ${c.operator}` }, { status: 400 })
          const out = { id: `st_${++state.unleash.seq}`, ...s }
          e.strategies.push(out)
          return Response.json(out)
        }
        if (what === "strategies" && sid && req.method === "DELETE") {
          e.strategies = e.strategies.filter((s: any) => s.id !== sid)
          return new Response(null, { status: 200 })
        }
        return new Response("method", { status: 405 })
      }
      // --- Statsig ---
      if (p.startsWith("/console/v1/gates")) {
        if (req.headers.get("statsig-api-key") !== SS_KEY) return Response.json({ status: 401, message: "Invalid key" }, { status: 401 })
        const id = decodeURIComponent(p.slice("/console/v1/gates".length).replace(/^\//, ""))
        if (!id && req.method === "POST") {
          const body = await req.json()
          if (!body.name) return Response.json({ message: "name" }, { status: 400 })
          const g = { id: body.name, name: body.name, description: body.description ?? "", isEnabled: !!body.isEnabled, rules: body.rules ?? [] }
          state.gates[g.id] = g
          return Response.json({ message: "Gate created successfully", data: g }, { status: 201 })
        }
        const g = state.gates[id]
        if (!g) return Response.json({ status: 404, message: "Gate not found" }, { status: 404 })
        if (req.method === "GET") return Response.json({ message: "Gate read successfully", data: g })
        if (req.method === "PATCH") {
          const body = await req.json()
          if ("isEnabled" in body) g.isEnabled = !!body.isEnabled
          if (body.rules) {
            for (const r of body.rules) {
              if (typeof r.passPercentage !== "number" || r.passPercentage < 0 || r.passPercentage > 100) return Response.json({ message: "passPercentage" }, { status: 400 })
              if (!Array.isArray(r.conditions)) return Response.json({ message: "conditions" }, { status: 400 })
            }
            g.rules = body.rules.map((r: any, i: number) => ({ id: r.id ?? `rule_${i}`, ...r }))
          }
          return Response.json({ message: "Gate updated successfully", data: g })
        }
        return new Response("method", { status: 405 })
      }
      return new Response("not found", { status: 404 })
    },
    error(e) {
      return Response.json({ message: String(e.message) }, { status: 400 })
    },
  })
  return { server, state, url: `http://127.0.0.1:${server.port}` }
}

if (import.meta.main) {
  const m = serveFlagMocks()
  const out = process.argv[2]
  if (out) await Bun.write(out, String(m.server.port))
  else console.log(m.server.port)
}
