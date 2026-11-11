// What crosstalk's mod shows, and what became of each thing: the state machine,
// its persistence across restarts, and exactly one restore surface.
//
//   bun test test/uistate.test.ts
//
// The daemon's side (its queue synced into cards, a hand-over, a route answer)
// and the hook's side run in test/ui.sh; the mod itself in a real Claude Code,
// test/canary/drive.sh.

import { describe, expect, test } from "bun:test"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { spawnSync } from "node:child_process"

const HOME = fs.mkdtempSync(path.join(os.tmpdir(), "ct-ui-unit-"))
process.env.CROSSTALK_HOME = HOME
const U = await import("../src/uistate.ts")
type Item = import("../src/uistate.ts").UiItem

const ROOT = path.join(import.meta.dir, "..")
const T0 = 1_800_000_000_000

const msg = (id: string, sessionId = "s1") => ({ id: `msg:${id}`, kind: "message" as const, sessionId, from: "marie", thread: "auth", text: `text ${id}` })

/** A fresh process reading the store: what a restarted daemon, hook or mod sees. */
function inChild(code: string): any {
  const r = spawnSync("bun", ["-e", `const U = await import(${JSON.stringify(path.join(ROOT, "src/uistate.ts"))}); ${code}`], {
    env: { ...process.env, CROSSTALK_HOME: HOME },
    encoding: "utf8",
  })
  if (r.status !== 0) throw new Error(r.stderr)
  return JSON.parse(r.stdout.trim().split("\n").pop()!)
}

describe("the state machine", () => {
  test("a new item is pending", () => {
    const items: Record<string, Item> = {}
    expect(U.upsert(items, msg("a"), T0).state).toBe("pending")
  })

  test("pending goes to handed, answered, muted or later", () => {
    for (const [action, state] of [
      ["hand", "handed"],
      ["answer", "answered"],
      ["mute", "muted"],
      ["later", "later"],
    ] as const) {
      const items: Record<string, Item> = {}
      U.upsert(items, msg("a"), T0)
      const r = U.act(items, "msg:a", action, T0 + 1, action === "answer" ? "sounds good" : undefined)
      expect(r.ok).toBe(true)
      expect(items["msg:a"]!.state).toBe(state)
    }
  })

  test("later comes back to pending only by being acted on, and can still be handed", () => {
    const items: Record<string, Item> = {}
    U.upsert(items, msg("a"), T0)
    U.act(items, "msg:a", "later", T0 + 1)
    expect(U.act(items, "msg:a", "hand", T0 + 2).ok).toBe(true)
  })

  test("a final item takes no further step: no second hand-over", () => {
    const items: Record<string, Item> = {}
    U.upsert(items, msg("a"), T0)
    expect(U.act(items, "msg:a", "hand", T0 + 1).ok).toBe(true)
    for (const action of ["hand", "mute", "later", "answer", "raised"] as const) {
      const r = U.act(items, "msg:a", action, T0 + 2)
      expect(r.ok).toBe(false)
      expect(r.ok ? "" : r.error).toBe("already handed")
    }
    expect(items["msg:a"]!.state).toBe("handed")
  })

  test("only a message or a question can be handed to the agent", () => {
    const items: Record<string, Item> = {}
    U.upsert(items, { id: "route:r", kind: "route", sessionId: "s1" }, T0)
    expect(U.act(items, "route:r", "hand", T0).ok).toBe(false)
    expect(items["route:r"]!.state).toBe("pending")
  })

  test("syncing again never brings a settled card back", () => {
    const items: Record<string, Item> = {}
    U.upsert(items, msg("a"), T0)
    U.act(items, "msg:a", "mute", T0 + 1)
    U.upsert(items, msg("a"), T0 + 2)
    expect(items["msg:a"]!.state).toBe("muted")
    expect(Object.keys(items)).toEqual(["msg:a"])
  })

  test("a message carried over to a new session moves with its state, and may be raised again there", () => {
    const items: Record<string, Item> = {}
    U.upsert(items, msg("a", "old"), T0)
    U.act(items, "msg:a", "raised", T0 + 1)
    U.upsert(items, msg("a", "new"), T0 + 2)
    expect(items["msg:a"]!.sessionId).toBe("new")
    expect(items["msg:a"]!.raisedAt).toBeUndefined()
    expect(U.openFor(items, "old")).toEqual([])
    expect(U.openFor(items, "new").map((i) => i.id)).toEqual(["msg:a"])
  })

  test("a failed effect reopens the item", () => {
    const items: Record<string, Item> = {}
    U.upsert(items, { id: "route:r", kind: "route", sessionId: "s1" }, T0)
    U.act(items, "route:r", "answer", T0 + 1, "gone-session")
    U.reopen(items, "route:r", T0 + 2)
    expect(items["route:r"]!.state).toBe("pending")
    expect(items["route:r"]!.answer).toBeUndefined()
  })

  test("settled from outside (the agent read it with crosstalk_read)", () => {
    const items: Record<string, Item> = {}
    U.upsert(items, msg("a"), T0)
    U.settle(items, "msg:a", "handed", T0 + 1)
    expect(U.openFor(items, "s1")).toEqual([])
  })
})

