// Parking a thread, and at most N agents at once.
//
//   bun test test/park.test.ts

import { describe, expect, test } from "bun:test"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"

process.env.CROSSTALK_HOME = fs.mkdtempSync(path.join(os.tmpdir(), "ct-park-"))
const Pk = await import("../src/attention/park.ts")
const { thread } = await import("../src/tools/thread.ts")

describe("parking a thread", () => {
  test("parked, its items are held (a stuck agent's permission still comes through); unparked, back", () => {
    expect(Pk.set("Auth", true)).toContain("parked Auth")
    expect(Pk.set("auth", true)).toContain("already parked")
    expect(Pk.isParked("AUTH")).toBe(true)
    expect(Pk.held({ id: "relay:s1:x", thread: "auth" })).toBe(true)
    expect(Pk.held({ id: "attn:perm:s1", thread: "auth" })).toBe(false)
    expect(Pk.held({ id: "relay:s2:x", thread: "billing" })).toBe(false)
    expect(Pk.held({ id: "you:x" })).toBe(false)
    expect(Pk.set("auth", false)).toContain("is back")
    expect(Pk.held({ id: "relay:s1:x", thread: "auth" })).toBe(false)
    expect(Pk.set("auth", false)).toContain("was not parked")
  })
  test("the thread tool parks and unparks by name", () => {
    expect(thread.route({ action: "park", thread: "auth" })).toEqual({ name: "crosstalk_park", args: { thread: "auth", on: true } })
    expect(thread.route({ action: "unpark", thread: "auth" })).toEqual({ name: "crosstalk_park", args: { thread: "auth", on: false } })
    expect("error" in thread.route({ action: "park" })).toBe(true)
  })
})

describe("at most N agents at once", () => {
  test("what waits starts in order while there is room, skipping a parked thread's", () => {
    Pk.writeQueue([])
    Pk.enqueue({ task: "a", name: "a", cwd: "/x", thread: { name: "auth" } })
    Pk.enqueue({ task: "b", name: "b", cwd: "/x", thread: { name: "billing" } })
    Pk.enqueue({ task: "c", name: "c", cwd: "/x" })
    Pk.set("auth", true)
    const started: string[] = []
    const r = Pk.drain(3, (x) => (started.push(x.task), true), { max: 4, threadOf: (x) => (x.thread as any)?.name })
    expect(r.map((x) => x.task)).toEqual(["b"])
    expect(Pk.queue().map((x) => x.task)).toEqual(["a", "c"])
    Pk.set("auth", false)
    expect(Pk.drain(4, () => true, { max: 4 })).toEqual([]) // no room
    expect(Pk.drain(0, () => false, { max: 4 })).toEqual([]) // a start that failed stays queued
    expect(Pk.queue()).toHaveLength(2)
    expect(Pk.drain(0, () => true, { max: 4 }).map((x) => x.task)).toEqual(["a", "c"])
    expect(Pk.queue()).toEqual([])
  })
  test("the cap is CROSSTALK_WIP, four by default", () => {
    expect(Pk.wipMax({})).toBe(4)
    expect(Pk.wipMax({ CROSSTALK_WIP: "2" })).toBe(2)
  })
})
