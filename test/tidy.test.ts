// Tidy up: what is offered, what is folded, which tabs close, and the one question.
//
//   bun test test/tidy.test.ts

import { describe, expect, test } from "bun:test"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"

process.env.CROSSTALK_HOME = fs.mkdtempSync(path.join(os.tmpdir(), "ct-tidy-"))
const TD = await import("../src/sessions/tidy.ts")
const C = await import("../src/sessions/control.ts")

const NOW = 1_800_000_000_000
const MIN = 60_000
const live = (id: string, o: { cwd?: string; threads?: string[] } = {}) => ({ id, name: id, cwd: o.cwd ?? `/w/${id}`, threads: o.threads ?? [] })
const seen = (id: string, minAgo: number) => ({ sessionId: id, seenAt: NOW - minAgo * MIN })

describe("what is offered", () => {
  test("idle long enough, nothing waiting, not this one: offered, longest idle first", () => {
    const offers = TD.suggest({
      lives: [live("me"), live("old"), live("older"), live("fresh"), live("busy"), live("asks")],
      recs: [seen("me", 300), seen("old", 45), seen("older", 600), seen("fresh", 5), seen("busy", 300), seen("asks", 300)],
      status: (id) => (id === "busy" ? "busy" : "idle"),
      waiting: (id) => (id === "asks" ? 1 : 0),
      self: "me",
      now: NOW,
      idleMin: 20,
    })
    expect(offers.map((o) => o.id)).toEqual(["older", "old"])
    expect(offers[0].why).toBe("idle 10 h")
  })
})

describe("similar sessions", () => {
  test("same thread or same folder fold into one; the kept one is this, else in use, else used last", () => {
    const folds = TD.similar({
      lives: [live("a1", { threads: ["auth"] }), live("a2", { threads: ["auth"] }), live("me", { threads: ["auth"] }), live("b1", { cwd: "/w/billing" }), live("b2", { cwd: "/w/billing" }), live("c", { cwd: "/w/c" })],
      recs: [seen("a1", 10), seen("a2", 10), seen("me", 0), seen("b1", 90), seen("b2", 30), seen("c", 999)],
      status: () => "idle",
      waiting: () => 0,
      self: "me",
    })
    expect(folds.map((f) => `${f.id}>${f.into}`).sort()).toEqual(["a1>me", "a2>me", "b1>b2"])
    expect(folds.find((f) => f.id === "a1")!.why).toBe("same thread, auth")
    expect(folds.find((f) => f.id === "b1")!.why).toBe("same folder")
  })
  test("a busy session is never folded away, and is the one kept", () => {
    const folds = TD.similar({
      lives: [live("x1", { threads: ["t"] }), live("x2", { threads: ["t"] }), live("x3", { threads: ["t"] })],
      recs: [seen("x1", 1), seen("x2", 100), seen("x3", 100)],
      status: (id) => (id === "x2" ? "busy" : "idle"),
      waiting: (id) => (id === "x3" ? 2 : 0),
    })
    expect(folds.map((f) => `${f.id}>${f.into}`)).toEqual(["x1>x2"])
  })
  test("the note the kept session is handed", () => {
    const n = TD.foldNote({ name: "auth-2", why: "same thread, auth" }, { recap: "Token v2\nparsing done", files: ["src/a.ts"] })
    expect(n).toContain("auth-2 was folded into this session when tidying up (same thread, auth).")
    expect(n).toContain("Where it had got to: Token v2 parsing done")
    expect(n).toContain("src/a.ts")
    expect(n).toContain(`"resume auth-2"`)
  })
})

describe("tabs", () => {
  test("Terminal.app: only a tab running nothing but its shell, by its tty, never launching Terminal", () => {
    const s = TD.appleCloseIdleTabScript("/dev/ttys004")
    expect(s.startsWith(`if application "Terminal" is running then`)).toBe(true)
    expect(s).toContain(`if (tty of t) is "/dev/ttys004" then`)
    expect(s.indexOf(`if busy of t then return "busy"`)).toBeLessThan(s.indexOf(`do script "exit" in t`))
    expect(s).not.toContain("System Events")
  })
  test("tmux: the pane is killed only when a bare shell runs in it", () => {
    const t = { tmux: { pane: "%7", socket: "/tmp/tmux-501/default" } }
    const ran: string[] = []
    const run = (out: string) => (s: { cmd: string; args: string[] }) => (ran.push(s.args.join(" ")), { ok: true, out })
    expect(TD.closeTab(t, run("zsh\n"), "linux")).toBe(true)
    expect(ran.at(-1)).toBe("-S /tmp/tmux-501/default kill-pane -t %7")
    ran.length = 0
    expect(TD.closeTab(t, run("vim\n"), "linux")).toBe(false)
    expect(ran.some((r) => r.includes("kill-pane"))).toBe(false)
  })
  test("other terminals keep their tabs", () => {
    expect(TD.closeTabSteps({ kitty: { window: "3" } }, "darwin")).toEqual([])
    expect(TD.closeTabSteps({ program: "Apple_Terminal", tty: "/dev/ttys1" }, "linux")).toEqual([])
  })
  test("tabs left by ended sessions: newest first, one per tab, none a live session is in", () => {
    const rec = (id: string, tty: string, endedAt?: number) => ({ sessionId: id, cwd: "/w", client: "claude", pid: 1, startedAt: 0, seenAt: 0, terminal: { program: "Apple_Terminal", tty }, ...(endedAt ? { endedAt } : {}) })
    const out = TD.leftoverTabs([rec("a", "/dev/t1", 5), rec("b", "/dev/t1", 9), rec("c", "/dev/t2", 3), rec("d", "/dev/t3"), rec("e", "/dev/t4", 1)], new Set(["/dev/t2"]))
    expect(out.map((r) => r.sessionId)).toEqual(["b", "e"])
  })
})

describe("the one question", () => {
  test("says what folds where, what closes, and that each can be resumed", () => {
    const q = C.tidyQuestion({ kind: "tidy", sessions: ["x"], names: ["old"], folds: [{ id: "a2", name: "auth-2", into: "a", intoName: "auth", why: "same thread, auth" }], tabs: 3, merge: true })
    expect(q).toBe("Fold auth-2 into auth, close 1 idle session (old) and close 3 empty tabs left by ended sessions, then merge Terminal's windows into tabs? Each is archived and can be resumed; dev servers keep running. A folded session's last state goes to the one it joins.")
    expect(C.tidyQuestion({ kind: "tidy", sessions: [], names: [], folds: [], tabs: 2, merge: false })).toBe("Close 2 empty tabs left by ended sessions?")
  })
  test("without the mod, the person's own words asking to tidy are the yes", () => {
    const a = { kind: "tidy" as const, sessions: [], names: [], folds: [], tabs: 1, merge: false }
    expect(C.typedAsks({ text: "can you tidy up my sessions", at: NOW - 1000 }, a, undefined, NOW)).toBe(true)
    expect(C.typedAsks({ text: "what's the weather", at: NOW - 1000 }, a, undefined, NOW)).toBe(false)
    expect(C.typedAsks({ text: "tidy up", at: NOW - 60 * MIN }, a, undefined, NOW)).toBe(false)
  })
})
