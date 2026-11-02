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

import { spawnSync } from "node:child_process"
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

if (import.meta.main) {
  Bun.serve({
    hostname: "127.0.0.1",
    port,
    async fetch(req) {
      const u = new URL(req.url)
      if (req.method !== "POST") return new Response("POST an alert here\n", { status: 405 })
      if (token && u.searchParams.get("token") !== token && req.headers.get("x-crosstalk-token") !== token) return new Response("no\n", { status: 401 })
      const inc = fromPayload(await req.json().catch(() => null), u.searchParams.get("source") ?? "webhook")
      if (!inc) return new Response("no title\n", { status: 400 })
      const r = spawnSync(cli[0], [...cli.slice(1), "incident", "--json", JSON.stringify(inc)], { encoding: "utf8", timeout: 60_000 })
      return new Response((r.stdout || r.stderr || "").trim() + "\n", { status: r.status === 0 ? 200 : 500 })
    },
  })
  console.log(`crosstalk incident webhook on http://127.0.0.1:${port}/${token ? " (token required)" : ""}`)
}
