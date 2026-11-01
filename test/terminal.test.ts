// The terminal workspace, without a terminal: exactly what each terminal is
// told for each state, the throttle, where new agents' worktrees go and what
// they share, which window a new tab goes into, and which worktrees cleanup
// may remove.
//
//   bun test test/terminal.test.ts
//
// The whole path with real git, tmux and hooks is test/terminal.sh.

import { describe, expect, test } from "bun:test"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"

process.env.CROSSTALK_HOME = fs.mkdtempSync(path.join(os.tmpdir(), "ct-terminal-unit-"))
process.env.CROSSTALK_TAB_GAP_MS = "100"
const S = await import("../src/terminal/status.ts")
const L = await import("../src/terminal/layout.ts")
const R = await import("../src/restore.ts")
const SP = await import("../src/spawn.ts")
const C = await import("../src/cleanup.ts")
const RP = await import("../src/terminal/repo.ts")
type Rec = import("../src/restore.ts").Rec
type Env = import("../src/restore.ts").Env
type Term = import("../src/restore.ts").Term

const ESC = "\x1b"

describe("which state", () => {
  test("from the classic hooks", () => {
    expect(S.stateForEvent({ event: "UserPromptSubmit", pending: 3 })).toBe("working")
    expect(S.stateForEvent({ event: "Stop", pending: 0 })).toBe("done")
    expect(S.stateForEvent({ event: "Stop", pending: 1 })).toBe("waiting")
    expect(S.stateForEvent({ event: "Notification", pending: 0, notificationType: "permission_prompt" })).toBe("waiting")
    expect(S.stateForEvent({ event: "Notification", pending: 0, message: "Claude needs your permission to use Bash" })).toBe("waiting")
    expect(S.stateForEvent({ event: "SessionEnd", pending: 0 })).toBe("off")
    expect(S.stateForEvent({ event: "SessionStart", pending: 0 })).toBe(null)
  })
  test("the idle reminder changes nothing, unless something is pending", () => {
    expect(S.stateForEvent({ event: "Notification", pending: 0, notificationType: "idle_prompt", current: "done" })).toBe(null)
    expect(S.stateForEvent({ event: "Notification", pending: 2, notificationType: "idle_prompt", current: "done" })).toBe("waiting")
  })
  test("a tool runs after the permission prompt: working again; otherwise a tool call changes nothing", () => {
    expect(S.stateForEvent({ event: "PostToolUse", pending: 0, current: "waiting" })).toBe("working")
    expect(S.stateForEvent({ event: "PostToolUse", pending: 0, current: "working" })).toBe(null)
  })
  test("from the registry and the pending items, for the mod's refresh", () => {
    expect(S.stateFromRegistry({ status: "busy", pending: 0 })).toBe("working")
    expect(S.stateFromRegistry({ status: "waiting", pending: 0 })).toBe("waiting")
    expect(S.stateFromRegistry({ status: "idle", pending: 1, current: "done" })).toBe("waiting")
    expect(S.stateFromRegistry({ status: "idle", pending: 0, current: "waiting" })).toBe("done")
    expect(S.stateFromRegistry({ status: "idle", pending: 0, current: "working" })).toBe("done")
    expect(S.stateFromRegistry({ status: "idle", pending: 0, current: "done" })).toBe(null)
  })
})

