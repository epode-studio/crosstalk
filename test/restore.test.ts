// Restore after a restart: which sessions count as lost, and exactly what each
// terminal is told to run.
//
//   bun test test/restore.test.ts
//
// The whole path through the hook, with real tmux, is test/restore.sh. The
// macOS adapters cannot run here, so their AppleScript is checked as text.

import { describe, expect, test } from "bun:test"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"

process.env.CROSSTALK_HOME = fs.mkdtempSync(path.join(os.tmpdir(), "ct-restore-unit-"))
const R = await import("../src/restore.ts")
type Rec = import("../src/restore.ts").Rec
type Env = import("../src/restore.ts").Env

const H = 60 * 60 * 1000
const NOW = 1_800_000_000_000
const BOOT = NOW - 5 * 60 * 1000 // booted five minutes ago

let n = 0
const rec = (o: Partial<Rec> = {}): Rec => ({
  sessionId: o.sessionId ?? `s${++n}`,
  cwd: "/work/api",
  client: "claude",
  pid: 4242,
  startedAt: BOOT - 2 * H + n,
  seenAt: BOOT - 10 * 60 * 1000,
  terminal: {},
  ...o,
})
const ctx = (all: Rec[], alive: (r: Rec) => boolean = () => false) => ({ now: NOW, boot: BOOT, all, alive })
const lost = (r: Rec, all: Rec[] = [r], alive?: (r: Rec) => boolean) => R.isLost(r, ctx(all, alive))

describe("detection", () => {
  test("open before the restart and gone: lost", () => {
    expect(lost(rec())).toBe(true)
  })

  test("ended at the prompt, by /clear or by logout: not lost", () => {
    for (const reason of ["prompt_input_exit", "clear", "logout"])
      expect(lost(rec({ endedAt: BOOT - 3 * H, endReason: reason }))).toBe(false)
  })

  test("one session ending for another reason is one tab closed: not lost", () => {
    expect(lost(rec({ endedAt: BOOT - 3 * H, endReason: "other" }))).toBe(false)
  })

  test("several ending together went down with their terminal: lost", () => {
    const t = NOW - 30 * 60 * 1000
    const a = rec({ endedAt: t, endReason: "other", seenAt: t })
    const b = rec({ endedAt: t + 2000, endReason: "other", seenAt: t })
    expect(lost(a, [a, b])).toBe(true)
    expect(lost(b, [a, b])).toBe(true)
  })

  test("ending in the minutes before the boot was the shutdown: lost", () => {
    expect(lost(rec({ endedAt: BOOT - 60 * 1000, endReason: "other" }))).toBe(true)
  })

  test("process still alive: not lost", () => {
    expect(lost(rec({ seenAt: NOW - 1000 }), undefined, () => true)).toBe(false)
  })

  test("within this boot, a process gone with no SessionEnd was cut off: lost", () => {
    expect(lost(rec({ seenAt: NOW - 60 * 1000, startedAt: BOOT + 1000 }))).toBe(true)
  })

  test("within this boot, Codex cannot say it ended, so it is not offered", () => {
    expect(lost(rec({ client: "codex", seenAt: NOW - 60 * 1000 }))).toBe(false)
    expect(lost(rec({ client: "codex" }))).toBe(true) // across a restart it is
  })

  test("the 24 hour window, before the boot", () => {
    expect(lost(rec({ seenAt: BOOT - 23 * H }))).toBe(true)
    expect(lost(rec({ seenAt: BOOT - 25 * H }))).toBe(false)
  })

  test("the 24 hour window, within this boot", () => {
    const now = BOOT + 48 * H
    const r = rec({ seenAt: now - 25 * H })
    expect(R.isLost(r, { now, boot: BOOT, all: [r], alive: () => false })).toBe(false)
    const s = rec({ seenAt: now - 23 * H })
    expect(R.isLost(s, { now, boot: BOOT, all: [s], alive: () => false })).toBe(true)
  })

  test("claude -p has no tab to come back to", () => {
    expect(lost(rec({ interactive: false }))).toBe(false)
  })

  test("the asking session is never in the list, and the list is in opening order", () => {
    const a = rec({ sessionId: "a", startedAt: 3 })
    const b = rec({ sessionId: "b", startedAt: 1 })
    const me = rec({ sessionId: "me", startedAt: 2 })
    expect(R.lostSessions(ctx([a, b, me]), "me").map((r) => r.sessionId)).toEqual(["b", "a"])
  })

  test("a pid reused by another process is not the session", () => {
    expect(R.pidAlive(process.pid)).toBe(true)
    expect(R.pidAlive(process.pid, "Thu Jan  1 00:00:00 1970")).toBe(false)
    expect(R.pidAlive(2 ** 22 + 12345)).toBe(false)
  })

  test("boot time can be faked for tests", () => {
    expect(R.bootTime({ CROSSTALK_BOOT_TIME: "1234" } as any)).toBe(1234)
    const b = R.bootTime({} as any, Date.now())
    expect(Math.abs(b - (Date.now() - os.uptime() * 1000))).toBeLessThan(2000)
  })
})

