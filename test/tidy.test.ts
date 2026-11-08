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
      lives: [live("a1", { threads: ["auth"], cwd: "/w/app" }), live("a2", { threads: ["auth"], cwd: "/w/app" }), live("me", { threads: ["auth"], cwd: "/w/app" }), live("a3", { threads: ["auth"], cwd: "/w/worktrees/auth-3" }), live("b1", { cwd: "/w/billing" }), live("b2", { cwd: "/w/billing" }), live("c", { cwd: "/w/c" })],
      recs: [seen("a1", 30), seen("a2", 25), seen("me", 0), seen("a3", 90), seen("b1", 90), seen("b2", 30), seen("c", 999)],
      status: () => "idle",
      waiting: () => 0,
      self: "me",
      now: NOW,
      idleMin: 20,
    })
    expect(folds.map((f) => `${f.id}>${f.into}`).sort()).toEqual(["a1>me", "a2>me", "b1>b2"]) // a3 works in its own worktree: a separate line of work
    expect(folds.find((f) => f.id === "a1")!.why).toBe("same thread, auth")
    expect(folds.find((f) => f.id === "b1")!.why).toBe("same folder")
  })
  test("nothing is folded into main, which does no thread's work, even in the same folder", () => {
    const folds = TD.similar({
      lives: [live("main", { cwd: "/w/app" }), live("x", { cwd: "/w/app" }), live("y", { cwd: "/w/app" })],
      recs: [seen("main", 0), seen("x", 50), seen("y", 10)],
      status: () => "idle",
      waiting: () => 0,
      self: "main",
      main: "main",
      now: NOW,
      idleMin: 20,
    })
    expect(folds.map((f) => `${f.id}>${f.into}`)).toEqual(["x>y"])
  })
  test("a busy session is never folded away, and is the one kept", () => {
    const folds = TD.similar({
      lives: [live("x1", { threads: ["t"], cwd: "/w/t" }), live("x2", { threads: ["t"], cwd: "/w/t" }), live("x3", { threads: ["t"], cwd: "/w/t" }), live("x4", { threads: ["t"], cwd: "/w/t" })],
      recs: [seen("x1", 30), seen("x2", 100), seen("x3", 100), seen("x4", 2)],
      status: (id) => (id === "x2" ? "busy" : "idle"),
      waiting: (id) => (id === "x3" ? 2 : 0),
      now: NOW,
      idleMin: 20,
    })
    expect(folds.map((f) => `${f.id}>${f.into}`)).toEqual(["x1>x2"]) // x4 finished a turn two minutes ago: not yet
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
  test("Terminal.app: a Claude tab running nothing, by its tty, closed with Cmd-W only once it is in front", () => {
    const s = TD.appleCloseIdleTabScript("/dev/ttys004")
    expect(s.startsWith(`if application "Terminal" is not running then return ""`)).toBe(true)
    expect(s).toContain(`if (tty of t) is "/dev/ttys004" then`)
    const key = s.indexOf(`keystroke "w" using command down`)
    expect(s.indexOf(`if busy of t then return "busy"`)).toBeLessThan(key)
    expect(s.indexOf(`does not contain "claude" then return "not-claude"`)).toBeLessThan(key) // full-screen Claude leaves no banner
    expect(s.indexOf(`if not frontmost then return "not-front"`)).toBeLessThan(key)
    expect(s.indexOf(`(tty of selected tab of front window) is not "/dev/ttys004" then return "not-front"`)).toBeLessThan(key)
    expect(s).not.toContain(`do script "exit"`) // a profile may keep the tab open after the shell exits
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
  test("why a tab stayed open is said, not hidden", () => {
    const t = { program: "Apple_Terminal", tty: "/dev/ttys9" }
    expect(TD.closeTabWhy(t, () => ({ ok: true, out: "not-claude\n" }), "darwin")).toBe("not-claude")
    expect(TD.closeTabWhy(t, () => ({ ok: true, out: "closed" }), "darwin")).toBe("closed")
    expect(TD.closeTabWhy(t, () => ({ ok: false, out: "System Events got an error: osascript is not allowed assistive access. (-1719)" }), "darwin")).toBe("accessibility")
    expect(TD.closeTabWhy({ kitty: { window: "1" } }, () => ({ ok: true, out: "" }), "darwin")).toBe("unsupported")
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

describe("every agent at a glance", () => {
  test("waiting on you first, then working, then idle; ended and dead ones left out", async () => {
    const A = await import("../src/ui-extra/agents.ts")
    const rec = (id: string, o: Record<string, unknown> = {}) => ({ sessionId: id, cwd: `/w/${id}`, pid: 10, seenAt: NOW - 30 * MIN, terminal: {}, ...o }) as any
    const list = A.agentsFrom({
      recs: [rec("idle1"), rec("busy", { thread: "auth" }), rec("asks"), rec("q"), rec("gone", { endedAt: 1 }), rec("dead", { pid: 99 })],
      status: (id) => (id === "busy" ? "busy" : "idle"),
      waiting: (id) => (id === "q" ? 2 : 0),
      alive: (pid) => pid !== 99,
      name: () => undefined,
      asking: (id) => id === "asks",
      self: "busy",
      now: NOW,
    })
    const dot = (await import("../src/ui-extra/pure.ts")).dotFor("auth")
    expect(list.map((a) => A.agentLine(a))).toEqual(["❓ Asks · waiting on you", "❓ Q · 2 for you", `${dot}⏳ Auth`, "✅ Idle1 · idle 30 min"]) // named by its work, in words
  })
  test("\"show me all my agents\" is the pane's agents view, and the main session's pane", async () => {
    const P = await import("../src/ui-extra/pane.ts")
    expect(P.AGENTS.test("agents")).toBe(true)
    expect(P.AGENTS.test("all my agents")).toBe(true)
    expect(P.AGENTS.test("auth")).toBe(false)
    const out = P.agentsPane("me", [{ name: "a", state: "waiting", forYou: 1 }, { name: "b", state: "working" }])
    expect(out.ok && out.pane.status).toBe("nothing needs you · 1 working") // main's own inbox is empty here; the waiting one asks nothing yet
  })
})

describe("the main session", () => {
  test("adding an agent to a stuck thread, and a background agent's permission prompt, go to main", async () => {
    const Mn = await import("../src/main.ts")
    const it = (id: string, kind = "attention") => ({ id, kind, sessionId: "work", state: "pending", createdAt: 1, updatedAt: 1 }) as any
    const open = [it("attn:staff:t1:5"), it("attn:perm:x"), it("attn:dispose:y"), it("m1", "message")]
    expect(Mn.itemsFor(open, "main-s", "main-s").map((i) => i.id)).toEqual(["attn:staff:t1:5", "attn:perm:x"])
    expect(Mn.itemsFor(open, "work", "main-s").map((i) => i.id)).toEqual(["attn:dispose:y", "m1"])
  })
  test("the staffing question says what the thread is doing, what it is stuck on, and who is on it", async () => {
    const St = await import("../src/attention/staffing.ts")
    const c = St.context({ recap: "LED matrix takes no view", s: { why: "question", since: NOW - 3 * 60 * MIN, question: "keep v1?" }, agents: ["palpable-5d"], now: NOW })
    expect(c).toContain("What it is doing: LED matrix takes no view")
    expect(c).toContain(`on: "keep v1?"`)
    expect(c).toContain("On it: palpable-5d.")
  })
})

describe("questions already waiting", () => {
  test("an agent's own unanswered question is found in its transcript, an answered one is not", async () => {
    const T = await import("../src/sessions/transcripts.ts")
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ct-ask-"))
    const f = path.join(dir, "t.jsonl")
    const ask = { type: "assistant", timestamp: new Date(NOW).toISOString(), message: { role: "assistant", content: [{ type: "tool_use", id: "tu1", name: "AskUserQuestion", input: { questions: [{ question: "Keep the Pi flat?", options: [{ label: "Pi flat" }, { label: "Keep any tilt" }] }] } }] } }
    fs.writeFileSync(f, JSON.stringify(ask) + "\n")
    expect(T.openQuestion(f)).toEqual({ question: "Keep the Pi flat?", options: ["Pi flat", "Keep any tilt"], at: NOW })
    fs.appendFileSync(f, JSON.stringify({ type: "user", message: { role: "user", content: [{ type: "tool_result", tool_use_id: "tu1", content: "Pi flat" }] } }) + "\n")
    expect(T.openQuestion(f)).toBe(null)
  })
  test("main's pane: what needs you (an agent's own question too), then what works; in words", async () => {
    const P = await import("../src/ui-extra/pane.ts")
    const pure = await import("../src/ui-extra/pure.ts")
    const list = [
      { name: "organic-case-81", thread: "organic-case-shape-brief-design", state: "waiting" as const, asks: "Keep the Pi flat? (Pi flat / Keep any tilt)", sessionId: "case" },
      { name: "palpable-5d", thread: "a-module-change", state: "working" as const, sessionId: "w" },
      { name: "palpable-9", state: "idle" as const, idleMin: 300, sessionId: "i" },
      { name: "main", state: "waiting" as const, forYou: 21, here: true, sessionId: "me" },
    ]
    const out = P.agentsPane("me", list)
    if (!out.ok) throw new Error("no pane")
    const lines = pure.paneLines(out.pane, NOW)
    const dot = pure.dotFor("organic-case-shape-brief-design")
    expect(lines.slice(0, 4)).toEqual(["◢ main · 1 needs you · 1 working", "", "Needs you · 1", ` 1. ${dot} Organic case shape brief… — Keep the Pi flat? (Pi flat / Keep any tilt) (in its tab)`])
    expect(lines).toContain("Working · 1")
    expect(lines.some((l) => l.includes("A module change"))).toBe(true)
    expect(lines.join("\n")).not.toContain("palpable-") // never a session's id
    expect(lines.at(-1)).toContain("1 idle")
  })
})

describe("a new agent's first prompt", () => {
  test("a long one goes in a git-ignored file beside it, so the tab is not titled with it", async () => {
    const B = await import("../src/terminal/brief.ts")
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ct-brief-"))
    const ex = path.join(dir, "exclude")
    const long = "You are a fresh session on the crosstalk thread. ".repeat(5)
    const argv = B.shortArgv(["claude", long], dir, { excludeFile: () => ex })
    expect(argv[0]).toBe("claude")
    expect(argv[1]).toMatch(/^Start from \.crosstalk-brief-[0-9a-f]{6}\.md$/)
    expect(fs.readFileSync(path.join(dir, argv[1].slice("Start from ".length)), "utf8")).toBe(long + "\n")
    expect(fs.readFileSync(ex, "utf8")).toContain(".crosstalk-brief-*.md")
    B.shortArgv(["claude", long], dir, { excludeFile: () => ex })
    expect(fs.readFileSync(ex, "utf8").split(".crosstalk-brief-*.md").length).toBe(2) // added once
    expect(B.shortArgv(["claude", "fix the login"], dir, { excludeFile: () => ex })).toEqual(["claude", "fix the login"])
    expect(B.shortArgv(["claude", "--resume", "abc"], dir, { excludeFile: () => ex })).toEqual(["claude", "--resume", "abc"])
    expect(B.shortArgv(["claude", long], dir, { excludeFile: () => null })).toEqual(["claude", long]) // not git: as before
  })
})

describe("tabs that say what they are", () => {
  test("each thread has its colour, the same every time, in front of the title", async () => {
    const H = await import("../src/terminal/hook.ts")
    expect(H.dotFor("auth")).toBe(H.dotFor("Auth"))
    expect(H.withDot("auth · auth-1", "auth", {})).toBe(`${H.dotFor("auth")} auth · auth-1`)
    expect(H.withDot(`${H.dotFor("auth")} auth · auth-1`, "auth", {})).toBe(`${H.dotFor("auth")} auth · auth-1`) // never twice
    expect(H.withDot("bg", undefined, {})).toBe("bg") // no thread, no colour
    expect(H.withDot("auth · x", "auth", { CROSSTALK_NO_TITLE_DOT: "1" })).toBe("auth · x")
    const colours = new Set(["auth", "billing", "search", "payments", "onboarding", "api"].map(H.dotFor))
    expect(colours.size).toBeGreaterThan(2)
  })
  test("Terminal.app's tab is given the title itself, never launching Terminal", async () => {
    const S = await import("../src/terminal/status.ts")
    const s = S.appleTitleScript("/dev/ttys004", "🟣 auth · auth-1")
    expect(s.startsWith(`if application "Terminal" is running then`)).toBe(true)
    expect(s).toContain(`set custom title of t to "🟣 auth · auth-1"`)
    expect(s).toContain(`set title displays custom title of t to true`)
  })
  test("restore's picker offers only the recent ones when fewer than all were", async () => {
    const U = await import("../src/uicli.ts")
    expect(U.restoreWant("answer", "Only the recent 4")).toBe("recent")
    expect(U.restoreWant("answer", "Restore")).toBe("yes")
  })
})

describe("the inbox", () => {
  test("most pressing first: what you just asked for, then an agent stopped on you, then the rest; waiting raises", async () => {
    const pure = await import("../src/ui-extra/pure.ts")
    const it = (id: string, kind: string, minAgo: number) => ({ id, kind, createdAt: NOW - minAgo * MIN })
    const order = pure.inboxOrder(
      [it("open:s:1", "attention", 5), it("attn:staff:t:1", "attention", 2), it("relay:s:1", "attention", 1), it("sess:1", "session", 0), it("m1", "message", 600)],
      NOW,
    ).map((i) => i.id)
    expect(order).toEqual(["sess:1", "relay:s:1", "m1", "attn:staff:t:1", "open:s:1"]) // the ten-hour-old card has risen past staffing
    expect(pure.inboxLine({ id: "relay:s:1", kind: "attention", createdAt: NOW - 12 * MIN, question: "organic-case-81 asks: Keep the Pi flat?", from: "organic-case-81" }, NOW)).toBe("Organic case 81 — Keep the Pi flat? · 12m") // plain words: the work's name, the question, how long
  })
})

describe("the board", () => {
  test("every thread, what waits, tasks, decisions and PRs; escaped; no scripts", async () => {
    const B = await import("../src/ui-extra/board.ts")
    const html = B.boardHtml(
      [
        {
          thread: "auth",
          status: "active",
          repo: "acme/app",
          recap: "Token v2 <b>",
          people: ["marie"],
          sessions: 2,
          waiting: ["Keep v1 for one more release? (blocking)"],
          notes: [{ kind: "task", text: "write the expiry migration", state: "open" }, { kind: "decision", text: "tokens are JWTs", at: NOW - 60 * MIN }],
          recent: [{ from: "marie", text: "landed" }],
          features: [{ name: "v2 tokens", risk: "risky", flag: "auth-v2", stage: "internal" }],
          running: [{ kind: "pr", label: "auth · PR #12", url: "https://github.com/acme/app/pull/12", alive: true, owner: "you", state: "OPEN", checks: "failed", failed: ["e2e"] }],
        },
        { thread: "old", status: "done", people: [], sessions: 0, waiting: [], recent: [], features: [] },
      ] as any,
      NOW,
    )
    expect(html).toContain("1 going · 1 waiting on you")
    expect(html).toContain("Token v2 &lt;b&gt;")
    expect(html).toContain("<h3>Waiting on you</h3>")
    expect(html).toContain("write the expiry migration")
    expect(html).toContain("tokens are JWTs")
    expect(html).toContain(`<a href="https://github.com/acme/app/pull/12">auth · PR #12</a> · checks failed: e2e`)
    expect(html).toContain("<h2>Done</h2>")
    expect(html).not.toContain("<script")
  })
})

describe("one set of signs", () => {
  test("a tab's title carries its state after its thread's colour; red is never a thread's", async () => {
    const S = await import("../src/terminal/status.ts")
    const pure = await import("../src/ui-extra/pure.ts")
    expect(pure.DOTS).not.toContain("🔴")
    expect(S.signed("🟣 auth · auth-1", "waiting")).toBe("🟣❓ auth · auth-1")
    expect(S.signed("🟣❓ auth · auth-1", "working")).toBe("🟣⏳ auth · auth-1")
    expect(S.signed("🟣⏳ auth · auth-1", "broken")).toBe("🟣❗ auth · auth-1")
    expect(S.signed("🟣✅ auth · auth-1", "off")).toBe("🟣 auth · auth-1")
    expect(S.signed("bg", "done")).toBe("✅ bg")
  })
  test("the bell rings once when a session turns to needing you, and the tab title follows its state", async () => {
    const S = await import("../src/terminal/status.ts")
    const ran: string[] = []
    const tty: string[] = []
    const sys = { platform: "darwin" as const, run: (s: any) => (ran.push(s.input ?? ""), { ok: true, out: "done" }), writeTty: (_p: string, d: string) => (tty.push(d), true), term: () => ({ program: "Apple_Terminal", tty: "/dev/ttys7" }) }
    S.applyOnce("x", "waiting", { sessionId: "x", want: "waiting", wantAt: 0, applied: "working", title: "🟣 auth · x" }, sys)
    expect(tty).toContain("\x07")
    expect(ran.some((r) => r.includes(`set custom title of t to "🟣❓ auth · x"`))).toBe(true)
    tty.length = 0
    S.applyOnce("x", "waiting", { sessionId: "x", want: "waiting", wantAt: 0, applied: "waiting", title: "🟣 auth · x" }, sys)
    expect(tty).not.toContain("\x07") // still waiting: not again
  })
})
