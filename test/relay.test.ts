// An agent's own question, answered from the main session.
//
//   bun test test/relay.test.ts

import { describe, expect, test } from "bun:test"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"

process.env.CROSSTALK_HOME = fs.mkdtempSync(path.join(os.tmpdir(), "ct-relay-"))
const Rl = await import("../src/attention/relay.ts")
const ui = await import("../src/uistate.ts")
const Mn = await import("../src/main.ts")

const Q = { question: "Keep the Pi flat?", header: "Pi pose", options: [{ label: "Pi flat", description: "Host on floor posts, like production" }, { label: "Keep any tilt" }], multiSelect: false }

describe("which questions go to main", () => {
  test("one single-select question with 2-4 choices; nothing else", () => {
    expect(Rl.relayable([Q])).toBe(true)
    expect(Rl.relayable([Q, Q])).toBe(false)
    expect(Rl.relayable([{ ...Q, multiSelect: true }])).toBe(false)
    expect(Rl.relayable([{ ...Q, kind: "text" }])).toBe(false)
    expect(Rl.relayable([{ ...Q, options: [{ label: "only one" }] }])).toBe(false)
  })
  test("to main, unless there is none, this is main, or the person is looking at this tab", () => {
    expect(Rl.target("work", { main: "main", focused: null })).toBe("main")
    expect(Rl.target("work", { main: null, focused: null })).toBe(null)
    expect(Rl.target("main", { main: "main", focused: null })).toBe(null)
    expect(Rl.target("work", { main: "main", focused: { sessionId: "work", sure: true } })).toBe(null)
    expect(Rl.target("work", { main: "main", focused: { sessionId: "work", sure: false } })).toBe("main") // a guess is not enough to keep it here
    expect(Rl.target("work", { main: "main", focused: { sessionId: "other", sure: true } })).toBe("main")
  })
})

describe("asking and answering", () => {
  test("main gets the question with who asks and the options; the pick there is the answer", () => {
    const id = Rl.relay("work-1", Q, "main-s")
    const it = ui.snapshot()[id]
    expect(it.sessionId).toBe("main-s")
    expect(it.question).toBe("Keep the Pi flat?") // who asks is on the line (its thread), never an id
    expect(it.options).toEqual(["Pi flat", "Keep any tilt"])
    expect(it.text).toBe("Pi flat: Host on floor posts, like production")
    expect(Rl.poll(id, { mainAlive: () => true })).toEqual({})
    ui.withStore((items, now) => ui.act(items, id, "answer", now, "Pi flat"))
    expect(Rl.poll(id, { mainAlive: () => true })).toEqual({ answer: "Pi flat" })
  })
  test("main gone meanwhile: asked in its own tab after all", () => {
    const id = Rl.relay("work-2", Q, "main-s")
    expect(Rl.poll(id, { mainAlive: () => false })).toEqual({ fallback: true })
    expect(Rl.poll("relay:nothing:here")).toEqual({ fallback: true })
  })
  test("main shows it: it is addressed to main", () => {
    const id = Rl.relay("work-3", Q, "main-s")
    const open = Object.values(ui.snapshot()).filter((i) => i.state === "pending")
    expect(Mn.itemsFor(open, "main-s", "main-s").some((i) => i.id === id)).toBe(true)
    expect(Mn.itemsFor(open, "work-3", "main-s").some((i) => i.id === id)).toBe(false)
  })
})

describe("questions nobody can receive any more", () => {
  test("are put away when the asker has gone, or after a day", () => {
    const now = Date.now()
    ui.withStore((items, t) => {
      ui.upsert(items, { id: "relay:gone1:a", kind: "attention", sessionId: "m", question: "x?", options: ["a"], ts: now }, t)
      ui.upsert(items, { id: "relay:here1:b", kind: "attention", sessionId: "m", question: "y?", options: ["a"], ts: now }, t)
      ui.upsert(items, { id: "relay:here1:old", kind: "attention", sessionId: "m", question: "z?", options: ["a"], ts: now - 2 * 86_400_000 }, t)
    })
    expect(Rl.sweep(now, (id) => !id.includes("gone1"))).toBe(2)
    const s = ui.snapshot()
    expect([s["relay:gone1:a"].state, s["relay:here1:b"].state, s["relay:here1:old"].state]).toEqual(["muted", "pending", "muted"])
    expect(Rl.sweep(now, () => true)).toBe(0)
    // Old "For you" to-dos from sessions on an older version: put away too.
    ui.withStore((items, t) => {
      ui.upsert(items, { id: "you:old1:h", kind: "attention", sessionId: "m", question: "Sign-in may be broken", options: ["Done", "Later"], ts: now }, t)
    })
    expect(Rl.sweep(now, () => true)).toBe(1)
    expect(ui.snapshot()["you:old1:h"].state).toBe("muted")
  })
})

describe("crosstalk proposes, the person delegates", () => {
  test("a proposal waits in the inbox; yes hands its prompt to its session, no lets it go", async () => {
    const Pr = await import("../src/attention/propose.ts")
    Pr.propose({ key: "t1", askIn: "main-s", forSession: "work-1", from: "auth", question: "auth: 2 open items its agent can do. Carry on?", prompt: "Tackle the open items you listed: …" })
    Pr.propose({ key: "t1", askIn: "main-s", forSession: "work-1", from: "auth", question: "again", prompt: "x" }) // once
    const it = ui.snapshot()[Pr.idOf("t1")]!
    expect(it.sessionId).toBe("main-s")
    expect(it.options).toEqual([Pr.DO_IT, Pr.NOT_NOW])
    expect(Object.values(ui.snapshot()).some((i) => i.id.startsWith("tackle:work-1:"))).toBe(false) // nothing sent before a yes
    expect(Pr.answer(it.id, Pr.DO_IT).ok).toBe(true)
    const sent = Object.values(ui.snapshot()).find((i) => i.id === `tackle:work-1:${it.id}`)!
    expect(sent.text).toBe("Tackle the open items you listed: …")
    Pr.propose({ key: "t2", askIn: "main-s", forSession: "work-1", from: "auth", question: "q", prompt: "p2" })
    expect(Pr.answer(Pr.idOf("t2"), Pr.NOT_NOW).ok).toBe(true)
    expect(Object.values(ui.snapshot()).some((i) => i.id === `tackle:work-1:${Pr.idOf("t2")}`)).toBe(false)
  })
})
