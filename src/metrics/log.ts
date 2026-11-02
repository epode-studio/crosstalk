// Local measurements (docs/design/next-generation.md, "Against Entire"): the
// numbers behind "fewer tokens" and "human minutes per merged thread".
//
// One append-only file on this machine, <crosstalk home>/metrics.jsonl. Nothing
// here is ever sent anywhere: not over the relay, not to the ref, not to any
// service. crosstalk_doctor action "stats" reads it back, and so can anyone with `cat`.
//
//   asked     a question went up for a person (a picker, or its systemMessage)
//   answered  a person answered one: how long it was open
//   auto      a standing rule answered one instead of a person
//   prompt    a person submitted a prompt: its length, for typing time
//   session   a session started, and whether it started from a thread brief
//
// Every write is a best effort: a full disk or a read-only home never stops a
// hook or a picker over a statistic.

import fs from "node:fs"
import path from "node:path"
import { ROOT } from "../config.ts"

export type Event =
  | { k: "asked"; at: number; id: string; kind: string; thread?: string }
  | { k: "answered"; at: number; id: string; kind: string; openMs: number; thread?: string }
  | { k: "auto"; at: number; id: string; what: string; repo?: string }
  | { k: "prompt"; at: number; sid: string; chars: number; threads?: string[] }
  | { k: "session"; at: number; sid: string; brief: boolean; threads?: string[]; cwd?: string; transcript?: string }

export const file = () => path.join(process.env.CROSSTALK_HOME ?? ROOT, "metrics.jsonl")

/** The file is trimmed to its newest half once it passes this. */
const MAX_BYTES = 8 * 1024 * 1024

export const off = () => process.env.CROSSTALK_NO_METRICS === "1"

export function record(e: Event) {
  if (off()) return
  try {
    const f = file()
    fs.mkdirSync(path.dirname(f), { recursive: true, mode: 0o700 })
    fs.appendFileSync(f, JSON.stringify(e) + "\n", { mode: 0o600 })
    const size = fs.statSync(f).size
    if (size > MAX_BYTES) {
      const lines = fs.readFileSync(f, "utf8").split("\n").filter(Boolean)
      const tmp = `${f}.${process.pid}.tmp`
      fs.writeFileSync(tmp, lines.slice(Math.floor(lines.length / 2)).join("\n") + "\n", { mode: 0o600 })
      fs.renameSync(tmp, f)
    }
  } catch {}
}

export function read(f = file()): Event[] {
  try {
    return fs
      .readFileSync(f, "utf8")
      .split("\n")
      .filter(Boolean)
      .flatMap((l) => {
        try {
          const e = JSON.parse(l)
          return e && typeof e.k === "string" && typeof e.at === "number" ? [e as Event] : []
        } catch {
          return []
        }
      })
  } catch {
    return []
  }
}

/** Kinds of item that put a question to a person; messages and cards are not questions. */
export const QUESTION_KINDS = new Set(["route", "gather", "team", "cleanup", "thread", "ship", "rule", "connect", "conflict", "disk", "install", "restore"])