describe("what each terminal is told", () => {
  test("OSC 9;4 through the hook, only to terminals that draw it", () => {
    expect(S.progressSequence("working")).toBe(`${ESC}]9;4;3${ESC}\\`)
    expect(S.progressSequence("waiting")).toBe(`${ESC}]9;4;4;100${ESC}\\`)
    expect(S.progressSequence("done")).toBe(`${ESC}]9;4;0${ESC}\\`)
    expect(S.drawsProgress({ TERM_PROGRAM: "ghostty" })).toBe(true)
    expect(S.drawsProgress({ TERM_PROGRAM: "WezTerm" })).toBe(true)
    expect(S.drawsProgress({ TMUX: "/tmp/x,1,0" })).toBe(true)
    expect(S.drawsProgress({ TERM_PROGRAM: "iTerm.app", TERM_PROGRAM_VERSION: "3.6.1" })).toBe(true)
    expect(S.drawsProgress({ TERM_PROGRAM: "iTerm.app", TERM_PROGRAM_VERSION: "3.5.4" })).toBe(false)
    expect(S.drawsProgress({ TERM_PROGRAM: "Apple_Terminal" })).toBe(false)
    expect(S.drawsProgress({ KITTY_WINDOW_ID: "1" })).toBe(false)
  })
  test("tmux: one window option on the pane's window, and a redraw that may fail", () => {
    const t = { pane: "%7", socket: "/tmp/tmux-0/default" }
    expect(S.tmuxActions(t, "waiting")).toEqual([
      { kind: "run", step: { cmd: "tmux", args: ["-S", "/tmp/tmux-0/default", "set-option", "-w", "-t", "%7", "@crosstalk_state", "waiting"] } },
      { kind: "run", step: { cmd: "tmux", args: ["-S", "/tmp/tmux-0/default", "refresh-client", "-S"] }, optional: true },
    ])
    expect(S.tmuxActions({ pane: "%7" }, "off")[0]).toEqual({ kind: "run", step: { cmd: "tmux", args: ["set-option", "-w", "-u", "-t", "%7", "@crosstalk_state"] } })
  })
  test("iTerm2: OSC 6 tab colour, channel by channel, and a user var, written to the tty", () => {
    const [a] = S.actionsFor({ program: "iTerm.app", tty: "/dev/ttys004", iterm: { id: "w0t1p0:x" } }, "working")
    expect(a).toEqual({
      kind: "tty",
      path: "/dev/ttys004",
      data: `${ESC}]6;1;bg;red;brightness;47\x07${ESC}]6;1;bg;green;brightness;111\x07${ESC}]6;1;bg;blue;brightness;214\x07${ESC}]1337;SetUserVar=crosstalk_state=d29ya2luZw==\x07`,
    })
    expect(S.itermTabColour("off")).toBe(`${ESC}]6;1;bg;*;default\x07`)
    expect(S.userVar("off")).toBe(`${ESC}]1337;SetUserVar=crosstalk_state=\x07`)
  })
  test("kitty: set-tab-color on the tab holding its window, and a user var", () => {
    expect(S.actionsFor({ kitty: { window: "3", listenOn: "unix:/tmp/kitty" } }, "waiting")).toEqual([
      { kind: "run", step: { cmd: "kitten", args: ["@", "--to", "unix:/tmp/kitty", "set-tab-color", "--match", "window_id:3", "active_bg=#e58c0a", "inactive_bg=#e58c0a"] } },
      { kind: "run", step: { cmd: "kitten", args: ["@", "--to", "unix:/tmp/kitty", "set-user-vars", "--match", "id:3", "crosstalk_state=waiting"] }, optional: true },
    ])
    expect(S.kittyActions({ window: "3", listenOn: "unix:/tmp/kitty" }, "off")[0].kind === "run" && (S.kittyActions({ window: "3", listenOn: "unix:/tmp/kitty" }, "off")[0] as any).step.args.slice(-2)).toEqual(["active_bg=NONE", "inactive_bg=NONE"])
    expect(S.actionsFor({ kitty: { window: "3" } }, "working")).toEqual([]) // no remote control: nothing
  })
  test("WezTerm: only the user var, for a format-tab-title handler", () => {
    expect(S.actionsFor({ program: "WezTerm", tty: "/dev/pts/3", wezterm: { pane: "1" } }, "done")).toEqual([
      { kind: "tty", path: "/dev/pts/3", data: `${ESC}]1337;SetUserVar=crosstalk_state=ZG9uZQ==\x07` },
    ])
  })
  test("inside tmux, only tmux: the outer tab belongs to every window in it", () => {
    const t: Term = { program: "iTerm.app", tty: "/dev/ttys1", tmux: { pane: "%1" }, iterm: { id: "w0t0p0:x" } }
    expect(S.actionsFor(t, "working").every((a) => a.kind === "run" && a.step.cmd === "tmux")).toBe(true)
  })
  test("Terminal.app: AppleScript on the tab with its tty, only on a Mac, never launching Terminal", () => {
    expect(S.actionsFor({ program: "Apple_Terminal", tty: "/dev/ttys003" }, "working", "darwin")).toEqual([{ kind: "apple", tty: "/dev/ttys003" }])
    expect(S.actionsFor({ program: "Apple_Terminal", tty: "/dev/ttys003" }, "working", "linux")).toEqual([])
    expect(S.appleSetBgScript("/dev/ttys003", [1000, 2000, 3000])).toBe(
      [
        `if application "Terminal" is running then`,
        `\ttell application "Terminal"`,
        `\t\trepeat with w in windows`,
        `\t\t\trepeat with t in tabs of w`,
        `\t\t\t\tif (tty of t) is "/dev/ttys003" then`,
        `\t\t\t\t\tset background color of t to {1000, 2000, 3000}`,
        `\t\t\t\t\treturn "done"`,
        `\t\t\t\tend if`,
        `\t\t\tend repeat`,
        `\t\tend repeat`,
        `\tend tell`,
        `end if`,
        `return ""`,
      ].join("\n"),
    )
    expect(S.appleReadBgScript(`/dev/"x`)).toContain(`if (tty of t) is "/dev/\\"x" then`)
    expect(S.appleReadBgScript("/dev/ttys003")).toContain(`return ((item 1 of c) as text) & "," & ((item 2 of c) as text) & "," & ((item 3 of c) as text)`)
  })
  test("Terminal.app tints from the original, and done and off put it back", () => {
    const black: [number, number, number] = [0, 0, 0]
    expect(S.appleTint(black, "working")).toEqual([3020, 7132, 13750])
    expect(S.appleTint(black, "done")).toEqual(black)
    expect(S.appleTint([65535, 65535, 65535], "off")).toEqual([65535, 65535, 65535])
    expect(S.parseRgb16("65535,0,12\n")).toEqual([65535, 0, 12])
    expect(S.parseRgb16("")).toBe(null)
  })
  test("the tmux snippet appends to the person's format, never sets status-format", () => {
    expect(S.TMUX_SNIPPET).toContain("set -ga window-status-format")
    expect(S.TMUX_SNIPPET).not.toMatch(/set -g status/)
  })
})