describe("quoting", () => {
  test("shell words", () => {
    expect(R.shq("/work/api")).toBe("/work/api")
    expect(R.shq("/Users/p/My Projects")).toBe("'/Users/p/My Projects'")
    expect(R.shq(`/tmp/it's "x"`)).toBe(`'/tmp/it'\\''s "x"'`)
    expect(R.shq("$(rm -rf ~)")).toBe("'$(rm -rf ~)'")
  })
  test("AppleScript strings", () => {
    expect(R.asq(`cd '/a b' && echo "hi" \\ x`)).toBe(`"cd '/a b' && echo \\"hi\\" \\\\ x"`)
  })
  test("what a person would type", () => {
    expect(R.typed(rec({ sessionId: "abc-1", cwd: `/Users/p/Paul's "stuff"` }))).toBe(
      `cd '/Users/p/Paul'\\''s "stuff"' && claude --resume abc-1`,
    )
    expect(R.typed(rec({ sessionId: "t1", client: "codex", cwd: "/w" }))).toBe(`cd /w && codex resume t1`)
  })
})

const env = (o: Partial<Env> = {}): Env => ({
  platform: "linux",
  current: {},
  has: () => true,
  which: () => undefined,
  tmuxHasSession: () => true,
  tabs: true,
  ...o,
})

describe("tmux", () => {
  const t = (session: string, window: number) => ({ tmux: { pane: "%1", session, window } })
  test("windows in their old order, quoted, in each folder", () => {
    const a = rec({ sessionId: "a", cwd: "/w/my api", terminal: t("work", 3), startedAt: 1 })
    const b = rec({ sessionId: "b", cwd: `/w/it's`, terminal: t("work", 1), startedAt: 2 })
    const { plans } = R.plan([a, b], env())
    expect(plans).toHaveLength(1)
    expect(plans[0].steps).toEqual([
      { cmd: "tmux", args: ["new-window", "-d", "-t", "=work:", "-c", `/w/it's`, "claude --resume b"] },
      { cmd: "tmux", args: ["new-window", "-d", "-t", "=work:", "-c", "/w/my api", "claude --resume a"] },
    ])
  })
  test("a tmux session that no longer exists is created first", () => {
    const a = rec({ sessionId: "a", terminal: t("gone", 0) })
    const b = rec({ sessionId: "b", terminal: t("gone", 1) })
    const { plans } = R.plan([a, b], env({ tmuxHasSession: () => false, which: (b) => `/opt/bin/${b}` }))
    expect(plans[0].steps.map((s) => s.args.slice(0, 4))).toEqual([
      ["new-session", "-d", "-s", "gone"],
      ["new-window", "-d", "-t", "=gone:"],
    ])
    expect(plans[0].steps[0].args.at(-1)).toBe("/opt/bin/claude --resume a")
  })
  test("no tmux here: the asking session's terminal takes it", () => {
    const a = rec({ terminal: t("work", 0) })
    const { plans } = R.plan([a], env({ has: (b) => b !== "tmux", current: { wezterm: { pane: "1" } } }))
    expect(plans[0].kind).toBe("wezterm")
  })
})