describe("when a picker may come up by itself", () => {
  const free = { idle: true, promptEmpty: true, lastTurnEnd: 0 }
  const item = (o: Partial<Item> = {}): Item => ({ ...msg("a"), state: "pending", createdAt: T0, updatedAt: T0, ...o })

  test("new, idle, empty prompt: yes", () => {
    expect(U.raisable(item(), free)).toBe(true)
  })

  test("never while a turn runs or the person is typing", () => {
    expect(U.raisable(item(), { ...free, idle: false })).toBe(false)
    expect(U.raisable(item(), { ...free, promptEmpty: false })).toBe(false)
  })

  test("raised once (this process or an earlier one): not again by itself", () => {
    expect(U.raisable(item({ raisedAt: T0 + 5 }), free)).toBe(false)
    // After --resume the new process has seen no turn end: still no.
    expect(U.raisable(item({ raisedAt: T0 + 5 }), { ...free, lastTurnEnd: 0 })).toBe(false)
  })

  test("asked and not answered: what blocks an agent after the next turn, anything else not for two hours", () => {
    const H2 = 2 * 3_600_000
    expect(U.raisable(item({ raisedAt: T0 + 5 }), { ...free, lastTurnEnd: T0 + 6 })).toBe(false) // never turn after turn
    expect(U.raisable(item({ state: "later", raisedAt: T0 + 5 }), { ...free, lastTurnEnd: T0 + 6 })).toBe(false)
    expect(U.raisable(item({ raisedAt: T0 + 5 }), { ...free, lastTurnEnd: T0 + 6 + H2 })).toBe(true)
    expect(U.raisable(item({ id: "attn:perm:x", raisedAt: T0 + 5 }), { ...free, lastTurnEnd: T0 + 6 })).toBe(true) // an agent waits on it
  })

  test("a settled item: never", () => {
    for (const state of ["handed", "answered", "muted"] as const) expect(U.raisable(item({ state }), free)).toBe(false)
  })
})

describe("persistence", () => {
  test("what was settled stays settled in a new process, and a re-sync adds no duplicate", () => {
    U.withStore((items, now) => {
      U.upsert(items, msg("p1", "sess-p"), now)
      U.upsert(items, msg("p2", "sess-p"), now)
      U.act(items, "msg:p1", "hand", now)
    })
    // A restarted daemon syncs its queue again, in its own process.
    const after = inChild(`
      U.withStore((items, now) => { U.upsert(items, ${JSON.stringify(msg("p1", "sess-p"))}, now); U.upsert(items, ${JSON.stringify(msg("p2", "sess-p"))}, now) })
      const all = U.snapshot()
      console.log(JSON.stringify({ open: U.openFor(all, "sess-p").map(i => i.id), p1: all["msg:p1"].state, n: Object.keys(all).filter(k => k.startsWith("msg:p")).length }))
    `)
    expect(after).toEqual({ open: ["msg:p2"], p1: "handed", n: 2 })
    // And a second hand-over from the resumed session is refused.
    const again = inChild(`console.log(JSON.stringify(U.withStore((items, now) => U.act(items, "msg:p1", "hand", now))))`)
    expect(again.ok).toBe(false)
  })

  test("a raised picker stays raised across a restart", () => {
    U.withStore((items, now) => {
      U.upsert(items, msg("r1", "sess-r"), now)
      U.act(items, "msg:r1", "raised", now)
    })
    const it = inChild(`console.log(JSON.stringify(U.snapshot()["msg:r1"]))`)
    expect(typeof it.raisedAt).toBe("number")
    expect(U.raisable(it, { idle: true, promptEmpty: true, lastTurnEnd: 0 })).toBe(false)
  })

  test("two processes writing at once both land", () => {
    const procs = [0, 1, 2, 3].map((k) =>
      Bun.spawn(["bun", "-e", `const U = await import(${JSON.stringify(path.join(ROOT, "src/uistate.ts"))}); for (let i = 0; i < 25; i++) U.withStore((items, now) => { U.upsert(items, { id: "msg:c${k}-" + i, kind: "message", sessionId: "sess-c" }, now) })`], {
        env: { ...process.env, CROSSTALK_HOME: HOME },
      }),
    )
    return Promise.all(procs.map((p) => p.exited)).then(() => {
      expect(U.openFor(U.snapshot(), "sess-c").length).toBe(100)
    })
  })
})