describe("the throttle", () => {
  const f = (o: Partial<import("../src/terminal/status.ts").TabFile>) => ({ sessionId: "s", want: "working" as const, wantAt: 0, ...o })
  test("apply, wait out the gap, or stop", () => {
    expect(S.decide(null, 1000, 500)).toEqual({ act: "idle" })
    expect(S.decide(f({ applied: "working" }), 1000, 500)).toEqual({ act: "idle" })
    expect(S.decide(f({ applied: "done", appliedAt: 800 }), 1000, 500)).toEqual({ act: "wait", ms: 300 })
    expect(S.decide(f({ applied: "done", appliedAt: 400 }), 1000, 500)).toEqual({ act: "apply" })
    expect(S.decide(f({}), 1000, 500)).toEqual({ act: "apply" })
  })
  test("asking for the state already wanted writes nothing and starts nothing", () => {
    expect(S.want({ sessionId: "dup", state: "off", root: "/nowhere" })).toBe(false) // nothing shown, nothing to clear
    process.env.CROSSTALK_TERM_SYNC = "1"
    expect(S.want({ sessionId: "dup", state: "working", root: "/nowhere" })).toBe(true)
    expect(S.want({ sessionId: "dup", state: "working", root: "/nowhere" })).toBe(false)
    delete process.env.CROSSTALK_TERM_SYNC
  })
  test("of quick changes, the last lands, at most once per gap; Terminal.app's own colour is kept and put back", async () => {
    const tab = path.join(process.env.CROSSTALK_HOME!, "tabs")
    fs.mkdirSync(tab, { recursive: true })
    const wantNow = (want: string) => fs.writeFileSync(path.join(tab, "mac.json"), JSON.stringify({ ...(S.readTab("mac") ?? { sessionId: "mac" }), want, wantAt: Date.now() }))
    const ran: { cmd: string; input?: string }[] = []
    const sys: import("../src/terminal/status.ts").Sys = {
      platform: "darwin",
      run: (s) => {
        ran.push({ cmd: s.cmd, input: s.input })
        // While the first colour is being set, the session moves on to waiting.
        if (s.input?.includes("set background color") && ran.filter((r) => r.input?.includes("set background")).length === 1) wantNow("waiting")
        return { ok: true, out: s.input?.includes("item 1 of c") ? "100,200,300" : "done" }
      },
      writeTty: () => true,
      term: () => ({ program: "Apple_Terminal", tty: "/dev/ttys009" }),
    }
    wantNow("working")
    let slept = 0
    await S.applyLoop("mac", sys, async (ms) => {
      slept += ms
      // ...and, inside the gap, to done: waiting is never drawn.
      wantNow("done")
      await new Promise((r) => setTimeout(r, ms))
    })
    const sets = ran.filter((r) => r.input?.includes("set background color"))
    expect(ran[0].input).toContain("item 1 of c") // read the original first
    expect(sets).toHaveLength(2)
    expect(sets[0].input).toContain("{3095, 7282, 13975}") // working, tinted from 100,200,300
    expect(sets[1].input).toContain("{100, 200, 300}") // done: the original back
    expect(S.readTab("mac")!.applied).toBe("done")
    expect(S.readTab("mac")!.appleOriginal).toBe("100,200,300")
    expect(slept).toBeGreaterThan(0)
    expect(slept).toBeLessThanOrEqual(100)
  })
})

