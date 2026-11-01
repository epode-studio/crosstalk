// Gathering sessions started before crosstalk: what the watch records, when
// the offer is put, exactly what each terminal is told to type, and that only
// idle sessions are ever ended, gracefully.
//
//   bun test test/gather.test.ts
//
// The whole path with real tmux and stub claude processes is test/gather.sh.

import { describe, expect, test } from "bun:test"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { spawn } from "node:child_process"

process.env.CROSSTALK_HOME = fs.mkdtempSync(path.join(os.tmpdir(), "ct-gather-unit-"))
const R = await import("../src/restore.ts")
const G = await import("../src/gather.ts")
type Rec = import("../src/restore.ts").Rec
type Sys = import("../src/gather.ts").Sys
type RegEntry = import("../src/gather.ts").RegEntry

const NOW = 1_800_000_000_000
const BOOT = NOW - 60 * 60 * 1000

type Proc = { start: string; tty?: string; args?: string; ppid?: number; comm?: string; env?: NodeJS.ProcessEnv; ignores?: boolean }
function fakeSys(procs: Record<number, Proc>, o: Partial<Sys> = {}) {
  const signals: [number, string][] = []
  const ran: import("../src/restore.ts").Step[] = []
  const sys: Sys = {
    platform: "linux",
    now: () => NOW,
    ps: (pid, f) => {
      const p = procs[pid]
      if (!p) return null
      if (f === "lstart") return p.start
      if (f === "tty") return p.tty ?? "??"
      if (f === "args") return p.args ?? "claude"
      if (f === "ppid") return String(p.ppid ?? 1)
      if (f === "comm") return p.comm ?? null
      return null
    },
    alive: (pid, start) => !!procs[pid] && (!start || procs[pid].start === start),
    env: (pid) => procs[pid]?.env ?? null,
    tmuxPanes: () => [],
    appleLocate: () => null,
    kill: (pid, sig) => {
      signals.push([pid, sig])
      if (!procs[pid]) throw new Error("ESRCH")
      if (!procs[pid].ignores) delete procs[pid]
    },
    run: (s) => {
      ran.push(s)
      return { ok: true, out: "" }
    },
    sleep: async () => {},
    ...o,
  }
  return { sys, signals, ran }
}

const reg = (o: Partial<RegEntry> & { pid: number; sessionId: string }): RegEntry => ({ cwd: "/work/api", status: "idle", ...o })
const hookRec = (o: Partial<Rec> & { sessionId: string; pid: number }): Rec => ({
  cwd: "/work/x",
  client: "claude",
  startedAt: NOW - 1000,
  seenAt: NOW - 1000,
  terminal: {},
  ...o,
})

