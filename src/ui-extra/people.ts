// Joining with words, links, trust and muting in plain words: what the old
// room, link, trust and mute slash commands did, for the
// crosstalk_people actions room, link, trust and mute. `crosstalk room`, `link`, `trust` and `mute` stay in the CLI for
// scripts.
//
// The words. Four words (or six, for a link) are a secret said aloud once, so
// they go to the person and no further than they must:
//
//   - with crosstalk's mod in the session they are shown in the mod (the band
//     and a picker), which the model never reads, and the tool's result says
//     only that they are on the screen;
//   - without it the result has to carry them, once, with an instruction to
//     show them exactly once and never repeat them;
//   - joining takes words the person typed, so the tool takes them, and its
//     result never repeats them.

import fs from "node:fs"
import path from "node:path"
import { P, loadIdentity, loadPeers } from "../config.ts"
import { ensureDaemon, request } from "../client.ts"
import * as trust from "../trust.ts"
import * as ui from "../uistate.ts"
import { BOT_CEILING, isBot } from "./bots.ts"
import { muteCards, muteThread, parseFor, until, findForMute } from "./mute.ts"
import { runCli, startCli } from "./run.ts"

export type Out = { ok: boolean; text: string }

const INVITE = /^ {4}(\d{3,6}-[a-z]+(?:-[a-z]+)+(?: at \S+)?)\s*$/m
const LINK = /^ {4}\/crosstalk:join link (\d{3,6}-[a-z]+(?:-[a-z]+)+(?: at \S+)?)\s*$/m

export const DONE = "Done"
export const CANCEL = "Cancel it"

/**
 * Words this process has put in a result, without the mod. They go out once:
 * every later result of these tools has them taken out, whatever printed them.
 */
const issued: string[] = []

/** Any words given out before, taken out of a result. */
export function scrubIssued(text: string): string {
  let out = text
  for (const w of issued) out = scrub(out, w)
  return out
}

/** Results that carry their own words, the once they are allowed to. */
const fresh = new WeakSet<Out>()

/** The one result that carries the words, remembered so no later one does. */
export function once(words: string, out: Out): Out {
  if (!issued.includes(words)) issued.push(words)
  fresh.add(out)
  return out
}

/** What room() and link() return: no words given out before come back, except in the result that gave them. */
const guarded = (out: Out): Out => (fresh.has(out) ? out : { ...out, text: scrubIssued(out.text) })

/** Words never come back in a result: whatever a CLI printed, they are taken out. */
export function scrub(text: string, words: string | undefined): string {
  if (!words) return text
  const phrase = words.replace(/^\d{3,6}-/, "").replace(/ at \S+$/, "")
  let out = text
  for (const w of [words, phrase].filter((x) => x.length >= 8)) out = out.split(w).join("[the words]")
  return out
}

/** The words, as the person typed them, from whatever the agent passed. */
export function wordsFrom(v: unknown): string | undefined {
  const s = String(v ?? "").trim().toLowerCase()
  const m = /(\d{3,6})[\s-]+((?!at\b)[a-z]+(?:[\s-]+(?!at\b)[a-z]+){3,5})(\s+at\s+\S+)?/.exec(s)
  if (!m) return undefined
  return `${m[1]}-${m[2].split(/[\s-]+/).join("-")}${m[3] ? ` at ${m[3].trim().replace(/^at\s+/, "")}` : ""}`
}

/** Put words in the mod's store, for the person's eyes alone. */
function showWords(sessionId: string, o: { id: string; words: string; question: string; pid?: number }) {
  ui.withStore((items, now) =>
    ui.upsert(items, { id: o.id, kind: "invite", sessionId, text: o.words, question: o.question, options: [DONE, CANCEL], names: o.pid ? [String(o.pid)] : [], ts: now }, now),
  )
}

export async function room(a: Record<string, any>, o: { sessionId: string; root: string; mod: boolean }): Promise<Out> {
  return guarded(await roomOut(a, o))
}