describe("Terminal.app", () => {
  const mac = env({ platform: "darwin", current: { program: "Apple_Terminal" } })
  const at = (window: number, tab: number) => ({ program: "Apple_Terminal", apple: { window, tab } })

  test("one window for all of them, never a window per repository: grouped by repository, tabs in their old order", () => {
    const rs = [
      rec({ sessionId: "w9t1", cwd: "/w/fw", terminal: at(9, 1) }),
      rec({ sessionId: "w4t2", cwd: "/w/My App", terminal: at(4, 2) }),
      rec({ sessionId: "w4t1", cwd: "/w/api", terminal: at(4, 1) }),
    ]
    const { plans } = R.plan(rs, mac)
    expect(plans.map((p) => p.sessions.map((r) => r.sessionId))).toEqual([["w4t1", "w4t2", "w9t1"]])
    expect(plans.map((p) => p.needsAccessibility)).toEqual([true])
    expect(plans[0].steps[0].cmd).toBe("osascript")
    expect(plans[0].steps[0].args).toEqual(["-"])
    // Asked from a Terminal window: into that one.
    const { plans: into } = R.plan(rs, { ...mac, current: { program: "Apple_Terminal", apple: { window: 77, tab: 1 } } })
    expect(into).toHaveLength(1)
    expect(into[0].steps[0].input).toContain("exists window id 77")
  })

  test("the script, exactly: a tab that will not open stops the rest, never a window each", () => {
    expect(R.appleTerminalScript([`cd /w/api && claude --resume a`, `cd '/w/My "App"' && claude --resume b`], true)).toBe(
      [
        `set crosstalkFallback to ""`,
        `set crosstalkOpened to 1`,
        `tell application "Terminal"`,
        `\tactivate`,
        `\tdo script "cd /w/api && claude --resume a"`,
        `end tell`,
        `if crosstalkFallback is "" then`,
        `\ttry`,
        ...R.appleNewTabLines(`cd '/w/My "App"' && claude --resume b`),
        `\t\tset crosstalkOpened to crosstalkOpened + 1`,
        `\ton error errMsg number errNum`,
        `\t\tset crosstalkFallback to (errNum as text)`,
        `\tend try`,
        `end if`,
        `return "done " & crosstalkFallback & " " & crosstalkOpened`,
      ].join("\n"),
    )
  })

  test("without tabs (asked for windows), one window per session and no System Events", () => {
    const s = R.appleTerminalScript(["cd /a && claude --resume a", "cd /b && claude --resume b"], false)
    expect(s).toBe(
      [
        `set crosstalkFallback to ""`,
        `set crosstalkOpened to 1`,
        `tell application "Terminal"`,
        `\tactivate`,
        `\tdo script "cd /a && claude --resume a"`,
        `end tell`,
        `tell application "Terminal" to do script "cd /b && claude --resume b"`,
        `set crosstalkOpened to crosstalkOpened + 1`,
        `return "done " & crosstalkFallback & " " & crosstalkOpened`,
      ].join("\n"),
    )
    const { plans } = R.plan([rec({ terminal: at(1, 1) }), rec({ terminal: at(1, 2) })], { ...mac, tabs: false })
    expect(plans[0].needsAccessibility).toBe(false)
    expect(plans[0].steps[0].input).not.toContain("System Events")
  })

  test("Terminal is brought to the front before Cmd-T, and the window it went into is not left for a new one", () => {
    const s = R.appleTerminalScript(["claude a", "claude b", "claude c"], true)
    const i = s.indexOf(`key code 17`)
    expect(s.slice(0, i)).toContain(`set frontmost of process "Terminal" to true`)
    expect(s.slice(0, i).indexOf("set frontmost")).toBeLessThan(s.slice(0, i).indexOf("if not frontmost then error"))
    expect(s.split("\n").filter((l) => l.includes("do script") && !l.includes("in selected tab")).length).toBe(1) // one window at most
    const into = R.appleIntoWindowScript(["claude a", "claude b"], 5, true)
    expect(into.split("\n").filter((l) => l.includes("do script") && !l.includes("in selected tab")).length).toBe(1) // only when window 5 is gone
  })

  test("the script that finds a session's window and tab", () => {
    expect(R.appleLocateScript("/dev/ttys003")).toContain(`if (tty of t) is "/dev/ttys003" then return ((id of w) as text) & " " & (n as text)`)
  })

  test("not on a Mac: the commands are handed over instead", () => {
    const { plans } = R.plan([rec({ terminal: at(1, 1) })], env())
    expect(plans[0].kind).toBe("manual")
  })
})

