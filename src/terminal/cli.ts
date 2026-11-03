// The terminal workspace's commands, for scripts and for the mod.
//
//   crosstalk spawn [--count N] [--name X] [--thread T] [--background] "<task>"
//   crosstalk show <name>
//   crosstalk cleanup [--yes] [--include <worktree>]...
//   crosstalk term status --session <id> (--state <s> | --event <E> [--type <t>]) [--pending N]
//   crosstalk term apply --session <id>        the detached applier (not for people)
//   crosstalk term tmux-snippet                what to add to ~/.tmux.conf
//   crosstalk term reset-colours               put back Terminal.app backgrounds crosstalk tinted

import * as S from "./status.ts"
import * as ui from "../uistate.ts"
import * as spawn from "../spawn.ts"
import * as cleanup from "../cleanup.ts"
import { readRegistry } from "../gather.ts"

const flag = (argv: string[], f: string) => {
  const i = argv.indexOf(f)
  return i === -1 ? undefined : argv[i + 1]
}
const flags = (argv: string[], f: string) => argv.flatMap((a, i) => (a === f && argv[i + 1] !== undefined ? [argv[i + 1]] : []))
const VALUE = new Set(["--count", "--name", "--thread", "--session", "--state", "--event", "--type", "--pending", "--include", "--cwd"])
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

const STATES = new Set(["working", "waiting", "done", "off"])

export async function termCmd(argv: string[], root: string) {
  const sub = argv[1]
  if (sub === "tmux-snippet") return void console.log(S.TMUX_SNIPPET)
  if (sub === "reset-colours" || sub === "reset-colors") return void console.log(JSON.stringify(S.resetColours()))
  const session = flag(argv, "--session") ?? process.env.CLAUDE_CODE_SESSION_ID ?? ""
  if (!session) return void console.log(JSON.stringify({ ok: false, error: "--session is needed" }))
  if (sub === "apply") return void console.log(await S.applyLoop(session))
  if (sub === "status") {
    const tab = S.readTab(session)
    // The state asked for last, under any broken mark (src/urls/health/).
    const current = tab?.base ?? tab?.want
    const pending = flag(argv, "--pending") !== undefined ? Number(flag(argv, "--pending")) : S.pendingFor(session, ui.snapshot)
    const asked = flag(argv, "--state")
    const event = flag(argv, "--event")
    let state: S.TabState | null = null
    if (asked && STATES.has(asked)) state = asked as S.TabState
    else if (event === "refresh") state = S.stateFromRegistry({ status: readRegistry().find((e) => e.sessionId === session)?.status, pending, current })
    else if (event) state = S.stateForEvent({ event, pending, current, notificationType: flag(argv, "--type") })
    const changed = state ? S.want({ sessionId: session, state, root }) : false
    return void console.log(JSON.stringify({ ok: true, state: S.readTab(session)?.want ?? state ?? current ?? null, changed }))
  }
  console.log(JSON.stringify({ ok: false, error: `unknown: crosstalk term ${sub ?? ""}` }))
}

export async function spawnCmd(argv: string[]) {
  const task = positional(argv).join(" ").trim()
  if (!task) {
    console.error(`usage: crosstalk spawn [--count N] [--name X] [--thread T] [--background] "<task>"`)
    process.exit(64)
  }
  const out = await spawn.spawnFromSession({
    count: Number(flag(argv, "--count") ?? 1),
    name: flag(argv, "--name"),
    background: argv.includes("--background"),
    task,
    cwd: flag(argv, "--cwd") ?? process.cwd(),
    by: process.env.CLAUDE_CODE_SESSION_ID,
    threadName: flag(argv, "--thread"),
  })
  console.log(out.text)
  if (!out.ok) process.exitCode = 1
}

export async function showCmd(argv: string[]) {
  const name = positional(argv)[0]
  if (!name) {
    const bg = spawn.readSpawned().filter((r) => r.background && !r.removedAt && spawn.tmuxHas(r.tmux!))
    console.log(bg.length ? `in the background: ${bg.map((r) => r.name).join(", ")}\n  crosstalk show <name>` : "no agent is running in the background")
    return
  }
  const out = spawn.show({ name, cwd: process.cwd(), by: process.env.CLAUDE_CODE_SESSION_ID })
  console.log(out.text)
  if (!out.ok) process.exitCode = 1
}

export async function cleanupCmd(argv: string[]) {
  const out = cleanup.run({ confirm: argv.includes("--yes") || argv.includes("-y"), include: flags(argv, "--include"), cwd: process.cwd() })
  console.log(out.text)
  if (!out.ok) process.exitCode = 1
}