describe("watch", () => {
  test("snapshots every live session without a record of its own, and nothing else", () => {
    const { sys } = fakeSys(
      {
        10: { start: "Mon 10", tty: "pts/3", env: { TMUX: "/tmp/tmux-1/default,1,0", TMUX_PANE: "%4", TERM_PROGRAM: "tmux" } },
        11: { start: "Mon 11", tty: "pts/4" },
        12: { start: "Mon 12", tty: "pts/5" },
        14: { start: "Mon 14" }, // no tty: claude -p, the SDK
      },
      {
        tmuxPanes: () => [{ tty: "/dev/pts/3", pane: "%4", session: "work", window: 2, paneIndex: 0, socket: "/tmp/tmux-1/default" }],
      },
    )
    const out = G.snapshot({
      self: "me",
      registry: [
        reg({ pid: 10, sessionId: "old-a", cwd: "/work/a", status: "busy", name: "api" }),
        reg({ pid: 11, sessionId: "has-crosstalk" }),
        reg({ pid: 12, sessionId: "me" }),
        reg({ pid: 13, sessionId: "dead" }), // listed, but its process is gone
        reg({ pid: 14, sessionId: "headless" }),
      ],
      records: [hookRec({ sessionId: "has-crosstalk", pid: 11 })],
      registryPids: new Set([10, 11, 12, 13, 14]),
      boot: BOOT,
      sys,
    })
    expect(out.map((r) => r.sessionId).sort()).toEqual(["headless", "old-a"])
    const a = out.find((r) => r.sessionId === "old-a")!
    expect(a).toMatchObject({
      adopted: "watched",
      client: "claude",
      cwd: "/work/a",
      name: "api",
      pid: 10,
      pidStart: "Mon 10",
      interactive: true,
      terminal: { tty: "/dev/pts/3", program: "tmux", tmux: { pane: "%4", session: "work", window: 2, socket: "/tmp/tmux-1/default" } },
    })
    expect(out.find((r) => r.sessionId === "headless")!.interactive).toBe(false)
  })

  test("finds a Terminal.app tab by its tty, without the process's environment", () => {
    const { sys } = fakeSys({ 20: { start: "s", tty: "ttys004" } }, { platform: "darwin", appleLocate: (tty) => (tty === "/dev/ttys004" ? { window: 1234, tab: 3 } : null) })
    const [r] = G.snapshot({ registry: [reg({ pid: 20, sessionId: "t" })], records: [], registryPids: new Set([20]), boot: BOOT, sys })
    expect(r.terminal).toEqual({ tty: "/dev/ttys004", program: "Apple_Terminal", apple: { sessionId: undefined, window: 1234, tab: 3 } })
  })

  test("a watched session that exited normally (its registry file gone) is not offered back as lost", () => {
    const { sys } = fakeSys({})
    const watched = (id: string, pid: number, seenAt = NOW - 5000) => hookRec({ sessionId: id, pid, adopted: "watched", seenAt, interactive: true })
    const out = G.snapshot({
      registry: [],
      records: [watched("exited", 30), watched("crashed", 31), watched("before-boot", 32, BOOT - 1000)],
      registryPids: new Set([31, 32]),
      boot: BOOT,
      sys,
    })
    expect(out.map((r) => [r.sessionId, r.endReason])).toEqual([["exited", "exit"]])
    // The crashed one stays lost, so restore offers it.
    const c = watched("crashed", 31)
    expect(R.isLost(c, { now: NOW, boot: BOOT, all: [c], alive: () => false })).toBe(true)
  })

  test("a fresh record keeps its tab; a stale one is looked up again", () => {
    let looked = 0
    const { sys } = fakeSys({ 40: { start: "s", tty: "pts/9" } }, { tmuxPanes: () => (looked++, []) })
    const before = hookRec({ sessionId: "w", pid: 40, pidStart: "s", adopted: "watched", watchedAt: NOW - 1000, terminal: { tty: "/dev/pts/9", program: "kept" } })
    const [r] = G.snapshot({ registry: [reg({ pid: 40, sessionId: "w" })], records: [before], registryPids: new Set([40]), boot: BOOT, sys })
    expect(r.terminal.program).toBe("kept")
    expect(looked).toBe(0)
    const stale = { ...before, watchedAt: NOW - G.RECHECK_MS - 1 }
    G.snapshot({ registry: [reg({ pid: 40, sessionId: "w" })], records: [stale], registryPids: new Set([40]), boot: BOOT, sys })
    expect(looked).toBe(1)
  })

  test("the session's own hooks replace a watched record whole", () => {
    R.writeRec(hookRec({ sessionId: "adopt-me", pid: 1, adopted: "watched", startedAt: 5 }))
    R.note({ event: "UserPromptSubmit", sessionId: "adopt-me", cwd: "/x", client: "claude", env: {} })
    const r = R.readOne("adopt-me")!
    expect(r.adopted).toBeUndefined()
    expect(r.startedAt).toBe(5)
  })
})

describe("the offer", () => {
  const c = (id: string) => hookRec({ sessionId: id, pid: 1, adopted: "watched", interactive: true, name: id })
  test("is put once for a set of sessions, and again only for new ones", () => {
    const first = G.offerFor([c("a"), c("b"), c("d"), c("e")], {})!
    expect(first.question).toBe("4 Claude sessions started before crosstalk. Bring them in? Idle ones restart in their tab with their conversation.")
    expect(first.text).toContain(`Say "bring them in"`)
    expect(G.offerFor([c("a"), c("b")], { offered: { at: 1, ids: ["a", "b"] } })).toBeNull()
    expect(G.offerFor([c("a"), c("z")], { offered: { at: 1, ids: ["a", "b"] } })!.count).toBe(2)
    expect(G.offerFor([], {})).toBeNull()
  })

  test("never counts the asker, a session without a tab, or one already in", () => {
    const all = [
      c("ok"),
      { ...c("self") },
      { ...c("parent"), pid: 77 },
      { ...c("headless"), interactive: false },
      { ...c("done"), gather: { state: "done" as const, at: 1 } },
      { ...c("ended"), endedAt: 1 },
      hookRec({ sessionId: "hooked", pid: 1 }),
    ]
    expect(G.candidates(all, { self: "self", selfPids: [77], alive: () => true }).map((r) => r.sessionId)).toEqual(["ok"])
  })

  test("offerOnce claims it once across sessions", () => {
    const child = spawn("sleep", ["30"], { stdio: "ignore" })
    try {
      R.writeRec({ ...c("once-1"), pid: child.pid!, pidStart: undefined })
      const a = G.offerOnce("asker-1")
      const b = G.offerOnce("asker-2")
      expect(a?.count).toBeGreaterThanOrEqual(1)
      expect(b).toBeNull()
    } finally {
      child.kill()
      R.removeRec("once-1")
    }
  })
})

