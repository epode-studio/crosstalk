// Sessions and attention: recaps, disposable sessions, staffing, focus,
// notifications, the phone, background permission prompts, the --bg fallback
// and OSC 7501.
//
//   bun test test/attention.test.ts
//
// Real tmux, a real daemon and the real hook are test/attention.sh. Here every
// module is driven directly, with fake terminals, clocks and fetches.

import { afterAll, describe, expect, test } from "bun:test"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), "ct-attn-"))
process.env.CROSSTALK_HOME = path.join(TMP, "home")
fs.mkdirSync(process.env.CROSSTALK_HOME, { recursive: true })
afterAll(() => fs.rmSync(TMP, { recursive: true, force: true }))

const Rc = await import("../src/attention/recap.ts")
const Cx = await import("../src/attention/context.ts")
const F = await import("../src/attention/focus.ts")
const A = await import("../src/attention/activity.ts")
const N = await import("../src/attention/notify.ts")
const D = await import("../src/attention/dispose.ts")
const St = await import("../src/attention/staffing.ts")
const Pm = await import("../src/attention/permission.ts")
const Bg = await import("../src/attention/background.ts")
const O = await import("../src/attention/osc7501.ts")
const S = await import("../src/attention/service.ts")
const TS = await import("../src/terminal/status.ts")
const ui = await import("../src/uistate.ts")
const M = await import("../src/threads/model.ts")
const { ThreadService } = await import("../src/threads/service.ts")
const { newIdentity } = await import("../src/crypto.ts")
import type { Rec } from "../src/restore.ts"

const entry = (role: "user" | "assistant", content: unknown, extra: Record<string, unknown> = {}) => JSON.stringify({ type: role, message: { role, content, ...extra } })

function transcript(name: string, rows: string[]): string {
  const f = path.join(TMP, `${name}.jsonl`)
  fs.writeFileSync(f, rows.join("\n") + "\n")
  return f
}

// --- recaps ------------------------------------------------------------------------

describe("recaps", () => {
  test("the last typed prompt and the last answer, tool results and meta left out", () => {
    const f = transcript("t1", [
      entry("user", "set up the repo"),
      entry("assistant", [{ type: "text", text: "Done." }]),
      entry("user", "make the session token refresh rotate every hour"),
      entry("assistant", [{ type: "tool_use", id: "x", name: "Edit", input: {} }]),
      entry("user", [{ type: "tool_result", tool_use_id: "x", content: "ok" }]),
      JSON.stringify({ type: "user", isMeta: true, message: { role: "user", content: "<system-reminder>ignore</system-reminder>" } }),
      entry("assistant", [{ type: "text", text: "The refresh token now rotates hourly; expired tokens are refused." }]),
    ])
    const r = Rc.fromTranscript(f)
    expect(r).toContain("make the session token refresh rotate every hour")
    expect(r).toContain("refresh token now rotates hourly")
    expect(r).not.toContain("set up the repo")
    expect(r).not.toContain("ignore")
  })

  test("long turns are cut, and a missing transcript is no recap", () => {
    const f = transcript("t2", [entry("user", "x".repeat(1000)), entry("assistant", "y".repeat(1000))])
    expect(Rc.fromTranscript(f).length).toBeLessThanOrEqual(Rc.RECAP_MAX)
    expect(Rc.fromTranscript(path.join(TMP, "none.jsonl"))).toBe("")
  })

  test("only the tail of a big transcript is read", () => {
    const rows = Array.from({ length: 4000 }, (_, i) => entry("user", `old prompt ${i} ${"pad ".repeat(40)}`))
    rows.push(entry("user", "the newest prompt"), entry("assistant", "the newest answer"))
    const f = transcript("t3", rows)
    expect(fs.statSync(f).size).toBeGreaterThan(Rc.TAIL_BYTES)
    expect(Rc.fromTranscript(f)).toContain("the newest prompt")
  })

  test("words drop stop words and fold plurals", () => {
    expect([...Rc.words("The tokens are refreshing")].sort()).toEqual(["refresh", "token"])
  })

  test("the tiebreak needs a clear winner", () => {
    const cands = [
      { id: "a", name: "auth", text: "session tokens rotate and refresh" },
      { id: "b", name: "billing", text: "invoice retries and emails" },
    ]
    expect(Rc.tiebreak("rotate the session token refresh", cands)?.id).toBe("a")
    expect(Rc.tiebreak("retry the failed invoice emails", cands)?.id).toBe("b")
    expect(Rc.tiebreak("update the readme", cands)).toBeUndefined()
    // Equal: still a question.
    expect(Rc.tiebreak("token invoice", [{ id: "a", name: "x", text: "token" }, { id: "b", name: "y", text: "invoice" }], "ask", 1)).toBeUndefined()
    // Joining instead of starting a thread wants one more word.
    expect(Rc.tiebreak("rotate token", cands, "ask")?.id).toBe("a")
    expect(Rc.tiebreak("rotate token", cands, "create")).toBeUndefined()
  })
})