// --- layout ------------------------------------------------------------------------

const env = (o: Partial<Env> = {}): Env => ({
  platform: "linux",
  current: {},
  has: () => true,
  which: () => undefined,
  tmuxHasSession: () => true,
  tabs: true,
  ...o,
})
const rec = (o: Partial<Rec>): Rec => ({ sessionId: "s", cwd: "/w/app", client: "claude", pid: 1, startedAt: 1, seenAt: 1, terminal: {}, ...o })

describe("one window per repository", () => {
  const tab = { cwd: "/r/wt/auth-1", argv: ["claude", "fix the 'auth' bug"] }
  test("tmux: a new window in the tmux session holding the repo, without taking focus", () => {
    const anchor: Term = { tmux: { pane: "%1", socket: "/tmp/s", session: "work" } }
    expect(L.openTabs([tab, { ...tab, cwd: "/r/wt/auth-2" }], { anchor, current: anchor, env: env(), repo: "/r/app" }).steps).toEqual([
      { cmd: "tmux", args: ["-S", "/tmp/s", "new-window", "-d", "-t", "=work:", "-c", "/r/wt/auth-1", `claude 'fix the '\\''auth'\\'' bug'`] },
      { cmd: "tmux", args: ["-S", "/tmp/s", "new-window", "-d", "-t", "=work:", "-c", "/r/wt/auth-2", `claude 'fix the '\\''auth'\\'' bug'`] },
    ])
  })
  test("tmux: no session holds the repo, so a detached one named after it", () => {
    const o = L.openTabs([tab, tab], { anchor: null, current: { tmux: { pane: "%1", session: "other" } }, env: env(), repo: "/r/My App", tmuxSession: () => false })
    expect(o.steps.map((s) => s.args.slice(0, 5))).toEqual([
      ["new-session", "-d", "-s", "my-app", "-c"],
      ["new-window", "-d", "-t", "=my-app:", "-c"],
    ])
  })
  test("Terminal.app: into the window holding the repo, by its id; Cmd-T for each", () => {
    const o = L.openTabs([tab], { anchor: { program: "Apple_Terminal", apple: { window: 42, tab: 2 } }, current: {}, env: env({ platform: "darwin" }), repo: "/r/app" })
    expect(o.kind).toBe("apple")
    expect(o.needsAccessibility).toBe(true)
    const s = o.steps[0].input!
    expect(s).toContain(`\tif not (exists window id 42) then`)
    expect(s).toContain(`\t\tset index of window id 42 to 1`)
    expect(s).toContain(`\t\ttell application "System Events" to keystroke "t" using command down`)
    expect(s).toContain(`\t\ttell application "Terminal" to do script "cd /r/wt/auth-1 && claude 'fix the '\\\\''auth'\\\\'' bug'" in selected tab of front window`)
  })
  test("Terminal.app with no window for the repo: a new window, the rest as its tabs", () => {
    const o = L.openTabs([tab, tab], { anchor: null, current: { program: "Apple_Terminal" }, env: env({ platform: "darwin" }), repo: "/r/app" })
    expect(o.steps[0].input).toBe(R.appleTerminalScript([L.typedTab(tab), L.typedTab(tab)], true))
  })
  test("iTerm2: a tab in the window showing a session of the repo", () => {
    const o = L.openTabs([tab], { anchor: { program: "iTerm.app", tty: "/dev/ttys7", iterm: { id: "w1t0p0:x" } }, current: {}, env: env({ platform: "darwin" }), repo: "/r/app" })
    expect(o.steps[0].input).toContain(`\t\t\t\tif (tty of s) is "/dev/ttys7" then set w to aw`)
    expect(o.steps[0].input).toContain(`\t\t\tset t to (create tab with default profile)`)
  })
  test("kitty and WezTerm: next to a window or pane of the repo", () => {
    expect(L.openTabs([tab], { anchor: { kitty: { window: "9", listenOn: "unix:/k" } }, current: {}, env: env(), repo: "/r" }).steps[0].args).toEqual([
      "@", "--to", "unix:/k", "launch", "--type=tab", "--match", "window_id:9", "--cwd", "/r/wt/auth-1", "claude", "fix the 'auth' bug",
    ])
    expect(L.openTabs([tab], { anchor: { wezterm: { pane: "5" } }, current: {}, env: env(), repo: "/r" }).steps[0].args).toEqual([
      "cli", "spawn", "--pane-id", "5", "--cwd", "/r/wt/auth-1", "--", "claude", "fix the 'auth' bug",
    ])
    expect(L.openTabs([tab], { anchor: null, current: { wezterm: { pane: "5" } }, env: env(), repo: "/r" }).steps[0].args.slice(0, 3)).toEqual(["cli", "spawn", "--new-window"])
  })
  test("a terminal nothing can drive: the commands to paste", () => {
    const o = L.openTabs([tab], { anchor: null, current: { program: "xterm" }, env: env(), repo: "/r" })
    expect(o.kind).toBe("manual")
    expect(o.typed).toEqual([`cd /r/wt/auth-1 && claude 'fix the '\\''auth'\\'' bug'`])
  })
  test("the anchor: the asking session in that repo, else the latest live one in it", () => {
    const keyOf = (cwd: string) => (cwd.startsWith("/r/") ? "/r" : cwd)
    const a = rec({ sessionId: "a", cwd: "/r/app", seenAt: 5, terminal: { wezterm: { pane: "1" } } })
    const b = rec({ sessionId: "b", cwd: "/r/wt/x", seenAt: 9, terminal: { wezterm: { pane: "2" } } })
    const gone = rec({ sessionId: "c", cwd: "/r/app", seenAt: 20, terminal: { wezterm: { pane: "3" } }, endedAt: 21 })
    const bg = rec({ sessionId: "d", cwd: "/r/app", seenAt: 30, terminal: { tmux: { pane: "%1", socket: "/tmp/tmux-0/crosstalk" } } })
    const all = [a, b, gone, bg]
    expect(L.anchorFor("/r", { recs: all, keyOf, alive: () => true })).toEqual(b.terminal)
    expect(L.anchorFor("/r", { recs: all, keyOf, alive: () => true, asking: { cwd: "/r/app", terminal: { kitty: { window: "1" } } } })).toEqual({ kitty: { window: "1" } })
    expect(L.anchorFor("/r", { recs: all, keyOf, alive: () => true, asking: { cwd: "/elsewhere", terminal: { kitty: { window: "1" } } } })).toEqual(b.terminal)
    expect(L.anchorFor("/other", { recs: all, keyOf, alive: () => true })).toBe(null)
  })
})