describe("other terminals", () => {
  test("iTerm2: window by window, tabs through its own scripting", () => {
    const rs = [
      rec({ sessionId: "b", terminal: { program: "iTerm.app", iterm: { id: "w0t1p0:x", window: 0, tab: 1 } } }),
      rec({ sessionId: "a", terminal: { program: "iTerm.app", iterm: { id: "w0t0p0:y", window: 0, tab: 0 } } }),
    ]
    const { plans } = R.plan(rs, env({ platform: "darwin" }))
    expect(plans[0].sessions.map((r) => r.sessionId)).toEqual(["a", "b"])
    expect(plans[0].steps[0].input).toBe(
      [
        `tell application "iTerm2"`,
        `\tactivate`,
        `\tset w to (create window with default profile)`,
        `\ttell current session of w to write text "cd /work/api && claude --resume a"`,
        `\ttell w`,
        `\t\tset t to (create tab with default profile)`,
        `\t\ttell current session of t to write text "cd /work/api && claude --resume b"`,
        `\tend tell`,
        `end tell`,
        `return "done "`,
      ].join("\n"),
    )
  })

  test("Ghostty types the command, and needs Accessibility", () => {
    const { plans } = R.plan([rec({ cwd: `/a "b"`, terminal: { program: "ghostty" } })], env({ platform: "darwin" }))
    expect(plans[0].needsAccessibility).toBe(true)
    expect(plans[0].steps[0].input).toContain(`keystroke "cd '/a \\"b\\"' && claude --resume`)
  })

  test("kitty, through remote control", () => {
    const r = rec({ sessionId: "k", cwd: "/w/a b", terminal: { kitty: { window: "1", listenOn: "unix:/tmp/kitty-1" } } })
    const { plans } = R.plan([r], env({ current: { kitty: { listenOn: "unix:/tmp/kitty-2" } } }))
    expect(plans[0].steps).toEqual([
      { cmd: "kitten", args: ["@", "--to", "unix:/tmp/kitty-2", "launch", "--type=tab", "--cwd", "/w/a b", "claude", "--resume", "k"] },
    ])
  })

  test("kitty without remote control falls back", () => {
    const r = rec({ terminal: { kitty: { window: "1" } } })
    expect(R.plan([r], env()).plans[0].kind).toBe("manual")
  })

  test("WezTerm", () => {
    const r = rec({ sessionId: "w", cwd: "/w/x y", terminal: { wezterm: { pane: "3" } } })
    expect(R.plan([r], env()).plans[0].steps).toEqual([
      { cmd: "wezterm", args: ["cli", "spawn", "--cwd", "/w/x y", "--", "claude", "--resume", "w"] },
    ])
  })

  test("Windows Terminal escapes its own separator", () => {
    const r = rec({ sessionId: "t", cwd: "C:\\w\\a;b", terminal: { wt: { session: "g" } } })
    expect(R.plan([r], env({ platform: "win32" })).plans[0].steps).toEqual([
      { cmd: "wt.exe", args: ["-w", "0", "new-tab", "-d", "C:\\w\\a\\;b", "claude", "--resume", "t"] },
    ])
    // Not on Windows (WSL hands WT_SESSION through): the commands to paste.
    expect(R.plan([r], env({ platform: "linux" })).plans[0].kind).toBe("manual")
  })

  test("unknown terminal and unknown here: handed over to paste", () => {
    const { plans } = R.plan([rec({ terminal: { program: "xterm" } })], env())
    expect(plans[0].kind).toBe("manual")
  })

  test("a folder with a newline in it is never typed into a terminal", () => {
    const { plans } = R.plan([rec({ cwd: "/a\nrm -rf ~", terminal: { wezterm: { pane: "1" } } })], env())
    expect(plans[0].kind).toBe("manual")
  })

  test("Codex resumes as codex; anything else is skipped and said", () => {
    const { plans, skipped } = R.plan(
      [rec({ sessionId: "c", client: "codex", terminal: { wezterm: { pane: "1" } } }), rec({ sessionId: "g", client: "goose" })],
      env(),
    )
    expect(plans[0].steps[0].args.slice(-3)).toEqual(["codex", "resume", "c"])
    expect(skipped.map((r) => r.sessionId)).toEqual(["g"])
  })
})