// --- context ---------------------------------------------------------------------

describe("context", () => {
  test("the last assistant usage against the window", () => {
    const f = transcript("c1", [
      entry("assistant", "a", { usage: { input_tokens: 10, cache_read_input_tokens: 1000 }, model: "claude-opus-5-5" }),
      entry("assistant", "b", { usage: { input_tokens: 2000, cache_creation_input_tokens: 100_000, cache_read_input_tokens: 70_000 }, model: "claude-opus-5-5" }),
    ])
    const u = Cx.usageFromTranscript(f, {})!
    expect(u.tokens).toBe(172_000)
    expect(u.window).toBe(200_000)
    expect(u.percent).toBe(86)
    expect(Cx.windowFor("claude-opus-5-5[1m]", {})).toBe(1_000_000)
    expect(Cx.windowFor("x", { CROSSTALK_CONTEXT_WINDOW: "500000" })).toBe(500_000)
    expect(Cx.spentAt({})).toBe(85)
    expect(Cx.spentAt({ CROSSTALK_DISPOSE_PCT: "70" })).toBe(70)
  })
})

// --- focus -------------------------------------------------------------------------

const rec = (id: string, terminal: Rec["terminal"], extra: Partial<Rec> = {}): Rec => ({ sessionId: id, cwd: `/w/${id}`, client: "claude", pid: 100, startedAt: 0, seenAt: 0, terminal, name: id, ...extra })

describe("focus", () => {
  test("tmux: the focused client, else the most recently active", () => {
    expect(F.parseTmuxClients("attached,focused|100|%3\nattached|200|%5", "/s")).toEqual({ kind: "tmux", socket: "/s", pane: "%3", focused: true, activity: 100 })
    expect(F.parseTmuxClients("attached|100|%3\nattached|200|%5")?.pane).toBe("%5")
    expect(F.parseTmuxClients("")).toBeNull()
  })

  test("kitty and WezTerm say which window and pane", () => {
    const ls = JSON.stringify([
      { is_focused: false, tabs: [{ is_focused: true, windows: [{ id: 1, is_focused: true }] }] },
      { is_focused: true, tabs: [{ is_focused: false, windows: [{ id: 2 }] }, { is_focused: true, windows: [{ id: 3, is_focused: false }, { id: 4, is_focused: true }] }] },
    ])
    expect(F.parseKittyLs(ls)).toBe("4")
    expect(F.parseWeztermClients(JSON.stringify([{ focused_pane_id: 7, idle_time: { secs: 40 } }, { focused_pane_id: 9, idle_time: { secs: 2 } }]))).toBe("9")
  })

  test("asking: every tmux server once, AppleScript only on a Mac, a GUI answer beats tmux's guess", () => {
    const recs = [
      rec("a", { tmux: { pane: "%1", socket: "/tmp/s1" } }),
      rec("b", { tmux: { pane: "%2", socket: "/tmp/s1" } }),
      rec("c", { program: "Apple_Terminal", tty: "/dev/ttys003", apple: {} }),
    ]
    const calls: string[] = []
    const sys: F.Sys = {
      platform: "darwin",
      has: () => true,
      run: (s) => {
        calls.push(`${s.cmd} ${s.args.join(" ")}`)
        if (s.cmd === "tmux") return { ok: true, out: "attached|5|%2" }
        if (s.cmd === "osascript") return { ok: true, out: "/dev/ttys003" }
        return { ok: false, out: "" }
      },
    }
    const seen = F.ask(recs, sys)
    expect(calls.filter((c) => c.startsWith("tmux")).length).toBe(1)
    expect(F.pick(seen, recs)).toEqual({ sessionId: "c", how: "apple", sure: true })
    // tmux's own focused flag wins over everything.
    const seen2 = F.ask(recs, { ...sys, run: (s) => (s.cmd === "tmux" ? { ok: true, out: "attached,focused|5|%1" } : sys.run(s)) })
    expect(F.pick(seen2, recs)?.sessionId).toBe("a")
    // On Linux nothing asks AppleScript.
    calls.length = 0
    F.ask(recs, { ...sys, platform: "linux" })
    expect(calls.some((c) => c.startsWith("osascript"))).toBe(false)
  })

  test("no terminal can say: the last typed", () => {
    const sys: F.Sys = { platform: "linux", has: () => false, run: () => ({ ok: false, out: "" }) }
    expect(F.focused({ recs: [rec("w", { wt: { session: "x" } })], sys, lastTyped: "w" })).toEqual({ sessionId: "w", how: "last typed", sure: false })
    expect(F.focused({ recs: [], sys })).toBeNull()
  })

  test("focusing, per terminal", () => {
    expect(F.focusSteps({ tmux: { pane: "%4", socket: "/s" } })!.steps.map((s) => s.args.slice(2, 3)[0])).toEqual(["switch-client", "select-window", "select-pane"])
    expect(F.focusSteps({ kitty: { window: "3", listenOn: "unix:/k" } })!.steps[0].args).toEqual(["@", "--to", "unix:/k", "focus-window", "--match", "id:3"])
    expect(F.focusSteps({ wezterm: { pane: "12" } })!.steps[0].args).toEqual(["cli", "activate-pane", "--pane-id", "12"])
    expect(F.focusSteps({ program: "Apple_Terminal", tty: "/dev/ttys001", apple: {} }, "darwin")!.steps[0].input).toContain('if (tty of t) is "/dev/ttys001"')
    expect(F.focusSteps({ program: "iTerm.app", tty: "/dev/ttys002" }, "darwin")!.steps[0].input).toContain("tell s to select")
    expect(F.focusSteps({ program: "Apple_Terminal", tty: "/dev/ttys001", apple: {} }, "linux")).toBeNull()
    expect(F.focusSteps({ wt: { session: "x" } })).toBeNull()
  })
})