describe("restore, grouped by repository", () => {
  const at = (window: number, tab: number) => ({ program: "Apple_Terminal", apple: { window, tab } })
  const repoOf = (cwd: string) => (cwd.startsWith("/api") ? "/api" : "/web")
  test("one window per repository, repositories in the order first opened, tabs in their old order", () => {
    const rs = [
      rec({ sessionId: "w2", cwd: "/web/b", startedAt: 4, terminal: at(1, 2) }),
      rec({ sessionId: "a1", cwd: "/api", startedAt: 2, terminal: at(1, 1) }),
      rec({ sessionId: "w1", cwd: "/web/a", startedAt: 1, terminal: at(2, 1) }),
      rec({ sessionId: "a2", cwd: "/api/wt/x", startedAt: 3, terminal: at(2, 2) }),
    ]
    const { plans } = R.plan(rs, env({ platform: "darwin", repoOf }))
    expect(plans.map((p) => p.sessions.map((s) => s.sessionId))).toEqual([
      ["w2", "w1"],
      ["a1", "a2"],
    ])
    expect(plans.every((p) => p.kind === "apple" && p.steps.length === 1)).toBe(true)
  })
  test("a repository with a window open already: its sessions go back into it", () => {
    const rs = [rec({ sessionId: "a1", cwd: "/api", terminal: at(3, 1) })]
    const { plans } = R.plan(rs, env({ platform: "darwin", repoOf, anchorFor: (repo) => (repo === "/api" ? at(77, 1) : null) }))
    expect(plans[0].needsAccessibility).toBe(true)
    expect(plans[0].steps[0].input).toContain("set index of window id 77 to 1")
  })
  test("without repoOf, by old window as before", () => {
    const rs = [rec({ sessionId: "x", cwd: "/api", terminal: at(2, 1) }), rec({ sessionId: "y", cwd: "/api", terminal: at(1, 1) })]
    expect(R.plan(rs, env({ platform: "darwin" })).plans.map((p) => p.sessions[0].sessionId)).toEqual(["y", "x"])
  })
  test("an agent crosstalk ran in the background goes back to crosstalk's tmux", () => {
    const r = rec({ sessionId: "bg", cwd: "/api/wt/bg", terminal: { tmux: { pane: "%3", socket: "/tmp/tmux-501/crosstalk", session: "bg", window: 0 } } })
    const asked: [string, string | undefined][] = []
    const { plans } = R.plan([r], env({ tmuxHasSession: (n, s) => (asked.push([n, s]), false) }))
    expect(asked).toEqual([["bg", "crosstalk"]])
    expect(plans[0].steps).toEqual([{ cmd: "tmux", args: ["-L", "crosstalk", "new-session", "-d", "-s", "bg", "-c", "/api/wt/bg", "claude --resume bg"] }])
  })
})

