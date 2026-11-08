// A newer install takes over from an older daemon; an older one never pulls it back.
//
//   bun test test/upgrade.test.ts

import { describe, expect, test } from "bun:test"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { spawnSync } from "node:child_process"

process.env.CROSSTALK_HOME = fs.mkdtempSync(path.join(os.tmpdir(), "ct-upgrade-"))
const C = await import("../src/client.ts")
const { P } = await import("../src/config.ts")

describe("daemon upgrade", () => {
  test("versions compare by number", () => {
    expect(C.newer("0.2.1", "0.2.0")).toBe(true)
    expect(C.newer("0.10.0", "0.9.9")).toBe(true)
    expect(C.newer("0.2.0", "0.2.0")).toBe(false)
    expect(C.newer("0.1.40", "0.2.0")).toBe(false)
  })
  test("older, or from before version files: outdated; the same or newer: not", () => {
    fs.writeFileSync(P.daemonLock, String(process.pid))
    fs.rmSync(P.daemonVersion, { force: true })
    expect(C.daemonOutdated("0.2.1")).toBe(true) // predates version files
    fs.writeFileSync(P.daemonVersion, JSON.stringify({ pid: 1, version: "0.9.0" }))
    expect(C.daemonOutdated("0.2.1")).toBe(true) // the file is an earlier daemon's
    fs.writeFileSync(P.daemonVersion, JSON.stringify({ pid: process.pid, version: "0.2.0" }))
    expect(C.daemonOutdated("0.2.1")).toBe(true)
    fs.writeFileSync(P.daemonVersion, JSON.stringify({ pid: process.pid, version: "0.2.1" }))
    expect(C.daemonOutdated("0.2.1")).toBe(false)
    fs.writeFileSync(P.daemonVersion, JSON.stringify({ pid: process.pid, version: "0.3.0" }))
    expect(C.daemonOutdated("0.2.1")).toBe(false) // an old session never pulls a newer daemon back
    expect(C.daemonOutdated("")).toBe(false)
  })
  test("only a crosstalk daemon is ever stopped, never this process or a reused pid", () => {
    expect(C.isDaemonProcess(process.pid, () => "bun /x/dist/daemon.js")).toBe(false)
    expect(C.isDaemonProcess(4242, () => "bun /Users/p/.claude/plugins/cache/epode/crosstalk/0.2.1/dist/daemon.js")).toBe(true)
    expect(C.isDaemonProcess(4242, () => "node /opt/crosstalk/src/daemon.ts")).toBe(true)
    expect(C.isDaemonProcess(4242, () => "/usr/bin/vim notes.txt")).toBe(false)
    expect(C.isDaemonProcess(4242, () => "node my-daemon.js --watch")).toBe(false)
    expect(C.isDaemonProcess(4242, () => null)).toBe(false)
  })
  test("the plugin's own version is read from its manifest", () => {
    const root = path.join(import.meta.dir, "..")
    expect(C.pluginVersion(root)).toBe(JSON.parse(fs.readFileSync(path.join(root, ".claude-plugin", "plugin.json"), "utf8")).version)
  })
  test("`crosstalk daemon restart` is the CLI subcommand, not a second daemon", () => {
    const shim = path.join(import.meta.dir, "..", "bin", "crosstalk")
    fs.rmSync(P.daemonLock, { force: true }) // nothing to stop: never this test's own process
    const r = spawnSync("sh", [shim, "daemon", "stop"], { encoding: "utf8", env: { ...process.env } })
    expect(`${r.stdout}${r.stderr}`).toMatch(/daemon (stopped|was not running)/)
  })
})

describe("one daemon at a time", () => {
  test("the first start holds the lock; a dead or stale holder is taken over", () => {
    const f = path.join(P.root, "daemon.starting")
    fs.rmSync(f, { force: true })
    expect(C.takeStartLock(f)).toBe(true)
    fs.writeFileSync(f, JSON.stringify({ pid: process.ppid, at: Date.now() }))
    expect(C.takeStartLock(f)).toBe(false) // someone alive is starting one
    fs.writeFileSync(f, JSON.stringify({ pid: process.ppid, at: Date.now() - 60_000 }))
    expect(C.takeStartLock(f)).toBe(true) // stale
    fs.writeFileSync(f, JSON.stringify({ pid: 999_999_9, at: Date.now() }))
    expect(C.takeStartLock(f)).toBe(true) // its starter died
    C.dropStartLock(f)
    expect(fs.existsSync(f)).toBe(false)
  })
  test("an upgrade that would not start is left alone for an hour", () => {
    expect(C.upgradeFailed("0.9.9")).toBe(false)
    C.noteUpgradeFailed("0.9.9", 1000)
    expect(C.upgradeFailed("0.9.9", 2000)).toBe(true)
    expect(C.upgradeFailed("0.9.8", 2000)).toBe(false)
    expect(C.upgradeFailed("0.9.9", 1000 + 3_600_001)).toBe(false)
  })
})

describe("a session from before the update", () => {
  test("is told once that it still runs the old version", () => {
    fs.writeFileSync(P.daemonVersion, JSON.stringify({ pid: process.pid, version: "0.3.0" }))
    expect(C.staleNotice("old1", "0.2.9")).toContain("still runs 0.2.9")
    expect(C.staleNotice("old1", "0.2.9")).toBe(null)
    expect(C.staleNotice("new1", "0.3.0")).toBe(null)
  })
})