describe("Linux and Windows terminals", () => {
  // Every command is built here and checked as data: none of these terminals runs in the tests.
  const onPath = (...bins: string[]) => (b: string) => bins.includes(b)

  test("which terminal, from the environment a session ran in", () => {
    const at = (env: NodeJS.ProcessEnv) => R.kindOf(R.captureTerminal(env, 0, false))
    expect(at({ KITTY_WINDOW_ID: "3", KITTY_LISTEN_ON: "unix:/tmp/k" })).toBe("kitty")
    expect(at({ TERM_PROGRAM: "WezTerm", WEZTERM_PANE: "4" })).toBe("wezterm")
    expect(at({ GNOME_TERMINAL_SCREEN: "/org/gnome/Terminal/screen/ab_cd", VTE_VERSION: "7600" })).toBe("gnome")
    expect(at({ KONSOLE_DBUS_SESSION: "/Sessions/1", KONSOLE_DBUS_SERVICE: ":1.42", KONSOLE_VERSION: "230804" })).toBe("konsole")
    expect(at({ WT_SESSION: "8f1c-…" })).toBe("wt")
    // inside tmux, whatever shows it, the tabs are tmux's windows
    expect(at({ TMUX: "/tmp/tmux-1000/default,1,0", TMUX_PANE: "%2", GNOME_TERMINAL_SCREEN: "/x" })).toBe("tmux")
    // Alacritty has no tabs, and VTE alone does not say which app (Tilix, xfce4-terminal…)
    expect(at({ ALACRITTY_WINDOW_ID: "1" })).toBeNull()
    expect(at({ VTE_VERSION: "7600" })).toBeNull()
    const t = R.captureTerminal({ KONSOLE_DBUS_SESSION: "/Sessions/1", KONSOLE_DBUS_SERVICE: ":1.42", VTE_VERSION: "7600", ALACRITTY_WINDOW_ID: "9" }, 0, false)
    expect(t.konsole).toEqual({ service: ":1.42", session: "/Sessions/1" })
    expect(t.vte).toBe("7600")
    expect(t.alacritty).toEqual({ window: "9" })
  })

  test("kitty: `kitty @` where kitten is not installed; without remote control, nothing to drive", () => {
    const r = rec({ sessionId: "k", cwd: "/w/a", terminal: { kitty: { window: "1", listenOn: "unix:/tmp/kitty-1" } } })
    expect(R.plan([r], env({ has: onPath("kitty") })).plans[0].steps).toEqual([
      { cmd: "kitty", args: ["@", "--to", "unix:/tmp/kitty-1", "launch", "--type=tab", "--cwd", "/w/a", "claude", "--resume", "k"] },
    ])
    expect(R.plan([r], env({ has: onPath("tmux") })).plans[0].kind).toBe("manual")
  })

  test("GNOME Terminal: a tab each, in its folder, the command after --", () => {
    const a = rec({ sessionId: "g1", cwd: "/w/my api", terminal: { gnome: { screen: "/s/1" } }, startedAt: 1 })
    const b = rec({ sessionId: "g2", cwd: "/w/it's", terminal: { gnome: { screen: "/s/2" } }, startedAt: 2 })
    const { plans } = R.plan([b, a], env({ has: onPath("gnome-terminal"), which: (x) => `/usr/bin/${x}` }))
    expect(plans).toHaveLength(1)
    expect(plans[0].kind).toBe("gnome")
    expect(plans[0].steps).toEqual([
      { cmd: "gnome-terminal", args: ["--tab", "--working-directory=/w/my api", "--", "/usr/bin/claude", "--resume", "g1"] },
      { cmd: "gnome-terminal", args: ["--tab", "--working-directory=/w/it's", "--", "/usr/bin/claude", "--resume", "g2"] },
    ])
    expect(plans[0].steps.some((s) => s.cmd === "osascript" || s.input)).toBe(false)
  })

  test("Konsole: --new-tab, -e last, started detached so a new Konsole window never blocks the restore", () => {
    const r = rec({ sessionId: "q", cwd: "/w/x", client: "codex", terminal: { konsole: { session: "/Sessions/2" } } })
    expect(R.plan([r], env({ has: onPath("konsole") })).plans[0].steps).toEqual([
      { cmd: "konsole", args: ["--new-tab", "--workdir", "/w/x", "-e", "codex", "resume", "q"], detach: true },
    ])
  })

  test("not installed, or not this platform: inside tmux, tmux windows; else the commands to paste", () => {
    const r = rec({ sessionId: "n", terminal: { gnome: {} } })
    expect(R.plan([r], env({ has: onPath() })).plans[0].kind).toBe("manual")
    expect(R.plan([r], env({ platform: "darwin", has: () => true })).plans[0].kind).toBe("manual")
    const inTmux = env({ has: onPath("tmux"), current: { tmux: { pane: "%1", session: "work" } } })
    expect(R.plan([r], inTmux).plans[0].kind).toBe("tmux")
    expect(R.plan([rec({ terminal: { alacritty: {} } })], inTmux).plans[0].kind).toBe("tmux")
    expect(R.plan([rec({ terminal: { alacritty: {} } })], env({ has: onPath("tmux") })).plans[0].kind).toBe("manual")
  })

  test("off macOS nothing is ever handed to osascript, whatever the session was in", () => {
    const terms = [
      { program: "Apple_Terminal", tty: "/dev/ttys1", apple: { window: 1, tab: 1 } },
      { program: "iTerm.app", iterm: { id: "w0t0p0:x" } },
      { program: "ghostty" },
      { gnome: {} },
      { konsole: {} },
      { wt: { session: "x" } },
      { kitty: { window: "1", listenOn: "unix:/k" } },
      { wezterm: { pane: "1" } },
    ]
    for (const platform of ["linux", "win32", "freebsd"] as const) {
      const { plans } = R.plan(terms.map((terminal, i) => rec({ sessionId: `o${i}`, terminal })), env({ platform }))
      for (const p of plans) {
        expect(p.steps.some((s) => s.cmd === "osascript")).toBe(false)
        expect(p.needsAccessibility).toBeFalsy()
      }
    }
  })

  test("Windows: binaries by PATHEXT, never npm's extensionless sh script", () => {
    const files = new Set(["C:\\npm\\claude", "C:\\npm\\claude.cmd", "C:\\apps\\wt.exe"])
    const env = { PATH: "C:\\npm;C:\\apps", PATHEXT: ".COM;.EXE;.BAT;.CMD" }
    expect(R.which("claude", env, "win32", (p) => files.has(p))).toBe("C:\\npm\\claude.cmd")
    expect(R.which("wt", env, "win32", (p) => files.has(p))).toBe("C:\\apps\\wt.exe")
    expect(R.which("wt.exe", env, "win32", (p) => files.has(p))).toBe("C:\\apps\\wt.exe")
    expect(R.which("claude", { PATH: "/usr/bin:/opt/bin" }, "linux", (p) => p === "/opt/bin/claude")).toBe("/opt/bin/claude")
  })
})

