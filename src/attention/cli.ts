// `crosstalk attn …`: what crosstalk's mod, its notifications and scripts call.
//
//   crosstalk attn focus --session <id> [--name <n>]    bring a session to the front
//                                                        (a notification's click)
//   crosstalk attn context --session <id> --percent <p> [--tokens <n>] [--window <n>]
//                                                        the mod's context reading
//   crosstalk attn answer --id <attn:…> --value <option>  answer a question
//   crosstalk attn where                                  which session is in front,
//                                                        where a question would go,
//                                                        and whether you are away

import { daemonRunning, request } from "../client.ts"
import * as spawn from "../spawn.ts"
import { focusSession } from "./show.ts"

const flag = (argv: string[], f: string) => {
  const i = argv.indexOf(f)
  return i === -1 ? undefined : argv[i + 1]
}

export async function attnCmd(argv: string[]) {
  const sub = argv[1]
  const session = flag(argv, "--session") ?? process.env.CLAUDE_CODE_SESSION_ID ?? ""
  const print = (o: unknown) => console.log(JSON.stringify(o))
  switch (sub) {
    case "focus": {
      const name = flag(argv, "--name")
      const r = focusSession({ sessionId: session || undefined, name })
      if (r.ok || r.found || !name) return console.log(r.text)
      // Not one of the person's own: a background agent opens in a tab instead.
      return console.log(spawn.show({ name, cwd: process.cwd() }).text)
    }
    case "context": {
      if (!session || !daemonRunning()) return print({ ok: false })
      return print(
        await request({ op: "attn_context", sessionId: session, percent: Number(flag(argv, "--percent")), tokens: Number(flag(argv, "--tokens") ?? 0), window: Number(flag(argv, "--window") ?? 0) }, 5000).catch((e) => ({ ok: false, error: e.message })),
      )
    }
    case "answer": {
      if (!daemonRunning()) return print({ ok: false, error: "the crosstalk daemon is not running" })
      return print(await request({ op: "attn_act", sessionId: session, id: flag(argv, "--id"), action: "answer", value: flag(argv, "--value") }, 60_000))
    }
    case "where":
      if (!daemonRunning()) return print({ ok: false, error: "the crosstalk daemon is not running" })
      return print(await request({ op: "attn_focus", sessionId: session }, 10_000))
    default:
      return print({ ok: false, error: `unknown: crosstalk attn ${sub ?? ""}` })
  }
}