describe("exactly one restore surface", () => {
  const offer = { text: "◢ crosstalk: 6 sessions were open before the restart (api, …). Say \"restore them\" to bring them back.", count: 6, names: ["api", "web", "docs", "fw", "…"], restart: true }

  test("no mod: the systemMessage, and no picker item", () => {
    const r = U.restoreSurface("no-mod", offer)
    expect(r.systemMessage).toBe(offer.text)
    expect(U.snapshot()[U.restoreId("no-mod")]).toBeUndefined()
  })

  test("the mod said hello first: a picker item, and no systemMessage", () => {
    U.markModActive("with-mod")
    const r = U.restoreSurface("with-mod", offer)
    expect(r.systemMessage).toBeUndefined()
    const it = U.snapshot()[U.restoreId("with-mod")]!
    expect(it.kind).toBe("restore")
    expect(it.question).toBe("Restore 6 sessions from before the restart? (api, web, docs, fw, …)")
    expect(it.options).toEqual(["Restore", "Not now"])
  })

  test("nothing claimed: neither", () => {
    U.markModActive("nothing")
    expect(U.restoreSurface("nothing", null)).toEqual({})
    expect(U.restoreSurface("nothing-either", null)).toEqual({})
  })

  test("a stale marker from an old process does not count", () => {
    U.markModActive("stale")
    const f = path.join(HOME, "ui-mod", "stale")
    const old = new Date(Date.now() - 60 * 60 * 1000)
    fs.utimesSync(f, old, old)
    expect(U.restoreSurface("stale", offer).systemMessage).toBe(offer.text)
  })

  test("through the real hook: one session with the mod, one without, the offer claimed once", () => {
    // A session lost to a restart: seen before the boot, its process gone.
    const now = Date.now()
    const boot = now - 5 * 60 * 1000
    fs.mkdirSync(path.join(HOME, "open"), { recursive: true })
    fs.writeFileSync(
      path.join(HOME, "open", "lost-1.json"),
      JSON.stringify({ sessionId: "lost-1", cwd: "/work/api", client: "claude", pid: 999999, startedAt: boot - 3600_000, seenAt: boot - 600_000, terminal: {} }),
    )
    const hook = (session: string) =>
      spawnSync("bun", [path.join(ROOT, "src/hook.ts")], {
        input: JSON.stringify({ hook_event_name: "SessionStart", session_id: session, cwd: "/tmp", source: "startup" }),
        env: { ...process.env, CROSSTALK_HOME: HOME, CROSSTALK_BOOT_TIME: String(boot), CLAUDE_CODE_MESSAGING_SOCKET: "", TMUX: "", TMUX_PANE: "", TERM_PROGRAM: "" },
        encoding: "utf8",
      }).stdout
    // The mod's classic.SessionStart hook runs `crosstalk ui hello` first.
    const hello = spawnSync(path.join(ROOT, "bin/crosstalk"), ["ui", "hello", "--session", "modded"], {
      env: { ...process.env, CROSSTALK_HOME: HOME },
      encoding: "utf8",
    })
    expect(JSON.parse(hello.stdout).ok).toBe(true)
    const withMod = JSON.parse(hook("modded"))
    expect(withMod.systemMessage).toBeUndefined()
    expect(U.snapshot()[U.restoreId("modded")]?.count).toBe(1)
    // The next session (no mod) finds it already offered: no second surface anywhere.
    const plain = JSON.parse(hook("plain"))
    expect(plain.systemMessage).toBeUndefined()
    expect(U.snapshot()[U.restoreId("plain")]).toBeUndefined()
  })

  test("through the real hook without the mod: the systemMessage, as before", () => {
    const now = Date.now()
    const boot = now - 5 * 60 * 1000
    fs.writeFileSync(
      path.join(HOME, "open", "lost-2.json"),
      JSON.stringify({ sessionId: "lost-2", cwd: "/work/web", client: "claude", pid: 999998, startedAt: boot - 3600_000, seenAt: boot - 600_000, terminal: {} }),
    )
    const out = spawnSync("bun", [path.join(ROOT, "src/hook.ts")], {
      input: JSON.stringify({ hook_event_name: "SessionStart", session_id: "plain-2", cwd: "/tmp", source: "startup" }),
      env: { ...process.env, CROSSTALK_HOME: HOME, CROSSTALK_BOOT_TIME: String(boot), CLAUDE_CODE_MESSAGING_SOCKET: "", TMUX: "", TMUX_PANE: "", TERM_PROGRAM: "" },
      encoding: "utf8",
    }).stdout
    expect(JSON.parse(out).systemMessage).toContain('Say "restore them"')
    expect(U.snapshot()[U.restoreId("plain-2")]).toBeUndefined()
  })
})