describe("permissions", () => {
  test("which pane an osascript error points at", () => {
    expect(R.classifyOsaError("execution error: Not authorized to send Apple events to System Events. (-1743)")).toBe("automation")
    expect(R.classifyOsaError("System Events got an error: osascript is not allowed to send keystrokes. (1002)")).toBe("accessibility")
    expect(R.classifyOsaError("-25211")).toBe("accessibility")
    expect(R.classifyOsaError("1002")).toBe("accessibility") // the number the Terminal script returns
    expect(R.classifyOsaError("-1743")).toBe("automation")
    expect(R.classifyOsaError("not allowed assistive access. (-1719)")).toBe("accessibility")
    expect(R.classifyOsaError("Can't get window 1. (-1728)")).toBe(null)
  })

  test("Settings opens only because the person asked, and not twice in a row", () => {
    const now = 1_000_000
    expect(R.shouldOpenSettings({ pane: "accessibility", userAction: false, state: {}, now })).toBe(false)
    expect(R.shouldOpenSettings({ pane: "accessibility", userAction: true, state: {}, now })).toBe(true)
    const just = { settingsOpened: { accessibility: now - 30_000 } }
    expect(R.shouldOpenSettings({ pane: "accessibility", userAction: true, state: just, now })).toBe(false)
    expect(R.shouldOpenSettings({ pane: "automation", userAction: true, state: just, now })).toBe(true)
    expect(R.shouldOpenSettings({ pane: "accessibility", userAction: true, state: just, now: now + R.REOPEN_SETTINGS_MS })).toBe(true)
  })

  test("the steps name the app and open the right pane", () => {
    expect(R.permissionSteps("accessibility", "Terminal")).toEqual([
      "System Settings → Privacy & Security → Accessibility → turn on Terminal",
      `open "x-apple.systempreferences:com.apple.preference.security?Privacy_Accessibility"`,
    ])
    expect(R.permissionSteps("automation", "Terminal")[1]).toBe(
      `open "x-apple.systempreferences:com.apple.preference.security?Privacy_Automation"`,
    )
    expect(R.appName({ program: "Apple_Terminal" })).toBe("Terminal")
    expect(R.appName({ program: "something" })).toBe("the app crosstalk runs in")
  })
})