// --- activity -----------------------------------------------------------------------

describe("activity", () => {
  test("the newest prompt wins, and away is nothing typed and no focus change", () => {
    A.noteTyped("s1", 1000)
    A.noteTyped("s2", 5000)
    expect(A.lastTyped()?.sessionId).toBe("s2")
    expect(A.isAway({ now: 10 * 60_000 + 5000, lastTypedAt: 5000, focusChangedAt: 0, minutes: 10 })).toBe(true)
    expect(A.isAway({ now: 10 * 60_000 + 4999, lastTypedAt: 5000, focusChangedAt: 0, minutes: 10 })).toBe(false)
    expect(A.isAway({ now: 20 * 60_000, lastTypedAt: 5000, focusChangedAt: 15 * 60_000, minutes: 10 })).toBe(false)
    expect(A.awayMinutes({})).toBe(10)
    expect(A.awayMinutes({ CROSSTALK_AWAY_MIN: "0" })).toBe(0)
  })
})

// --- notifications -------------------------------------------------------------------

describe("notifications", () => {
  const has = (set: string[]) => (b: string) => set.includes(b)
  test("kitty: OSC 99 to the asker's own tty, so a click focuses it", () => {
    const d = N.desktopPlan({ id: "q1", title: "crosstalk · auth", body: "api is waiting; on you", click: ["ct"], asker: { kitty: { window: "2" }, tty: "/dev/pts/4" }, platform: "linux", has: has([]) })!
    expect(d.kind).toBe("tty")
    if (d.kind !== "tty") return
    expect(d.path).toBe("/dev/pts/4")
    expect(d.data).toContain("\x1b]99;i=q1:d=0:a=focus;crosstalk · auth\x1b\\")
    expect(d.data).toContain("p=body;api is waiting on you")
  })
  test("macOS: terminal-notifier runs the focus command on click; without it a plain notification", () => {
    const d = N.desktopPlan({ id: "q", title: "t", body: "b", click: ["/p/bin/crosstalk", "attn", "focus", "--session", "s 1"], platform: "darwin", has: has(["terminal-notifier"]) })!
    expect(d.kind === "run" && d.step.cmd).toBe("terminal-notifier")
    expect(d.kind === "run" && d.jumps).toBe(true)
    expect(d.kind === "run" && d.step.args.join(" ")).toContain("-execute /p/bin/crosstalk attn focus --session 's 1'")
    const p = N.desktopPlan({ id: "q", title: "t", body: "b", click: [], platform: "darwin", has: has([]) })!
    expect(p.kind === "run" && p.step.cmd).toBe("osascript")
    expect(N.desktopPlan({ id: "q", title: "t", body: "b", click: [], platform: "linux", has: has(["notify-send"]) })!.kind).toBe("run")
    expect(N.desktopPlan({ id: "q", title: "t", body: "b", click: [], platform: "win32", has: has([]) })).toBeNull()
  })
  test("the phone gets a count and a thread name, nothing else", async () => {
    expect(N.sealedLine(1, "auth")).toBe("crosstalk: 1 question waiting in auth")
    expect(N.sealedLine(2, "a b/c")).toBe("crosstalk: 2 questions waiting in a-b-c")
    const f = path.join(TMP, "attention.json")
    fs.writeFileSync(f, JSON.stringify({ ntfy: { topic: "my topic", url: "https://ntfy.example/" } }))
    expect(N.ntfyConfig({}, f)).toEqual({ url: "https://ntfy.example/my%20topic", token: undefined })
    expect(N.ntfyConfig({ CROSSTALK_NTFY_URL: "http://x/t" }, f)?.url).toBe("http://x/t")
    expect(N.ntfyConfig({}, path.join(TMP, "nope.json"))).toBeNull()
    const sent: { url: string; body: string; headers: any }[] = []
    const fetcher = (async (url: string, init: any) => (sent.push({ url, body: init.body, headers: init.headers }), new Response("ok"))) as unknown as typeof fetch
    expect(await N.pushNtfy({ url: "http://x/t", token: "k" }, "crosstalk: 1 question waiting in auth", fetcher)).toBe(true)
    expect(sent[0].body).toBe("crosstalk: 1 question waiting in auth")
    expect(sent[0].headers.Authorization).toBe("Bearer k")
  })
})