describe("typing into the same tab", () => {
  const cwd = `/Users/me/it's "x" \\ dir`
  const r = hookRec({ sessionId: "abc", pid: 1, cwd })
  const cmd = R.typed(r)

  test("the command is cd and resume, quoted for the shell", () => {
    expect(cmd).toBe(String.raw`cd '/Users/me/it'\''s "x" \ dir' && claude --resume abc`)
  })

  test("Terminal.app: do script in tab N of window id W, quoted for AppleScript", () => {
    const p = G.inPlaceSteps({ program: "Apple_Terminal", tty: "/dev/ttys001", apple: { window: 1234, tab: 2 } }, cmd, "darwin")!
    expect(p.kind).toBe("apple")
    expect(p.steps).toEqual([{ cmd: "osascript", args: ["-"], input: String.raw`tell application "Terminal" to do script "cd '/Users/me/it'\\''s \"x\" \\ dir' && claude --resume abc" in tab 2 of window id 1234` }])
  })

  test("tmux: send-keys to the pane, literally, then Enter", () => {
    const p = G.inPlaceSteps({ tmux: { pane: "%4", socket: "/tmp/tmux-501/default" } }, cmd)!
    expect(p.steps).toEqual([
      { cmd: "tmux", args: ["-S", "/tmp/tmux-501/default", "send-keys", "-t", "%4", "-l", cmd] },
      { cmd: "tmux", args: ["-S", "/tmp/tmux-501/default", "send-keys", "-t", "%4", "Enter"] },
    ])
  })

  test("iTerm2, kitty and WezTerm send the text their own way", () => {
    const it = G.inPlaceSteps({ program: "iTerm.app", tty: "/dev/ttys009" }, cmd, "darwin")!
    expect(it.kind).toBe("iterm")
    expect(it.steps[0].input).toContain(`if (tty of s) is "/dev/ttys009" then`)
    expect(it.steps[0].input).toContain(String.raw`tell s to write text "cd '/Users/me/it'\\''s \"x\" \\ dir' && claude --resume abc"`)
    expect(G.inPlaceSteps({ kitty: { window: "7", listenOn: "unix:/tmp/kitty" } }, cmd)!.steps).toEqual([
      { cmd: "kitten", args: ["@", "--to", "unix:/tmp/kitty", "send-text", "--match", "id:7", `${cmd}\r`] },
    ])
    expect(G.inPlaceSteps({ wezterm: { pane: "3" } }, cmd)!.steps).toEqual([
      { cmd: "wezterm", args: ["cli", "send-text", "--pane-id", "3", "--no-paste", `${cmd}\r`] },
    ])
  })

  test("a terminal that cannot be typed into from outside gets a new tab instead", () => {
    expect(G.inPlaceSteps({ program: "ghostty", tty: "/dev/ttys002" }, cmd, "darwin")).toBeNull()
    expect(G.inPlaceSteps({ program: "Apple_Terminal", apple: { window: 1, tab: 1 } }, cmd, "linux")).toBeNull()
    expect(G.inPlaceSteps({}, cmd)).toBeNull()
  })
})