describe("asking", () => {
  test("the question names the sessions and no command to remember", () => {
    const rs = ["api", "firmware", "docs", "web", "infra", "ops"].map((d) => rec({ cwd: `/w/${d}` }))
    const q = R.question(rs, BOOT, {})!
    expect(q).toBe(`◢ crosstalk: 6 sessions were open before the restart (api, firmware, docs, web, …). Say "restore them" to bring them back.`)
    expect(q).not.toContain("@restore")
  })

  test("the shortcut", () => {
    expect(R.parseShortcut("  @Restore ")).toBe("yes")
    expect(R.parseShortcut("@restore no")).toBe("no")
    expect(R.parseShortcut("@restore windows")).toBe("windows")
    expect(R.parseShortcut("please @restore")).toBe(null)
    expect(R.parseShortcut("@restore everything now")).toBe(null)
    expect(R.parseShortcut("!restore")).toBe(null)
  })
})

describe("a restore finished later", () => {
  test("a session already running again is never opened a second time", () => {
    // The waiter hands in what was lost when the person asked; this one has
    // come back since, under the same id, in a live process.
    const back = rec({ sessionId: "back", pid: process.pid })
    const out = R.restore({ userAction: false, asked: true, env: {} }, [back])
    expect(out.restored).toEqual([])
    expect(out.text).toContain("nothing to restore")
  })
  test("tabs when the person asked, windows when nobody did", () => {
    expect(R.tabsFor({ userAction: false })).toBe(false)
    expect(R.tabsFor({ userAction: false, asked: true })).toBe(true)
    expect(R.tabsFor({ userAction: false, asked: true, tabs: false })).toBe(false)
  })
})

describe("only the recent ones", () => {
  test("the sessions used within a few hours of the last one", () => {
    const H = 3600_000
    const lost = [{ seenAt: 100 * H }, { seenAt: 98 * H }, { seenAt: 90 * H }, { seenAt: 20 * H }]
    expect(R.recentOf(lost, 4 * H)).toEqual([{ seenAt: 100 * H }, { seenAt: 98 * H }])
    expect(R.recentOf([], 4 * H)).toEqual([])
  })
})
