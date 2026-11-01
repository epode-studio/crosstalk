// Matching a message to the session working on the same thing.
//
//   bun test test/footprint.test.ts
//
// The daemon-level behaviour, held messages and the question included, is in
// test/routing.sh. This covers the matching rules on their own.

import { describe, expect, test } from "bun:test"
import {
  bindingKey,
  choose,
  normaliseRemote,
  parseSummary,
  pathsFromToolInput,
  score,
  summarise,
  touch,
  type SessionFootprint,
} from "../src/footprint.ts"

const fp = (repo: string | undefined, branch?: string, paths: string[] = []): SessionFootprint => ({
  repo,
  branch,
  paths: Object.fromEntries(paths.map((p, i) => [p, 1000 - i])),
})

describe("normaliseRemote", () => {
  test("every way of cloning one repo spells it the same", () => {
    const want = "github.com/epode-studio/crosstalk"
    for (const u of [
      "git@github.com:epode-studio/crosstalk.git",
      "https://github.com/epode-studio/crosstalk.git",
      "https://user@github.com/Epode-Studio/crosstalk",
      "ssh://git@github.com:22/epode-studio/crosstalk.git",
      "ssh://git@github.com/epode-studio/crosstalk/",
    ])
      expect(normaliseRemote(u)).toBe(want)
  })
})

describe("score and choose", () => {
  const api = { item: "api", fp: fp("github.com/o/api", "main", ["src/auth/token.ts"]) }
  const apiFeat = { item: "api-feat", fp: fp("github.com/o/api", "token-v2") }
  const fw = { item: "firmware", fp: fp("github.com/o/firmware", "main", ["src/auth/token.ts"]) }
  const plain = { item: "plain", fp: fp(undefined) }

  test("different repos: only the matching one", () => {
    expect(choose([api, fw, plain], { repo: "github.com/o/firmware", branch: "dev" })).toEqual({
      pick: "firmware",
      score: 1,
    })
  })

  test("a shared path in another repo counts for nothing", () => {
    expect(score(fw.fp, { repo: "github.com/o/api", paths: ["src/auth/token.ts"] })).toBe(0)
  })

  test("same repo, different branches: the branch wins", () => {
    const c = choose([api, apiFeat], { repo: "github.com/o/api", branch: "token-v2" })
    expect(c.pick).toBe("api-feat")
  })

  test("the branch outranks any amount of file overlap", () => {
    const many = Array.from({ length: 30 }, (_, i) => `src/f${i}.ts`)
    const busy = { item: "busy", fp: fp("github.com/o/api", "main", many) }
    expect(choose([busy, apiFeat], { repo: "github.com/o/api", branch: "token-v2", paths: many }).pick).toBe(
      "api-feat",
    )
  })

  test("same repo and branch: shared files decide", () => {
    const other = { item: "api-2", fp: fp("github.com/o/api", "main", ["docs/readme.md"]) }
    expect(choose([api, other], { repo: "github.com/o/api", branch: "main", paths: ["src/auth/token.ts"] }).pick).toBe(
      "api",
    )
    // A neighbouring file in the same directory still leans the right way.
    expect(choose([api, other], { repo: "github.com/o/api", branch: "main", paths: ["src/auth/expiry.ts"] }).pick).toBe(
      "api",
    )
  })

  test("no match is not a guess", () => {
    expect(choose([api, fw, plain], { repo: "github.com/o/docs", branch: "main" })).toEqual({
      why: "none",
      tied: [],
    })
  })

  test("a tie is not a guess", () => {
    const c = choose([api, apiFeat], { repo: "github.com/o/api", branch: "elsewhere" })
    expect(c.pick).toBeUndefined()
    expect(c).toMatchObject({ why: "tie" })
  })
})

describe("what a session touched", () => {
  test("paths from Claude Code and Codex tool inputs", () => {
    expect(pathsFromToolInput({ file_path: "/r/src/a.ts", old_string: "x" })).toEqual(["/r/src/a.ts"])
    expect(pathsFromToolInput({ notebook_path: "/r/n.ipynb" })).toEqual(["/r/n.ipynb"])
    expect(
      pathsFromToolInput({ command: "*** Begin Patch\n*** Update File: src/b.ts\n@@\n*** Add File: src/c.ts\n" }),
    ).toEqual(["src/b.ts", "src/c.ts"])
    expect(pathsFromToolInput({ command: "ls -la" })).toEqual([])
    expect(pathsFromToolInput(undefined)).toEqual([])
  })

  test("kept relative to the repo, so two machines agree; outside the repo is ignored", () => {
    const base: SessionFootprint = { repo: "github.com/o/api", root: "/home/x/api", paths: {} }
    const t = touch(base, "/home/x/api/sub", ["/home/x/api/src/a.ts", "../README.md", "/etc/hosts"], 5)
    expect(Object.keys(t.paths).sort()).toEqual(["README.md", "src/a.ts"])
  })

  test("the summary is most recent first and omits what is absent", () => {
    const s = summarise({ repo: "github.com/o/api", paths: { old: 1, new: 9 } })
    expect(s).toEqual({ repo: "github.com/o/api", paths: ["new", "old"] })
    expect(summarise({ paths: { a: 1 } })).toBeUndefined()
  })
})

describe("peers", () => {
  test("a peer without a footprint, or with a malformed one, has none", () => {
    expect(parseSummary(undefined)).toBeUndefined()
    expect(parseSummary({ branch: "main" })).toBeUndefined()
    expect(parseSummary("github.com/o/api")).toBeUndefined()
    expect(parseSummary({ repo: "git@github.com:O/api.git", paths: ["a", 3] })).toEqual({
      repo: "github.com/o/api",
      branch: undefined,
      paths: ["a"],
    })
  })

  test("a remembered answer is per sender, repo and branch", () => {
    const a = bindingKey("marie", { repo: "r", branch: "b" })
    expect(a).not.toBe(bindingKey("marie", { repo: "r", branch: "c" }))
    expect(a).not.toBe(bindingKey("paul", { repo: "r", branch: "b" }))
  })
})