describe("restarting", () => {
  const watched = (id: string, pid: number, terminal: Rec["terminal"] = { tmux: { pane: "%1" } }) => {
    const r = hookRec({ sessionId: id, pid, pidStart: `start-${pid}`, adopted: "watched", interactive: true, terminal, cwd: "/w" })
    R.writeRec(r)
    return r
  }
  const base = (procs: Record<number, Proc>, more: Partial<Sys> = {}) => fakeSys(procs, more)
  const shellChild = (pid: number, extra: Partial<Proc> = {}): Record<number, Proc> => ({
    [pid]: { start: `start-${pid}`, ppid: 900, args: "claude", ...extra },
    900: { start: "shell", comm: "-zsh" },
  })

  test("busy waits and is not touched", async () => {
    watched("busy-1", 50)
    const { sys, signals } = base(shellChild(50))
    const r = await G.restartOne("busy-1", { selfPids: [], sys, registry: [reg({ pid: 50, sessionId: "busy-1", status: "busy" })], reopen: () => false })
    expect(r).toBe("wait")
    expect(signals).toEqual([])
  })

  test("idle: SIGTERM to its own pid, then the resume typed into its pane, and restore does not count it lost", async () => {
    watched("idle-1", 51)
    const { sys, signals, ran } = base(shellChild(51))
    const r = await G.restartOne("idle-1", { selfPids: [], sys, registry: [reg({ pid: 51, sessionId: "idle-1" })], reopen: () => false })
    expect(r).toBe("done")
    expect(signals).toEqual([[51, "SIGTERM"]])
    expect(ran.map((s) => s.args.slice(-2))).toEqual([["-l", "cd /w && claude --resume idle-1"], ["%1", "Enter"]])
    const rec = R.readOne("idle-1")!
    expect(rec.endReason).toBe("gather")
    expect(R.isLost(rec, { now: NOW, boot: BOOT, all: [rec], alive: () => false })).toBe(false)
  })

  test("never the session asking, and never a pid that was reused", async () => {
    watched("asker", 52)
    watched("reused", 53)
    const { sys, signals } = base({ ...shellChild(52), 53: { start: "someone-else" } })
    expect(await G.restartOne("asker", { self: "asker", selfPids: [], sys, registry: [reg({ pid: 52, sessionId: "asker" })], reopen: () => false })).toEqual({ failed: "it is the session asking" })
    expect(await G.restartOne("reused", { selfPids: [], sys, registry: [reg({ pid: 53, sessionId: "reused" })], reopen: () => false })).toBe("gone")
    expect(signals).toEqual([])
  })

  test("a process that is not claude is never signalled", async () => {
    watched("imposter", 54)
    const { sys, signals } = base(shellChild(54, { args: "vim notes.txt" }))
    expect(await G.restartOne("imposter", { selfPids: [], sys, registry: [reg({ pid: 54, sessionId: "imposter" })], reopen: () => false })).toEqual({ failed: "its process is not claude" })
    expect(signals).toEqual([])
  })

  test("one that ignores SIGTERM gets SIGINT twice, never SIGKILL, and is left running", async () => {
    watched("stubborn", 55)
    const { sys, signals } = base(shellChild(55, { ignores: true }))
    const r = await G.restartOne("stubborn", { selfPids: [], sys, registry: [reg({ pid: 55, sessionId: "stubborn" })], reopen: () => false })
    expect(r).toEqual({ failed: "it did not exit" })
    expect(signals.map((s) => s[1])).toEqual(["SIGTERM", "SIGINT", "SIGINT"])
    expect(R.readOne("stubborn")!.endedAt).toBeUndefined()
  })

  test("not started from a shell, or in a terminal with no way in: reopened in a new tab", async () => {
    watched("direct", 56)
    let reopened: Rec | null = null
    const { sys, ran } = base({ 56: { start: "start-56", ppid: 901, args: "claude" }, 901: { start: "x", comm: "tmux: server" } })
    const r = await G.restartOne("direct", { selfPids: [], sys, registry: [reg({ pid: 56, sessionId: "direct" })], reopen: (x) => ((reopened = x), true) })
    expect(r).toBe("newTab")
    expect(ran).toEqual([])
    expect(reopened!.endedAt).toBeUndefined()
  })

  test("Terminal.app: the tab is looked up again by tty just before typing", async () => {
    watched("mac", 57, { program: "Apple_Terminal", tty: "/dev/ttys007", apple: { window: 1, tab: 1 } })
    const { sys, ran } = base(shellChild(57), { platform: "darwin", appleLocate: () => ({ window: 99, tab: 4 }) })
    expect(await G.restartOne("mac", { selfPids: [], sys, registry: [reg({ pid: 57, sessionId: "mac" })], reopen: () => false })).toBe("done")
    expect(ran[0].input).toBe(`tell application "Terminal" to do script "cd /w && claude --resume mac" in tab 4 of window id 99`)
  })

  test("the receipt says it plainly", () => {
    expect(G.receipt({ done: ["a", "b", "c", "d"], newTab: [], failed: [] })).toBe("4 sessions are now in crosstalk.")
    expect(G.receipt({ done: ["a"], newTab: ["b"], failed: [{ id: "c", why: "it did not exit" }] })).toBe(
      "2 sessions are now in crosstalk. 1 could not be typed into its old tab, so it opened in a new one. 1 left as it was: it did not exit.",
    )
  })
})