// --- spawn -------------------------------------------------------------------------

describe("new agents: names, worktrees, shared dependencies", () => {
  test("a name from the task", () => {
    expect(SP.nameFromTask("put two more on auth")).toBe("auth")
    expect(SP.nameFromTask("Start an agent to fix the flaky login test")).toBe("fix-flaky")
    expect(SP.nameFromTask("!!!")).toBe("agent")
  })
  test("names nobody has", () => {
    const taken = new Set(["auth", "auth-2"])
    expect(SP.namesFor({ count: 1, task: "x", name: "auth", taken: (n) => taken.has(n) })).toEqual(["auth-3"])
    expect(SP.namesFor({ count: 2, task: "x", name: "auth", taken: (n) => taken.has(n) })).toEqual(["auth-1", "auth-3"])
    expect(SP.namesFor({ count: 1, task: "x", name: "Auth Tokens!", taken: () => false })).toEqual(["auth-tokens"])
  })
  test("worktrees go where the repo keeps them, else into crosstalk's home", () => {
    const main = "/code/app"
    expect(SP.worktreeHome({ main, worktrees: [{ path: main }], home: "/h" })).toBe("/h/worktrees/app")
    expect(SP.worktreeHome({ main, worktrees: [{ path: main }, { path: "/code/app/.claude/worktrees/x" }, { path: "/code/app/.claude/worktrees/y" }, { path: "/tmp/z" }], home: "/h" })).toBe("/code/app/.claude/worktrees")
    expect(SP.worktreeHome({ main, worktrees: [{ path: main }, { path: "/code/app-worktrees/feat" }], home: "/h" })).toBe("/code/app-worktrees")
    // A lone sibling of the checkout is not a convention to fill /code with.
    expect(SP.worktreeHome({ main, worktrees: [{ path: main }, { path: "/code/feature" }], home: "/h" })).toBe("/h/worktrees/app")
  })
  test("each plan: a branch, a worktree, the same subfolder, links to the main checkout's dependencies", () => {
    const exists = (p: string) => ["/code/app/node_modules", "/code/app/.venv"].includes(p)
    const plans = SP.planSpawn({
      count: 2,
      task: "do it",
      name: "auth",
      cwd: "/code/app/packages/web",
      top: "/code/app",
      worktrees: [{ path: "/code/app" }],
      home: "/h",
      claude: "/usr/bin/claude",
      exists,
      branchExists: (b) => b === "crosstalk/auth-1",
    })
    expect(plans.map((p) => [p.name, p.branch, p.worktree, p.cwd])).toEqual([
      ["auth-2", "crosstalk/auth-2", "/h/worktrees/app/auth-2", "/h/worktrees/app/auth-2/packages/web"],
      ["auth-3", "crosstalk/auth-3", "/h/worktrees/app/auth-3", "/h/worktrees/app/auth-3/packages/web"],
    ])
    expect(plans[0].links).toEqual([
      ["/code/app/node_modules", "/h/worktrees/app/auth-2/node_modules"],
      ["/code/app/.venv", "/h/worktrees/app/auth-2/.venv"],
    ])
    expect(plans[0].tab).toEqual({ cwd: "/h/worktrees/app/auth-2/packages/web", argv: ["/usr/bin/claude", "do it"], name: "auth-2" })
  })
  test("a spawn from a worktree shares the main checkout's dependencies, not the worktree's", () => {
    const plans = SP.planSpawn({ count: 1, task: "t", cwd: "/w/x", top: "/w/x", worktrees: [{ path: "/code/app" }, { path: "/w/x" }], home: "/h", claude: "claude", exists: (p) => p === "/code/app/node_modules", branchExists: () => false })
    expect(plans[0].links).toEqual([["/code/app/node_modules", path.join(plans[0].worktree, "node_modules")]])
  })
  test("at most eight at once", () => {
    expect(SP.planSpawn({ count: 50, task: "t", cwd: "/a", top: "/a", worktrees: [], home: "/h", claude: "claude", exists: () => false, branchExists: () => false })).toHaveLength(8)
  })
  test("background: a tmux session of its own in crosstalk's server; show attaches with the person's tmux variables unset", () => {
    const [p] = SP.planSpawn({ count: 1, task: "watch it", name: "bg", cwd: "/a", top: "/a", worktrees: [], home: "/h", claude: "claude", exists: () => false, branchExists: () => false })
    const [s] = SP.backgroundSteps(p)
    expect(s.args).toEqual(["-L", "crosstalk", "-f", SP.tmuxConf(), "new-session", "-d", "-s", "bg", "-c", "/h/worktrees/a/bg", "claude 'watch it'"])
    expect(SP.attachArgv("bg")).toEqual(["env", "-u", "TMUX", "-u", "TMUX_PANE", "tmux", "-L", "crosstalk", "attach-session", "-t", "=bg"])
    expect(SP.cleanEnv({ TMUX: "x", TMUX_PANE: "%1", PATH: "/bin" })).toEqual({ PATH: "/bin" })
  })
  test("worktree list, parsed", () => {
    expect(RP.parseWorktrees("worktree /a\nHEAD 1\nbranch refs/heads/main\n\nworktree /b\nHEAD 2\ndetached\n")).toEqual([
      { path: "/a", head: "1", branch: "main" },
      { path: "/b", head: "2", detached: true },
    ])
  })
})

