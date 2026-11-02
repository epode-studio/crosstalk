// Shipping's commands, for people, scripts and reviewers' wrappers.
//
//   crosstalk ship status [--thread X]           where each feature stands
//   crosstalk ship questions                     what is waiting on a person
//   crosstalk ship answer <id> <option>          answer one (a person, in a terminal; also one asked on another machine)
//   crosstalk ship watch                         check every ramping flag's metrics now
//   crosstalk ship <action> --json '{...}'       feature | ready | evidence | flag, as the tools take them
//   crosstalk review --run <id> (--output <file> | --verdict approve|changes --findings "...")
//   crosstalk incident --source <s> --title <t> [--details <d>] [--flag <f>] [--files a,b] [--sha <sha>]
//   crosstalk incident --json '{...}'            the same fields as JSON (or --stdin)
//   crosstalk incident --link <incident thread> --cause <thread>
//
// `ship answer` counts as a person's answer only outside an agent: run from a
// Claude Code tool call (CLAUDECODE is set there), it is refused like the
// agent's own tool would be.

import fs from "node:fs"
import { request } from "../client.ts"

const flag = (argv: string[], f: string) => {
  const i = argv.indexOf(f)
  return i === -1 ? undefined : argv[i + 1]
}
const VALUE = new Set(["--thread", "--json", "--run", "--output", "--verdict", "--findings", "--source", "--title", "--details", "--flag", "--files", "--sha", "--link", "--cause"])
const positional = (argv: string[]) => {
  const out: string[] = []
  for (let i = 1; i < argv.length; i++) {
    if (argv[i].startsWith("--")) {
      if (VALUE.has(argv[i])) i++
      continue
    }
    out.push(argv[i])
  }
  return out
}

const insideAgent = () => !!(process.env.CLAUDECODE || process.env.CODEX_SANDBOX || process.env.CROSSTALK_AS_AGENT)

async function send(req: Record<string, unknown>) {
  const r = await request({ op: "ship", cwd: process.cwd(), sessionId: process.env.CLAUDE_CODE_SESSION_ID, ...req }, 120_000)
  if (process.argv.includes("--raw")) console.log(JSON.stringify(r))
  else {
    console.log(r?.text ?? r?.error ?? "no answer")
    const { ok: _o, text: _t, error: _e, ...rest } = r ?? {}
    if (Object.keys(rest).length) console.log(JSON.stringify(rest, null, 2))
  }
  if (!r?.ok) process.exitCode = 1
  return r
}

const json = (argv: string[]): Record<string, unknown> => {
  const j = flag(argv, "--json")
  if (j) return JSON.parse(j)
  if (argv.includes("--stdin")) return JSON.parse(fs.readFileSync(0, "utf8"))
  return {}
}

export async function shipCmd(argv: string[]) {
  const sub = argv[1] ?? "status"
  const pos = positional(argv).slice(1)
  switch (sub) {
    case "status":
      return send({ action: "status", thread: flag(argv, "--thread") })
    case "questions":
      return send({ action: "questions" })
    case "watch":
      return send({ action: "watch" })
    case "answer": {
      const [id, ...rest] = pos
      if (!id || !rest.length) {
        console.error(`usage: crosstalk ship answer <id> <option>`)
        process.exit(64)
      }
      if (insideAgent()) {
        console.log("this question is for a person: answer it in crosstalk's picker, or run this yourself in a terminal")
        process.exitCode = 1
        return
      }
      return send({ action: "answer", id, value: rest.join(" "), person: true })
    }
    case "feature":
    case "ready":
    case "evidence":
    case "flag": {
      const { person: _p, ...args } = json(argv)
      return send({ ...args, action: sub, ...(flag(argv, "--thread") ? { thread: flag(argv, "--thread") } : {}) })
    }
    default:
      console.error(`unknown: crosstalk ship ${sub}`)
      process.exitCode = 64
  }
}

export async function reviewCmd(argv: string[]) {
  const run = flag(argv, "--run")
  if (!run) {
    console.error(`usage: crosstalk review --run <id> (--output <file> | --verdict approve|changes --findings "...")`)
    process.exit(64)
  }
  return send({ action: "review", run, output: flag(argv, "--output"), verdict: flag(argv, "--verdict"), findings: flag(argv, "--findings") })
}

export async function incidentCmd(argv: string[]) {
  if (flag(argv, "--link")) return send({ action: "incident", link: { incident: flag(argv, "--link"), cause: flag(argv, "--cause") } })
  const j = json(argv)
  const files = flag(argv, "--files")
  const req = {
    source: flag(argv, "--source") ?? j.source ?? "manual",
    title: flag(argv, "--title") ?? j.title ?? positional(argv).join(" "),
    details: flag(argv, "--details") ?? j.details ?? "",
    flag: flag(argv, "--flag") ?? j.flag,
    files: files ? files.split(",") : j.files,
    sha: flag(argv, "--sha") ?? j.sha,
  }
  if (!req.title) {
    console.error(`usage: crosstalk incident --source <s> --title <t> [--details <d>] [--flag <f>] [--files a,b] [--sha <sha>]`)
    process.exit(64)
  }
  return send({ action: "incident", ...req })
}
