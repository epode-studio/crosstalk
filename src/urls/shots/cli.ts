// `crosstalk shots`: screenshots, for the Stop hook's detached capture and for people.
//
//   crosstalk shots turn --session S --cwd D --since T   a turn's after (what the hook starts)
//   crosstalk shots capture [--thread T] [--url U] [--path P]
//   crosstalk shots [list] [--thread T] [--json]
//   crosstalk shots open <words> [--thread T]           the before and after, in the image viewer
//   crosstalk shots engine                              which headless browser would be used

import * as S from "./index.ts"
import * as B from "./browser.ts"

const flag = (argv: string[], f: string) => {
  const i = argv.indexOf(f)
  return i === -1 ? undefined : argv[i + 1]
}

export async function shotsCmd(argv: string[]) {
  const sub = argv[1] && !argv[1].startsWith("--") ? argv[1] : "list"
  const session = flag(argv, "--session") ?? process.env.CLAUDE_CODE_SESSION_ID ?? ""
  const cwd = flag(argv, "--cwd") ?? process.cwd()
  const thread = flag(argv, "--thread")
  if (sub === "turn") {
    const since = Number(flag(argv, "--since"))
    const r = await S.captureFor({ sessionId: session || undefined, cwd, reason: "turn", ...(Number.isFinite(since) && since > 0 ? { changeAt: since } : {}) })
    return void console.log(JSON.stringify({ ok: r.ok, shots: r.shots.map((s) => s.file), failed: r.failed }))
  }
  if (sub === "capture") {
    const r = await S.captureFor({ sessionId: session || undefined, cwd, thread, url: flag(argv, "--url"), path: flag(argv, "--path"), reason: "demand" })
    if (argv.includes("--json")) return void console.log(JSON.stringify({ ok: r.ok, shots: r.shots, failed: r.failed, skipped: r.skipped }))
    console.log(r.text)
    if (!r.ok) process.exitCode = 1
    return
  }
  if (sub === "engine") {
    const e = B.engines({ root: cwd })
    return void console.log(e.length ? e.map((x) => `${x.kind}: ${"module" in x ? x.module : x.bin}`).join("\n") : B.NO_ENGINE)
  }
  const name = argv.slice(2).filter((x, i, a) => !x.startsWith("--") && !(i > 0 && a[i - 1].startsWith("--"))).join(" ") || undefined
  if (sub === "open") {
    const r = S.openPair({ sessionId: session || undefined, cwd, thread, name, open: true })
    console.log(r.text)
    if (!r.ok) process.exitCode = 1
    return
  }
  if (argv.includes("--json")) return void console.log(JSON.stringify({ ok: true, pairs: S.pairsOf({ thread: thread ?? S.threadFor({ sessionId: session, cwd }).thread }) }))
  console.log(S.openPair({ sessionId: session || undefined, cwd, thread, name }).text)
}