// --- cleanup -----------------------------------------------------------------------

describe("cleanup: merged, ended and crosstalk's own", () => {
  const sp = (name: string, o: Partial<import("../src/spawn.ts").SpawnRec> = {}) => ({
    id: `app--${name}`,
    name,
    task: "t",
    repo: "/code/app",
    worktree: `/h/wt/${name}`,
    cwd: `/h/wt/${name}`,
    branch: `crosstalk/${name}`,
    base: "base",
    createdAt: 1,
    background: false,
    links: ["node_modules"],
    ...o,
  })
  const probe = (o: Partial<import("../src/cleanup.ts").Probe> = {}): import("../src/cleanup.ts").Probe => ({
    exists: () => true,
    clean: () => true,
    branchExists: (_r, b) => b !== "crosstalk/deleted",
    merged: (_r, b) => b === "crosstalk/merged" || b === "crosstalk/live",
    ended: (r) => r.name !== "live",
    ...o,
  })
  test("merged with its session ended, or its branch deleted; nothing unmerged, running, dirty or gone", () => {
    const recs = [sp("merged"), sp("open"), sp("live"), sp("deleted"), sp("done", { removedAt: 5 })]
    expect(C.select(recs, probe()).map((c) => [c.rec.name, c.why])).toEqual([
      ["merged", "merged"],
      ["deleted", "deleted"],
    ])
    expect(C.select(recs, probe({ clean: (w) => !w.endsWith("merged") })).map((c) => c.rec.name)).toEqual(["deleted"])
    expect(C.select(recs, probe({ exists: (p) => !p.endsWith("merged") })).map((c) => c.rec.name)).toEqual(["deleted"])
  })
  test("the base passed on: a branch with nothing of its own is not 'merged'", () => {
    const seen: (string | undefined)[] = []
    C.select([sp("merged", { base: "abc" })], probe({ merged: (_r, _b, base) => (seen.push(base), false) }))
    expect(seen).toEqual(["abc"])
  })
  test("offered once per worktree, in plain words", () => {
    const o = C.offerFor([{ rec: sp("auth-1"), why: "merged" }])!
    expect(o.question).toBe("1 agent worktree is done with: its work is merged and its session has ended. Remove it?")
    expect(o.text).toContain(`Say "clean up the worktrees"`)
    expect(C.offerFor([{ rec: sp("auth-1", { offeredAt: 1 }), why: "merged" }])).toBe(null)
  })
  test("sizes in words", () => {
    expect(C.human(512)).toBe("512 KB")
    expect(C.human(20 * 1024)).toBe("20 MB")
    expect(C.human(3 * 1024 * 1024)).toBe("3.0 GB")
  })
})