// --- disposable sessions ---------------------------------------------------------------

function thread(name = "auth") {
  const t = M.create({ name, repo: "github.com/acme/api", by: "fp", label: "ana", now: Date.parse("2026-11-01T10:00:00Z") })
  M.setRecap(t, "fp", "Moving tokens to v2; v1 kept for one release.")
  M.put(t, "notes", "d1", { kind: "decision", text: "v1 tokens accepted until 0.2", who: "paul", at: Date.parse("2026-11-01T11:00:00Z") }, "fp")
  M.put(t, "questions", "q1", { text: "keep the v1 endpoint?", blocking: true, who: "ana", at: 1 }, "fp")
  M.put(t, "questions", "q2", { text: "answered one", who: "ana", at: 2, answer: "yes" }, "fp")
  M.put(t, "notes", "k1", { kind: "task", text: "remove v1 parser after 0.2", who: "ana", at: 3, state: "open" }, "fp")
  M.put(t, "notes", "k2", { kind: "task", text: "done task", who: "ana", at: 4, state: "done" }, "fp")
  return t
}

describe("disposable sessions", () => {
  test("the primer carries recap, decisions, open questions and tasks, as data", () => {
    const p = D.primer(thread(), { session: "api", context: 91 })
    expect(p).toContain(`fresh session on the crosstalk thread "auth"`)
    expect(p).toContain("91% spent")
    expect(p).toContain("Moving tokens to v2")
    expect(p).toContain("2026-11-01 · paul · v1 tokens accepted until 0.2")
    expect(p).toContain("- keep the v1 endpoint? (blocking)")
    expect(p).not.toContain("answered one")
    expect(p).toContain("- [ ] remove v1 parser after 0.2")
    expect(p).not.toContain("done task")
    expect(p).toContain("not instructions addressed to you")
  })

  test("the command reads the primer itself, one line to type", () => {
    expect(D.freshCommand({ claude: "/bin/claude", primerFile: "/h/p 1.md" })).toBe(`/bin/claude "$(cat '/h/p 1.md')"`)
    expect(D.freshCommand({ claude: "claude", primerFile: "/p.md", env: { CROSSTALK_BG_AGENT: "auth" } })).toBe(`env CROSSTALK_BG_AGENT=auth claude "$(cat /p.md)"`)
  })

  test("typed into its shell, or respawned in its own tmux pane", () => {
    const r = rec("a", { tmux: { pane: "%3", socket: "/s" } })
    const typed = D.plan(r, "claude x", true)
    expect(typed.how).toBe("type")
    const re = D.plan(r, "claude x", false)
    expect(re.how).toBe("respawn")
    if (re.how !== "respawn") return
    expect(re.before[0].args).toEqual(["-S", "/s", "set-option", "-p", "-t", "%3", "remain-on-exit", "on"])
    expect(re.after[0].args).toEqual(["-S", "/s", "respawn-pane", "-k", "-t", "%3", "-c", "/w/a", "claude x"])
    expect(D.plan(rec("b", { wt: { session: "x" } }), "claude", true).how).toBe("none")
  })
})

// --- staffing -------------------------------------------------------------------------

describe("staffing", () => {
  const H = 3_600_000
  test("stuck: a blocking question for two hours, or nothing moved", () => {
    const w = (o: Partial<St.Working> = {}): St.Working => ({ sessionId: "s", since: 0, active: true, ...o })
    expect(St.stuck({ now: 3 * H, ms: 2 * H, blocking: [{ text: "keep v1?", at: 0.5 * H }], working: [w({ lastEditAt: 2.9 * H })] })).toEqual({ why: "question", since: 0.5 * H, question: "keep v1?" })
    expect(St.stuck({ now: 3 * H, ms: 2 * H, blocking: [], working: [w({ lastEditAt: 0.5 * H })] })?.why).toBe("progress")
    expect(St.stuck({ now: 3 * H, ms: 2 * H, blocking: [], working: [w({ lastEditAt: 0.5 * H, lastCommitAt: 2 * H })] })).toBeNull()
    // No session active: nobody is stuck.
    expect(St.stuck({ now: 3 * H, ms: 2 * H, blocking: [{ text: "q", at: 0 }], working: [w({ active: false })] })).toBeNull()
    expect(St.question("auth", { why: "progress", since: 0 }, 2 * H)).toBe("auth has been stuck for 2 hours. Add a second agent?")
  })
})