async function roomOut(a: Record<string, any>, o: { sessionId: string; root: string; mod: boolean }): Promise<Out> {
  const action = String(a.action ?? "list").toLowerCase()
  if (action === "new") {
    const args = ["room", "new", ...(a.label ? ["--label", String(a.label)] : []), ...(a.relay ? ["--relay", String(a.relay)] : [])]
    const log = path.join(P.root, "ui-extra", `room-${Date.now()}.log`)
    const r = await startCli(o.root, args, { log, until: INVITE })
    if (!r.ok || !r.match) return { ok: false, text: `could not get words: ${r.out.split("\n").filter(Boolean).slice(-2).join(" ") || "no answer"}` }
    const words = r.match[1]
    if (o.mod && o.sessionId) {
      showWords(o.sessionId, {
        id: `invite:${words.split("-")[0]}`,
        words,
        pid: r.pid,
        question: `Read these words to the person joining, aloud or somewhere you already trust: ${words}. They work once, for fifteen minutes.`,
      })
      return {
        ok: true,
        text: "Made four words. The words are on the user's screen, in crosstalk's picker, and deliberately not here. Tell the user to read them to the other person, whose agent joins with them. They work once, for fifteen minutes; crosstalk_people action \"peers\" shows the person once they are in.",
      }
    }
    return once(words, {
      ok: true,
      text: `Made four words. Show the user these words exactly once, as written, and never repeat them in a later reply: ${words}\nThey read them aloud to the other person, who tells their own agent "join crosstalk with <the words>". They work once and expire in fifteen minutes; crosstalk_people action "peers" shows the person once they are in.`,
    })
  }
  if (action === "join") {
    const words = wordsFrom(a.words)
    if (!words) return { ok: false, text: "pass the words the user was read: a number and four words, like 4821-otter-basalt-thunder-anvil" }
    const r = await runCli(o.root, ["room", "join", words, ...(a.label ? ["--label", String(a.label)] : []), ...(a.agent ? ["--agent"] : [])], { timeoutMs: 170_000 })
    return { ok: r.ok, text: scrub(r.out, words) }
  }
  if (!loadIdentity()) return { ok: false, text: 'crosstalk is not set up yet: start with op "new", or join with the words someone read you' }
  if (!(await ensureDaemon(o.root))) return { ok: false, text: "the crosstalk daemon would not start; crosstalk_inbox action \"report\" says why" }
  const name = String(a.name ?? a.room ?? "").replace(/^#/, "")
  const people = ([] as string[]).concat(a.who ?? a.people ?? []).map(String).filter(Boolean)
  switch (action) {
    case "list": {
      const r = await request({ op: "rooms" })
      return { ok: true, text: JSON.stringify({ rooms: r.rooms, direct: r.direct }, null, 2) }
    }
    case "create": {
      if (!name) return { ok: false, text: "name the room" }
      const r = await request({ op: "room_create", name })
      return r.ok ? { ok: true, text: `Created #${r.room}. Invite people you already joined with words (op "invite").` } : { ok: false, text: r.error }
    }
    case "invite": {
      if (!name || !people.length) return { ok: false, text: "say which room and who" }
      const said: string[] = []
      for (const p of people) {
        const r = await request({ op: "room_invite", room: name, peer: p })
        said.push(r.ok ? `invited ${r.invited} to #${r.room}` : `${p}: ${r.error}`)
      }
      return { ok: true, text: `${said.join("; ")}. Each of them accepts before anything from these people reaches them.` }
    }
    case "accept":
    case "decline":
    case "leave": {
      if (!name) return { ok: false, text: "say which room" }
      const r = await request({ op: `room_${action}`, room: name })
      return r.ok ? { ok: true, text: action === "accept" ? `Joined #${r.room}.` : action === "decline" ? `Declined #${r.room}.` : `Left #${r.room}.` } : { ok: false, text: r.error }
    }
    case "kick":
    case "remove": {
      if (!name || !people[0]) return { ok: false, text: "say which room and who" }
      const r = await request({ op: "room_kick", room: name, peer: people[0] })
      if (!r.ok) return { ok: false, text: r.error }
      return {
        ok: true,
        text: `Removed ${r.removed} from #${name}; what they share has a new key.${r.unreachable?.length ? ` Could not hand it to ${r.unreachable.join(", ")}: someone with a direct channel to them has to pass it on.` : ""}`,
      }
    }
    default:
      return { ok: false, text: `unknown op "${action}": new, join, create, invite, accept, decline, leave, kick or list` }
  }
}

/** Your own machines: mostly done by repository trust now; this is for a machine outside any shared repo. */
export async function link(a: Record<string, any>, o: { sessionId: string; root: string; mod: boolean }): Promise<Out> {
  return guarded(await linkOut(a, o))
}

async function linkOut(a: Record<string, any>, o: { sessionId: string; root: string; mod: boolean }): Promise<Out> {
  const words = a.words ? wordsFrom(a.words) : undefined
  if (a.words && !words) return { ok: false, text: "pass the six words exactly as the other machine showed them, number first" }
  if (words) {
    const r = await runCli(o.root, ["link", words], { timeoutMs: 170_000 })
    return { ok: r.ok, text: scrub(r.out, words) }
  }
  const log = path.join(P.root, "ui-extra", `link-${Date.now()}.log`)
  const r = await startCli(o.root, ["link"], { log, until: LINK })
  if (!r.ok || !r.match) return { ok: false, text: `could not start a link: ${r.out.split("\n").filter(Boolean).slice(-2).join(" ") || "no answer"}` }
  const w = r.match[1]
  if (o.mod && o.sessionId) {
    showWords(o.sessionId, {
      id: `invite:link-${w.split("-")[0]}`,
      words: w,
      pid: r.pid,
      question: `On your other machine, tell its agent "link this machine with ${w}". These six words carry your whole identity: keep them between your own two machines.`,
    })
    return { ok: true, text: "Started a link. The six words are on the user's screen, deliberately not here: they carry the user's whole identity. The user gives them to the agent on their other machine." }
  }
  return once(w, {
    ok: true,
    text: `Started a link. Show the user these six words exactly once and never repeat them: ${w}\nThey carry the user's whole identity. On the other machine the user tells its agent "link this machine with <the words>". Most people need none of this: a teammate's machines and your own are trusted through the repository already.`,
  })
}

export async function trustTool(a: Record<string, any>): Promise<Out> {
  const who = String(a.who ?? "").replace(/^@/, "").trim()
  const level = String(a.level ?? "").toLowerCase()
  const t = trust.load()
  if (!who && !level)
    return { ok: true, text: JSON.stringify({ default: t.default, rooms: t.rooms, people: t.people, levels: trust.DESCRIPTION }, null, 2) }
  if (!trust.isLevel(level)) return { ok: false, text: `the level is one of ${trust.LEVELS.join(", ")}` }
  if (who && isBot(who) && trust.rank(level) > trust.rank(BOT_CEILING))
    return { ok: false, text: `${who} is an agent, and an agent is never above "${BOT_CEILING}": it can post, never ask, hand off or put words in a turn. Nothing changed.` }
  if (!who) {
    t.default = level
    trust.save(t)
    return { ok: true, text: `Anyone you joined with words, by default: ${level} (${trust.DESCRIPTION[level]}).` }
  }
  const room = a.room ? String(a.room).replace(/^#/, "") : undefined
  if (room || loadPeers()[who]) {
    t.people[who] = level
    if (room) t.rooms[room] = t.rooms[room] ?? trust.ROOM_DEFAULT
    trust.save(t)
    return { ok: true, text: `${who}: ${level} (${trust.DESCRIPTION[level]}).` }
  }
  t.rooms[who.replace(/^#/, "")] = level
  trust.save(t)
  return { ok: true, text: `#${who.replace(/^#/, "")}: ${level} for everyone in it.` }
}

export async function muteTool(a: Record<string, any>, o: { sessionId: string; root: string }): Promise<Out> {
  const ms = parseFor(a.for)
  if (ms === null) return { ok: false, text: 'say how long as minutes or plain words: "30m", "2h", "a day", "until tomorrow", "forever", or 0 to unmute' }
  const thread = a.thread ? String(a.thread) : undefined
  const who = a.who ? String(a.who).replace(/^@/, "").trim() : undefined
  if (!thread && !who) return { ok: false, text: "say who or which thread to mute" }
  const said: string[] = []
  if (thread) {
    const t = findForMute(thread, o.sessionId)
    if (!t) return { ok: false, text: `no thread called "${thread}"` }
    const r = muteThread(t, ms)
    said.push(ms ? `Muted the ${r.name} thread ${until(ms)}: its messages wait quietly, nothing is dropped.` : `Unmuted the ${r.name} thread.`)
  }
  if (who) {
    const everyone = /^(everyone|everybody|all)$/i.test(who)
    if (!everyone && !loadPeers()[who]) return { ok: false, text: `nobody called "${who}". crosstalk_people action "peers" lists who you are connected to.` }
    if (!(await ensureDaemon(o.root))) return { ok: false, text: "the crosstalk daemon would not start" }
    const r = await request({ op: "mute", peer: everyone ? undefined : who, minutes: ms / 60_000 })
    if (!r.ok) return { ok: false, text: r.error ?? "not muted" }
    if (ms) muteCards((it) => everyone || (it.from ?? "").toLowerCase() === who.toLowerCase())
    said.push(ms ? `Muted ${everyone ? "everyone" : who} ${until(ms)}: messages wait quietly, nothing is dropped.` : `Unmuted ${everyone ? "everyone" : who}.`)
  }
  return { ok: true, text: said.join(" ") }
}

/** The mod's picker answered an invite: Done keeps it running, Cancel stops it. */
export function inviteAct(id: string, action: string, value: string | undefined) {
  if (action === "raised" || action === "later") return ui.withStore((items, now) => ui.act(items, id, action, now))
  const claim = ui.withStore((items, now) => ui.act(items, id, "answer", now, value))
  if (!claim.ok) return claim
  if (value === CANCEL || action === "mute") {
    const pid = Number(claim.item.names?.[0] ?? 0)
    if (pid > 1)
      try {
        process.kill(pid, "SIGTERM")
      } catch {}
    return { ok: true, item: claim.item, text: "Cancelled: those words no longer work." }
  }
  return { ok: true, item: claim.item, text: "They can join with the words for fifteen minutes." }
}

/** Logs of rooms and links started from a tool, older than a day, removed. */
export function pruneLogs(now = Date.now()) {
  const dir = path.join(P.root, "ui-extra")
  try {
    for (const f of fs.readdirSync(dir))
      if (/^(room|link)-\d+\.log$/.test(f) && now - fs.statSync(path.join(dir, f)).mtimeMs > 24 * 60 * 60_000) fs.unlinkSync(path.join(dir, f))
  } catch {}
}
