#!/usr/bin/env bun
// A tiny local webhook for alerts: anything that can POST JSON (Sentry, an
// uptime checker, Grafana, PagerDuty) becomes `crosstalk incident`. There is
// no hosted endpoint: this runs on your machine, and you expose it only if and
// how you choose (a tunnel, a VPN, or a cron that polls your alerting API).
//
//   CROSSTALK_INCIDENT_TOKEN=some-secret bun scripts/incident-webhook.ts [port]
//   curl -X POST 'http://127.0.0.1:8790/?token=some-secret&source=uptime' \
//     -d '{"title":"checkout down","details":"502 from /pay"}'
//
// Sentry (an internal integration's webhook, or an alert rule's webhook):
// the event's title, culprit, in-app stack frames, release (as the sha when
// it looks like one) and a `flag` tag are passed on. Generic JSON may carry
// title, details, flag, files and sha directly.
//
// It will not start without CROSSTALK_INCIDENT_TOKEN: an incident can turn a
// flag off and puts text in front of agents, so every request must carry the
// token (compared in constant time). A request a browser sent (it has an
// Origin header) is refused whatever it carries, so a web page cannot post
// one (text/plain needs no preflight).

import { spawnSync } from "node:child_process"
import crypto from "node:crypto"
import path from "node:path"

const port = Number(process.argv[2] ?? process.env.PORT ?? 8790)
const token = process.env.CROSSTALK_INCIDENT_TOKEN
const cli = process.env.CROSSTALK_BIN?.split(" ") ?? [path.join(import.meta.dir, "..", "bin", "crosstalk")]

type Incident = { source: string; title: string; details: string; flag?: string; files?: string[]; sha?: string }

export function fromPayload(body: any, source: string): Incident | null {
  const ev = body?.data?.event ?? body?.event
  const issue = body?.data?.issue
  if (ev || issue) {
    const frames: any[] = (ev?.exception?.values ?? []).flatMap((v: any) => v?.stacktrace?.frames ?? [])
    const files = [...new Set(frames.filter((f) => f?.in_app !== false).map((f) => f?.filename ?? f?.abs_path).filter(Boolean))].slice(-10) as string[]
    const tags: [string, string][] = Array.isArray(ev?.tags) ? ev.tags : Object.entries(ev?.tags ?? {})
    const flag = tags.find(([k]) => k === "flag" || k === "feature_flag")?.[1]
    const release = String(ev?.release ?? "")
    return {
      source: "sentry",
      title: String(ev?.title ?? issue?.title ?? "Sentry alert"),
      details: [ev?.culprit ?? issue?.culprit, ev?.web_url ?? issue?.permalink].filter(Boolean).join(" "),
      ...(flag ? { flag } : {}),
      ...(files.length ? { files } : {}),
      ...(/^[0-9a-f]{7,40}$/i.test(release) ? { sha: release } : {}),
    }
  }
  if (typeof body?.title !== "string") return null
  return {
    source,
    title: body.title,
    details: String(body.details ?? body.message ?? ""),
    ...(body.flag ? { flag: String(body.flag) } : {}),
    ...(Array.isArray(body.files) ? { files: body.files.map(String) } : {}),
    ...(body.sha ? { sha: String(body.sha) } : {}),
  }
}

/** The token, compared in constant time. */
export function tokenOk(given: string | null | undefined, want: string): boolean {
  if (!given || !want) return false
  const a = crypto.createHash("sha256").update(given).digest()
  const b = crypto.createHash("sha256").update(want).digest()
  return crypto.timingSafeEqual(a, b) && given.length === want.length
}

/** One request: refused, or handed to `run` (crosstalk incident) as an incident. */
export async function handle(req: Request, want: string, run: (inc: Incident) => { ok: boolean; out: string }): Promise<Response> {
  const u = new URL(req.url)
  if (req.method !== "POST") return new Response("POST an alert here\n", { status: 405 })
  // Browsers send Origin on a cross-site POST; alerting services do not.
  if (req.headers.get("origin") !== null) return new Response("no\n", { status: 403 })
  if (!tokenOk(u.searchParams.get("token") ?? req.headers.get("x-crosstalk-token"), want)) return new Response("no\n", { status: 401 })
  const inc = fromPayload(await req.json().catch(() => null), u.searchParams.get("source") ?? "webhook")
  if (!inc) return new Response("no title\n", { status: 400 })
  const r = run(inc)
  return new Response(r.out.trim() + "\n", { status: r.ok ? 200 : 500 })
}

if (import.meta.main) {
  if (!token) {
    console.error("set CROSSTALK_INCIDENT_TOKEN to a secret first: the webhook does not run without one")
    process.exit(64)
  }
  const want = token
  Bun.serve({
    hostname: "127.0.0.1",
    port,
    fetch: (req) =>
      handle(req, want, (inc) => {
        const r = spawnSync(cli[0], [...cli.slice(1), "incident", "--json", JSON.stringify(inc)], { encoding: "utf8", timeout: 60_000 })
        return { ok: r.status === 0, out: r.stdout || r.stderr || "" }
      }),
  })
  console.log(`crosstalk incident webhook on http://127.0.0.1:${port}/ (token required)`)
}