// --- permissions -------------------------------------------------------------------------

describe("background permission prompts", () => {
  test("the preview, the question and the decision", () => {
    expect(Pm.preview("Bash", { command: "rm -rf build\n  && make" })).toBe("rm -rf build\\n  && make")
    expect(Pm.preview("Write", { file_path: "/a/b.ts", content: "x" })).toBe(`/a/b.ts {"content":"x"}`)
    expect(Pm.question("auth-2", "Bash", { command: "npm test" })).toBe("auth-2 (in the background) wants to use Bash: npm test. Allow it?")
    expect(Pm.decisionFor(Pm.ALLOW)).toEqual({ behavior: "allow" })
    const sugg = [{ type: "addRules", rules: [{ toolName: "Bash" }], behavior: "allow", destination: "session" }]
    expect(Pm.decisionFor(Pm.ALLOW_SESSION, sugg)).toEqual({ behavior: "allow", updatedPermissions: sugg })
    expect(Pm.decisionFor(Pm.DENY).behavior).toBe("deny")
    expect(Pm.decisionFor("whatever").behavior).toBe("deny")
    expect(Pm.hookOutput({ behavior: "allow" })).toEqual({ hookSpecificOutput: { hookEventName: "PermissionRequest", decision: { behavior: "allow" } } })
    expect(Pm.backgroundAgent({ CROSSTALK_BG_AGENT: "auth" })).toBe("auth")
    expect(Pm.backgroundAgent({})).toBe("")
  })
})

// --- --bg and 7501 --------------------------------------------------------------------------

describe("no tmux, and OSC 7501", () => {
  test("claude --bg, detected or forced", () => {
    expect(Bg.claudeBackground("claude", { CROSSTALK_CLAUDE_BG: "1" })).toEqual({ bg: true, attach: true })
    expect(Bg.claudeBackground("claude", { CROSSTALK_CLAUDE_BG: "0" })).toEqual({ bg: false, attach: false })
    const helper = path.join(TMP, "fake-claude")
    fs.writeFileSync(helper, "#!/bin/sh\necho '  --bg, --background   Start the session in the background'\necho 'Commands:'\necho '  attach <id|name>   Open a background session'\n", { mode: 0o755 })
    expect(Bg.claudeBackground(helper, {})).toEqual({ bg: true, attach: true })
    const st = Bg.bgStep({ claude: "claude", name: "auth", task: "do it", cwd: "/w" })
    expect(st.args).toEqual(["--bg", "-n", "auth", "do it"])
    expect(st.env).toEqual({ CROSSTALK_BG_AGENT: "auth" })
    expect(Bg.tmuxArgv(["claude", "x"], "auth")).toEqual(["env", "CROSSTALK_BG_AGENT=auth", "claude", "x"])
  })

  test("no tmux: a background agent is claude --bg in its worktree, and show is claude attach", async () => {
    const { spawnSync } = await import("node:child_process")
    const Sp = await import("../src/spawn.ts")
    const repo = path.join(TMP, "bgrepo")
    fs.mkdirSync(repo, { recursive: true })
    const g = (...a: string[]) => spawnSync("git", ["-C", repo, "-c", "user.email=t@t", "-c", "user.name=t", ...a], { encoding: "utf8" })
    g("init", "-q", "-b", "main")
    g("commit", "-q", "--allow-empty", "-m", "init")
    const bin = path.join(TMP, "bgbin")
    fs.mkdirSync(bin, { recursive: true })
    const log = path.join(TMP, "bg-calls")
    // Only claude on PATH: no tmux.
    fs.writeFileSync(path.join(bin, "claude"), `#!/bin/sh\nprintf '%s|%s|%s\\n' "$(pwd)" "$CROSSTALK_BG_AGENT" "$*" >>${log}\necho bg_123\n`, { mode: 0o755 })
    const env = { ...process.env, PATH: bin, CROSSTALK_CLAUDE_BG: "1", TMUX: "", TERM_PROGRAM: "" }
    delete (env as any).TMUX
    const r = Sp.spawnAgents({ task: "watch the logs", name: "logs", background: true, cwd: repo, env })
    expect(r.ok).toBe(true)
    expect(r.text).toContain("Claude Code's own background session")
    expect(r.agents[0].claudeBg).toBe(true)
    expect(fs.readFileSync(log, "utf8")).toContain(`/logs|logs|--bg -n logs watch the logs`)
    const s = Sp.show({ name: "logs", cwd: repo, env })
    expect(s.text).toContain("attach logs")
    // Without --bg either: refused as before.
    const no = Sp.spawnAgents({ task: "x", name: "nobg", background: true, cwd: repo, env: { ...env, CROSSTALK_CLAUDE_BG: "0" } })
    expect(no.ok).toBe(false)
    expect(no.text).toContain("Install tmux")
  })

  test("7501 only when asked for, only for Ghostty and Rex, never in tmux", () => {
    expect(O.sequence("waiting", "auth")).toBe("\x1b]7501;state=blocked:kind=question:app=crosstalk:id=auth\x1b\\")
    expect(O.sequence("off")).toContain("state=idle")
    const ghost = { program: "ghostty", tty: "/dev/ttys9" }
    const before = process.env.CROSSTALK_OSC7501
    delete process.env.CROSSTALK_OSC7501
    expect(TS.actionsFor(ghost, "working", "darwin").some((a) => a.kind === "tty")).toBe(false)
    process.env.CROSSTALK_OSC7501 = "1"
    expect(TS.actionsFor(ghost, "working", "darwin")).toEqual([{ kind: "tty", path: "/dev/ttys9", data: O.sequence("working") }])
    expect(TS.actionsFor({ program: "ghostty", tty: "/dev/x", tmux: { pane: "%1" } }, "working", "darwin").some((a) => a.kind === "tty")).toBe(false)
    expect(TS.actionsFor({ program: "WezTerm", tty: "/dev/x", wezterm: { pane: "1" } }, "working", "darwin").filter((a) => a.kind === "tty" && a.data.includes("7501"))).toEqual([])
    if (before === undefined) delete process.env.CROSSTALK_OSC7501
    else process.env.CROSSTALK_OSC7501 = before
  })
})

// --- the service ------------------------------------------------------------------------------

function world(o: { env?: NodeJS.ProcessEnv; rule?: string; recs?: Rec[]; focus?: string; background?: string[] } = {}) {
  const id = newIdentity("ana")
  let tiebreak: InstanceType<typeof S.AttentionService>["tiebreak"] | undefined
  let flushed: ((ids: string[]) => void) | undefined
  const threads = new ThreadService({
    identity: id,
    peers: () => ({}),
    send: () => {},
    log: () => {},
    file: path.join(TMP, `threads-${Math.random()}.json`),
    network: false,
    tiebreak: (sid, c, m) => tiebreak?.(sid, c, m),
    onFlush: (ids) => flushed?.(ids),
  })
  const sessions = new Map<string, S.Reg>()
  const log: string[] = []
  const spawned: any[] = []
  const answered: any[] = []
  const restarted: any[] = []
  const pushed: string[] = []
  const desktop: any[] = []
  const svc = new S.AttentionService({
    threads,
    log: (...a) => void log.push(a.join(" ")),
    file: path.join(TMP, `attn-${Math.random()}.json`),
    root: "/plugin",
    sessions: () => sessions,
    status: () => "idle",
    mainId: () => undefined,
    modLive: () => true,
    touched: () => ({}),
    repoOf: () => "github.com/acme/api",
    spawn: (x) => (spawned.push(x), { ok: true, text: "started", agents: [{ name: x.name }] }),
    background: (sid) => (o.background?.includes(sid) ? sid : undefined),
    restart: async (x) => (restarted.push(x), { ok: true, text: "ok" }),
    focusSys: {
      platform: "linux",
      has: (b) => b === "tmux",
      run: (s) => (s.cmd === "tmux" && o.focus ? { ok: true, out: `attached,focused|1|${o.focus}` } : { ok: false, out: "" }),
    },
    readRecs: () => o.recs ?? [],
    recAlive: () => true,
    lastCommitAt: () => undefined,
    desktop: (d) => void desktop.push(d),
    fetcher: (async (_u: string, init: any) => (pushed.push(init.body), new Response("ok"))) as unknown as typeof fetch,
    env: { CROSSTALK_STAFF_EVERY_MS: "0", CROSSTALK_NO_NOTIFY: "0", ...o.env },
  })
  if (o.rule === S.START_FRESH) svc.setDisposeRule(true)
  tiebreak = svc.tiebreak.bind(svc)
  flushed = svc.onThreadsFlush.bind(svc)
  const add = (sid: string, paths: string[], extra: Partial<S.Reg> = {}) => {
    sessions.set(sid, { sessionId: sid, name: sid, cwd: `/w/${sid}`, seenAt: Date.now(), ...extra })
    threads.observe({ sessionId: sid, name: sid, cwd: `/w/${sid}`, repo: "github.com/acme/api", branch: "main", paths })
  }
  return { svc, threads, sessions, add, log, spawned, answered, restarted, pushed, desktop }
}

describe("the service", () => {
  test("a recap breaks a tie the files cannot, and fills an empty thread recap", async () => {
    const w = world()
    w.add("s-auth", ["src/auth/a.ts", "src/auth/b.ts", "src/auth/c.ts"])
    w.add("s-bill", ["src/billing/x.ts", "src/billing/y.ts", "src/billing/z.ts"])
    const auth = w.threads.find("s-auth")!
    w.threads.edit("s-auth", { recap: "rotating the session tokens and their refresh" })
    // Files equal: a question, without a transcript.
    w.add("s-q", ["src/auth/a.ts", "src/billing/x.ts"])
    expect(w.threads.question("s-q")).toBeTruthy()
    // With one: the recap places it.
    const tr = transcript("svc1", [entry("user", "make the session token refresh rotate"), entry("assistant", "The refresh token now rotates.")])
    // (Its own files: the ones it joins with become the thread's, which would tip s-q.)
    w.add("s-r", ["src/auth/b.ts", "src/billing/y.ts"], { transcript: tr })
    expect(w.threads.question("s-r")).toBeUndefined()
    expect(w.threads.idsFor("s-r")).toEqual([auth.id])
    // At Stop, the unsure one is placed too, into billing, whose empty recap it fills.
    w.sessions.get("s-q")!.transcript = transcript("svc2", [entry("user", "retry the failed invoice emails in billing"), entry("assistant", "Invoice retries now back off.")])
    const r = await w.svc.stop("s-q")
    expect(r.threads).toEqual(["billing"])
    expect(w.threads.question("s-q")).toBeUndefined()
    await new Promise((r) => setTimeout(r, 10))
    expect(M.recap(w.threads.find(undefined, "billing")!)).toContain("retry the failed invoice emails")
    // auth's own recap is never overwritten.
    expect(M.recap(w.threads.find(undefined, "auth")!)).toBe("rotating the session tokens and their refresh")
  })

  test("context spent: the question once, or a fresh session at once by the standing rule", async () => {
    const recs = [rec("s1", { tmux: { pane: "%1" } }, { cwd: "/w/s1" })]
    const asked = world({ recs })
    asked.add("s1", ["src/auth/a.ts", "src/auth/b.ts", "src/auth/c.ts"])
    asked.svc.context("s1", { percent: 91 })
    await asked.svc.context("s1", { percent: 92 })
    const items = Object.values(ui.snapshot()).filter((i) => i.kind === "attention" && i.id === S.itemId("dispose", "s1"))
    expect(items.length).toBe(1)
    expect(items[0].question).toContain("s1's context is 91% spent")
    expect(items[0].options).toEqual([S.START_FRESH, S.COMPACT])
    const r = await asked.svc.act("s1", items[0].id, "answer", S.START_FRESH)
    expect(r.ok).toBe(true)
    expect(asked.restarted[0].cmd).toContain(`"$(cat `)
    expect(fs.readFileSync(/cat (\S+)\)/.exec(asked.restarted[0].cmd)![1].replace(/'/g, ""), "utf8")).toContain(`thread "auth"`)
    // The next session in that folder carries on the thread.
    asked.add("s1-fresh", [], { cwd: "/w/s1" })
    asked.sessions.get("s1-fresh")!.cwd = "/w/s1"
    asked.svc.registered({ sessionId: "s1-fresh", name: "s1-fresh", cwd: "/w/s1" })
    expect(asked.threads.namesFor("s1-fresh")).toEqual(["auth"])

    const ruled = world({ recs: [rec("s2", { tmux: { pane: "%2" } })], rule: S.START_FRESH })
    ruled.add("s2", ["src/auth/a.ts", "src/auth/b.ts", "src/auth/c.ts"])
    const pc = await ruled.svc.precompact("s2", "auto")
    expect(pc.block).toContain("instead of compacting")
    await new Promise((r) => setTimeout(r, 400))
    expect(ruled.restarted.length).toBe(1)
    // A /compact the person typed is theirs.
    expect((await ruled.svc.precompact("s2", "manual")).block).toBeUndefined()
    // Nowhere to type: nothing is ended, nothing asked.
    const stuck = world({ recs: [rec("s3", { wt: { session: "x" } })], rule: S.START_FRESH })
    stuck.add("s3", ["src/auth/a.ts", "src/auth/b.ts", "src/auth/c.ts"])
    expect((await stuck.svc.precompact("s3", "auto")).block).toBeUndefined()
  })

  test("a stuck thread: one question, and yes starts an agent with the brief", async () => {
    const w = world({ env: { CROSSTALK_STUCK_MS: "1" } })
    w.add("s-auth", ["src/auth/a.ts", "src/auth/b.ts", "src/auth/c.ts"])
    await new Promise((r) => setTimeout(r, 5))
    w.svc.tick()
    await new Promise((r) => setTimeout(r, 5))
    w.svc.tick()
    const t = w.threads.find("s-auth")!
    const items = Object.values(ui.snapshot()).filter((i) => i.id.startsWith(`attn:staff:${t.id}:`))
    expect(items.length).toBe(1)
    expect(items[0].question).toMatch(/^auth has been stuck for .+\. Add a second agent\?$/)
    const r = await w.svc.act("s-auth", items[0].id, "answer", St.ADD)
    expect(r.ok).toBe(true)
    expect(w.spawned[0].name).toBe("auth")
    expect(w.spawned[0].background).toBe(true)
    expect(w.spawned[0].task).toContain(`second agent on the crosstalk thread "auth"`)
  })

  test("a permission request: asked where the person is, held until answered", async () => {
    const recs = [rec("main-ish", { tmux: { pane: "%7" } }), rec("bg", { tmux: { pane: "%9", socket: "/c" } })]
    const w = world({ recs, focus: "%7", background: ["bg"] })
    w.add("main-ish", [])
    w.add("other", [])
    w.add("bg", [])
    const p = w.svc.permission("bg", { agent: "bg", tool: "Bash", input: { command: "npm test" }, suggestions: [{ type: "addRules" }] })
    const it = Object.values(ui.snapshot()).find((i) => i.id.startsWith("attn:perm:bg"))!
    expect(it.sessionId).toBe("main-ish")
    expect(it.question).toBe("bg (in the background) wants to use Bash: npm test. Allow it?")
    // The person is not looking at bg: a notification... (none on this platform) and a receipt naming it.
    expect(w.svc.takeNotes("main-ish")[0].text).toContain(`Say "show me bg"`)
    await w.svc.act("main-ish", it.id, "answer", Pm.ALLOW_SESSION)
    const r = await p
    expect(r.decision).toEqual({ behavior: "allow", updatedPermissions: [{ type: "addRules", destination: "session" }] })
    expect(ui.snapshot()[it.id].state).toBe("answered")
    // Answered twice does nothing.
    expect((await w.svc.act("main-ish", it.id, "answer", Pm.DENY)).ok).toBe(false)
  })

  test("away and blocking: ntfy gets the sealed line and the mod a push, never the question", async () => {
    const w = world({ env: { CROSSTALK_AWAY_MIN: "0", CROSSTALK_NTFY_URL: "http://ntfy.local/t" } })
    w.add("s-auth", ["src/auth/a.ts", "src/auth/b.ts", "src/auth/c.ts"])
    w.svc.start()
    w.threads.edit("s-auth", { question: { text: "SECRET-CANARY keep the v1 endpoint?", blocking: true } })
    await new Promise((r) => setTimeout(r, 20))
    expect(w.pushed).toEqual(["crosstalk: 1 question waiting in auth"])
    const push = w.svc.takePush("s-auth")!
    expect(push.text).toBe("crosstalk: 1 question waiting in auth")
    expect(JSON.stringify(w.pushed) + push.text).not.toContain("SECRET-CANARY")
    // Not again for the same question.
    w.threads.edit("s-auth", { recap: "x" })
    await new Promise((r) => setTimeout(r, 20))
    expect(w.pushed.length).toBe(1)
  })

  test("not away: no push", async () => {
    const w = world({ env: { CROSSTALK_AWAY_MIN: "10", CROSSTALK_NTFY_URL: "http://ntfy.local/t" } })
    w.add("s-auth", ["src/auth/a.ts", "src/auth/b.ts", "src/auth/c.ts"])
    w.svc.start()
    w.threads.edit("s-auth", { question: { text: "keep?", blocking: true } })
    await new Promise((r) => setTimeout(r, 20))
    expect(w.pushed).toEqual([])
  })

  test("questions go to main, else the session in front, never a background agent", () => {
    const recs = [rec("a", { tmux: { pane: "%1" } }), rec("b", { tmux: { pane: "%2" } }), rec("bg", { tmux: { pane: "%3" } })]
    const w = world({ recs, focus: "%2", background: ["bg"] })
    for (const s of ["a", "b", "bg"]) w.add(s, [])
    expect(w.svc.target()).toBe("b")
    const w2 = world({ recs, focus: "%3", background: ["bg"] })
    for (const s of ["a", "b", "bg"]) w2.add(s, [])
    expect(w2.svc.target("a")).toBe("a")
    // A session whose own hook says it is a background agent is never asked either.
    w.svc.markBackground("b", "b-agent")
    expect(w.svc.target()).not.toBe("b")
  })
})
