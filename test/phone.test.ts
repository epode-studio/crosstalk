// Phone, history and env (docs/urls.md, "On the phone", "History", "Servers
// that just start"): the QR encoder, checked by a small independent decoder
// and known vectors; a thread's links section (merge, cap, sealing, search);
// which local files a worktree gets, and the question asked once per repo.
//
//   bun test test/phone.test.ts
//
// The daemon, a spawned worktree and the MCP tools are test/phone.sh.

import { afterAll, describe, expect, test } from "bun:test"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { spawnSync } from "node:child_process"

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), "ct-phone-"))
process.env.CROSSTALK_HOME = path.join(TMP, "home")
fs.mkdirSync(process.env.CROSSTALK_HOME, { recursive: true })
afterAll(() => fs.rmSync(TMP, { recursive: true, force: true }))

const Q = await import("../src/urls/history/qr.ts")
const H = await import("../src/urls/history/links.ts")
const PH = await import("../src/urls/history/phone.ts")
const M = await import("../src/threads/model.ts")
const F = await import("../src/threads/format.ts")
const { newKey } = await import("../src/threads/seal.ts")
const SEL = await import("../src/env/select.ts")
const CP = await import("../src/env/copy.ts")
const E = await import("../src/env/index.ts")

// --- a small QR reader, written apart from the encoder -------------------------------

const EXP: number[] = []
const LOG: number[] = new Array(256).fill(0)
{
  let x = 1
  for (let i = 0; i < 255; i++) {
    EXP[i] = x
    LOG[x] = i
    x <<= 1
    if (x & 0x100) x ^= 0x11d
  }
}
const mul = (a: number, b: number) => (a && b ? EXP[(LOG[a] + LOG[b]) % 255] : 0)

/** [ec per block, [data per block…]] from ISO 18004 table 9, typed again here. */
const TABLE: Record<string, [number, number[]]> = {
  "1L": [7, [19]], "1M": [10, [16]], "2L": [10, [34]], "2M": [16, [28]], "3L": [15, [55]], "3M": [26, [44]],
  "4L": [20, [80]], "4M": [18, [32, 32]], "5L": [26, [108]], "5M": [24, [43, 43]], "6L": [18, [68, 68]], "6M": [16, [27, 27, 27, 27]],
  "7L": [20, [78, 78]], "7M": [18, [31, 31, 31, 31]], "8L": [24, [97, 97]], "8M": [22, [38, 38, 39, 39]],
  "9L": [30, [116, 116]], "9M": [22, [36, 36, 36, 37, 37]], "10L": [18, [68, 68, 69, 69]], "10M": [26, [43, 43, 43, 43, 44]],
}
const CENTERS: Record<number, number[]> = { 2: [6, 18], 3: [6, 22], 4: [6, 26], 5: [6, 30], 6: [6, 34], 7: [6, 22, 38], 8: [6, 24, 42], 9: [6, 26, 46], 10: [6, 28, 50] }
const MASKS: ((r: number, c: number) => boolean)[] = [
  (r, c) => (r + c) % 2 === 0,
  (r) => r % 2 === 0,
  (_r, c) => c % 3 === 0,
  (r, c) => (r + c) % 3 === 0,
  (r, c) => (Math.floor(r / 2) + Math.floor(c / 3)) % 2 === 0,
  (r, c) => ((r * c) % 2) + ((r * c) % 3) === 0,
  (r, c) => (((r * c) % 2) + ((r * c) % 3)) % 2 === 0,
  (r, c) => (((r + c) % 2) + ((r * c) % 3)) % 2 === 0,
]
const FORMATS: Record<string, string> = {
  L0: "111011111000100", L1: "111001011110011", L2: "111110110101010", L3: "111100010011101",
  L4: "110011000101111", L5: "110001100011000", L6: "110110001000001", L7: "110100101110110",
  M0: "101010000010010", M1: "101000100100101", M2: "101111001111100", M3: "101101101001011",
  M4: "100010111111001", M5: "100000011001110", M6: "100111110010111", M7: "100101010100000",
}

function reserved(size: number, v: number): boolean[][] {
  const f = Array.from({ length: size }, () => new Array(size).fill(false))
  const box = (r0: number, c0: number, h: number, w: number) => {
    for (let r = r0; r < r0 + h; r++) for (let c = c0; c < c0 + w; c++) if (r >= 0 && c >= 0 && r < size && c < size) f[r][c] = true
  }
  box(0, 0, 9, 9) // finder, separator, format
  box(0, size - 8, 9, 8)
  box(size - 8, 0, 8, 9)
  box(6, 0, 1, size) // timing
  box(0, 6, size, 1)
  const cs = CENTERS[v] ?? []
  for (const r of cs) for (const c of cs) if (!((r === 6 && c === 6) || (r === 6 && c === cs[cs.length - 1]) || (r === cs[cs.length - 1] && c === 6))) box(r - 2, c - 2, 5, 5)
  if (v >= 7) {
    box(0, size - 11, 6, 3)
    box(size - 11, 0, 3, 6)
  }
  return f
}

/** Reads a QR code back: format (both copies), unmask, de-interleave, Reed-Solomon syndromes, byte mode. */
function readQr(m: boolean[][]): { text: string; ecl: string; mask: number; version: number } {
  const size = m.length
  const v = (size - 17) / 4
  const a: number[] = []
  for (let c = 0; c <= 5; c++) a.push(+m[8][c])
  a.push(+m[8][7], +m[8][8], +m[7][8])
  for (let r = 5; r >= 0; r--) a.push(+m[r][8])
  const b: number[] = []
  for (let r = size - 1; r >= size - 7; r--) b.push(+m[r][8])
  for (let c = size - 8; c < size; c++) b.push(+m[8][c])
  // Bits as placed run from the least significant (format bit 0) on: the strings above are most significant first.
  const word1 = a.join("")
  const word2 = b.join("")
  if (word1 !== word2) throw new Error("the two format copies differ")
  const hit = Object.entries(FORMATS).find(([, s]) => s === word1)
  if (!hit) throw new Error(`format ${word1} is not a valid one`)
  const ecl = hit[0][0]
  const mask = Number(hit[0][1])
  if (!m[size - 8][8]) throw new Error("no dark module")
  const fn = reserved(size, v)
  const bits: number[] = []
  let up = true
  for (let c = size - 1; c > 0; c -= 2) {
    if (c === 6) c = 5
    for (let i = 0; i < size; i++) {
      const r = up ? size - 1 - i : i
      for (const cc of [c, c - 1]) if (!fn[r][cc]) bits.push(+(m[r][cc] !== MASKS[mask](r, cc)))
    }
    up = !up
  }
  const words: number[] = []
  for (let i = 0; i + 8 <= bits.length; i += 8) words.push(bits.slice(i, i + 8).reduce((x, y) => (x << 1) | y, 0))
  const [ec, lens] = TABLE[`${v}${ecl}`]
  const blocks = lens.map(() => [] as number[])
  let k = 0
  for (let i = 0; i < Math.max(...lens); i++) lens.forEach((n, j) => i < n && blocks[j].push(words[k++]))
  for (let i = 0; i < ec; i++) lens.forEach((_n, j) => blocks[j].push(words[k++]))
  for (const blk of blocks)
    for (let i = 0; i < ec; i++) {
      // c(α^i) must be 0 for every root of the generator.
      let s = 0
      for (const w of blk) s = mul(s, EXP[i]) ^ w
      if (s !== 0) throw new Error("Reed-Solomon syndrome is not zero")
    }
  const data = blocks.flatMap((blk, j) => blk.slice(0, lens[j]))
  const dbits = data.flatMap((w) => Array.from({ length: 8 }, (_, i) => (w >> (7 - i)) & 1))
  const take = (n: number) => dbits.splice(0, n).reduce((x, y) => (x << 1) | y, 0)
  if (take(4) !== 0b0100) throw new Error("not byte mode")
  const len = take(v < 10 ? 8 : 16)
  const bytes = Array.from({ length: len }, () => take(8))
  return { text: new TextDecoder().decode(new Uint8Array(bytes)), ecl, mask, version: v }
}

describe("QR codes", () => {
  test("known vectors: Reed-Solomon for HELLO WORLD 1-M, format and version bits", () => {
    const data = [32, 91, 11, 120, 209, 114, 220, 77, 67, 64, 236, 17, 236, 17, 236, 17]
    expect(Q.rsRemainder(data, 10)).toEqual([196, 35, 39, 119, 235, 215, 231, 226, 93, 23])
    for (const [k, s] of Object.entries(FORMATS)) expect(Q.formatBits(k[0] as "L" | "M", Number(k[1]))).toBe(parseInt(s, 2))
    expect(Q.versionBits(7)).toBe(0b000111110010010100)
    expect(Q.versionBits(10)).toBe(0b001010010011010011)
  })
  test("capacities in byte mode match the standard's table", () => {
    expect([1, 2, 3, 4, 5, 10].map((v) => Q.byteCapacity(v, "M"))).toEqual([14, 26, 42, 62, 84, 213])
    expect([1, 2, 3, 4, 5, 10].map((v) => Q.byteCapacity(v, "L"))).toEqual([17, 32, 53, 78, 106, 271])
  })
  const samples = [
    "https://a.co",
    "https://auth-preview.acme.dev/login",
    "https://github.com/acme/api/pull/12",
    "https://share.crosstalk.dev/s/3f9a1c0e5b7d2468aa01bb02cc03dd04ee05ff06/auth?x=1",
    "https://example.dev/" + "a".repeat(150),
    "https://example.dev/" + "b".repeat(230),
    "https://üñî.example/çodé",
  ]
  for (const s of samples)
    test(`reads back: ${s.slice(0, 50)}${s.length > 50 ? "…" : ""}`, () => {
      const q = Q.encode(s)
      expect(q.size).toBe(q.version * 4 + 17)
      const r = readQr(q.modules)
      expect(r.text).toBe(s)
      expect(r.version).toBe(q.version)
      expect(r.mask).toBe(q.mask)
    })
  test("every mask reads back, at both levels", () => {
    for (const ecl of ["L", "M"] as const)
      for (let mask = 0; mask < 8; mask++) {
        const q = Q.encode("https://billing-preview.acme.dev/", { ecl, mask })
        const r = readQr(q.modules)
        expect([r.text, r.ecl, r.mask]).toEqual(["https://billing-preview.acme.dev/", ecl, mask])
      }
  })
  test("the smallest version: M while it fits, L beyond; too long is an error", () => {
    expect(Q.encode("https://a.co").version).toBe(1)
    expect(Q.encode("x".repeat(213)).ecl).toBe("M")
    expect(Q.encode("x".repeat(250)).ecl).toBe("L")
    expect(() => Q.encode("x".repeat(400))).toThrow(/too long/)
  })
  test("half blocks: two module rows a line, light as a block, a quiet zone round it", () => {
    const q = Q.encode("https://a.co")
    const rows = Q.halfBlocks(q.modules, 2)
    expect(rows.length).toBe(Math.ceil((q.size + 4) / 2))
    expect(rows.every((r) => [...r].length === q.size + 4)).toBe(true)
    expect(rows[0]).toBe("█".repeat(q.size + 4))
    // Row 2 and 3 of the code are the finder's top edge: dark, so the line under the quiet zone starts light then dark.
    expect([...rows[1]].slice(0, 2).join("")).toBe("██")
    expect([...rows[1]][2]).toBe(" ")
    expect(rows.join("").replace(/[█▀▄ ]/g, "")).toBe("")
  })
})

describe("what the phone gets", () => {
  const base = { firstSeen: 1, lastSeen: 1, lastCheck: 0, alive: true, source: "service" as const }
  const local = { ...base, id: "svc:1", url: "http://localhost:4100", kind: "local" as const, label: "auth · web", thread: "auth", name: "auth.localhost" }
  const preview = { ...base, id: "preview:auth:login", url: "https://auth-login.vercel.app", kind: "preview" as const, label: "auth · preview", thread: "auth", source: "preview" as const }
  test("a local URL is this machine's only", () => {
    for (const u of ["http://localhost:3000", "http://127.0.0.1:8080/x", "http://auth.localhost:1355", "http://[::1]:3000", "http://0.0.0.0:5173"]) expect(PH.isLocalUrl(u)).toBe(true)
    for (const u of ["https://acme.dev", "http://192.168.1.4:3000"]) expect(PH.isLocalUrl(u)).toBe(false)
  })
  test("a preview is itself; a local server its share link, else the thread's preview, else nothing", () => {
    expect(PH.phoneTarget(preview, [preview])).toMatchObject({ ok: true, url: preview.url, via: "public" })
    const shared = { ...local, shareUrl: "https://relay.crosstalk.dev/s/abc123" }
    expect(PH.phoneTarget(shared, [shared])).toMatchObject({ ok: true, via: "share", url: "https://relay.crosstalk.dev/s/abc123" })
    expect(PH.phoneTarget(local, [local, preview])).toMatchObject({ ok: true, via: "preview", url: preview.url })
    const none = PH.phoneTarget(local, [local])
    expect(none.ok).toBe(false)
    if (!none.ok) {
      expect(none.text).toContain("needs a share link")
      expect(none.text).toContain("not built yet")
    }
  })
  test("a share link's caption names its host, never its path", () => {
    const q = PH.paneQrFor({ url: "https://relay.crosstalk.dev/s/SECRETKEY", label: "auth · web", via: "share" })
    expect(q.caption).toBe("relay.crosstalk.dev · share link")
    expect(JSON.stringify(q)).not.toContain("SECRETKEY")
    expect(readQr(rowsToModules(q.rows)).text).toBe("https://relay.crosstalk.dev/s/SECRETKEY")
  })
  test("the pane's QR is the session's, and goes stale", () => {
    PH.writePaneQr("sess-q", PH.paneQrFor({ url: "https://a.co", label: "a", via: "public", now: 1000 }))
    expect(PH.readPaneQr("sess-q", 2000)?.label).toBe("a")
    expect(PH.readPaneQr("sess-q", 1000 + PH.QR_TTL_MS + 1)).toBeUndefined()
    expect(PH.readPaneQr("sess-other", 2000)).toBeUndefined()
  })
})

/** The pane's half blocks back to modules (light = block), quiet zone of 2 taken off. */
function rowsToModules(rows: string[]): boolean[][] {
  const lines: boolean[][] = []
  for (const r of rows) {
    const cs = [...r]
    lines.push(cs.map((c) => c === " " || c === "▄"))
    lines.push(cs.map((c) => c === " " || c === "▀"))
  }
  const width = [...rows[0]].length
  const size = width - 4
  return lines.slice(2, 2 + size).map((l) => l.slice(2, 2 + size))
}

// --- history ----------------------------------------------------------------------

const DAY = 86_400_000
const T0 = Date.parse("2026-10-01T10:00:00Z")
const thread = (by = "fp-paul") => M.create({ name: "auth", repo: "github.com/acme/api", by, label: "paul", now: T0 })
const seen = (o: Partial<import("../src/urls/history/links.ts").Seen> & { url: string }) => ({ kind: "link" as const, label: `auth · ${o.url.slice(8, 30)}`, seen: T0, ...o })

describe("a thread's links", () => {
  test("recorded once; seen again within the hour is no edit; later moves last seen", () => {
    const t = thread()
    expect(H.record(t, "fp-paul", seen({ url: "https://auth-preview.acme.dev/login", kind: "preview", label: "auth · preview" }), T0)).toBe(true)
    const l = t.lamport
    expect(H.record(t, "fp-paul", seen({ url: "https://auth-preview.acme.dev/login", kind: "preview", label: "auth · preview", seen: T0 + 60_000 }), T0)).toBe(false)
    expect(t.lamport).toBe(l)
    expect(H.record(t, "fp-paul", seen({ url: "https://auth-preview.acme.dev/login", kind: "preview", label: "auth · preview", seen: T0 + 2 * DAY }), T0)).toBe(true)
    const [x] = H.links(t)
    expect([x.first, x.last]).toEqual([T0, T0 + 2 * DAY])
  })
  test("a local server by its name and path: no port, no query, no fragment", () => {
    expect(H.storedUrl({ url: "http://localhost:4100/login?token=abc#x", kind: "local", name: "auth.localhost" })).toBe("http://auth.localhost/login")
    expect(H.storedUrl({ url: "http://localhost:5173/?code=1", kind: "local" })).toBe("http://localhost:5173")
    expect(H.storedUrl({ url: "https://u:p@acme.dev/cb?page=2#access_token=x", kind: "link" })).toBe("https://acme.dev/cb?page=2")
    // The same server on another port is the same entry.
    const t = thread()
    H.record(t, "fp-paul", seen({ url: "http://localhost:4100/", kind: "local", label: "auth · web", name: "auth.localhost" }), T0)
    H.record(t, "fp-paul", seen({ url: "http://localhost:4200/", kind: "local", label: "auth · web", name: "auth.localhost", seen: T0 + DAY }), T0)
    expect(H.links(t).length).toBe(1)
    expect(JSON.stringify(t.links)).not.toContain("4100")
  })
  test("screenshots are kept with where they were taken", () => {
    const t = thread()
    const u = { url: "https://auth-preview.acme.dev/login", kind: "preview" as const, label: "auth · preview" }
    H.record(t, "fp-paul", seen({ ...u, shot: { path: "/Users/paul/shots/a.png", at: T0, machine: "desk" } }), T0)
    H.record(t, "fp-paul", seen({ ...u, seen: T0 + DAY, shot: { path: "/Users/paul/shots/b.png", at: T0 + DAY, machine: "desk" } }), T0)
    H.record(t, "fp-paul", seen({ ...u, seen: T0 + DAY, shot: { path: "/Users/paul/shots/b.png", at: T0 + DAY, machine: "desk" } }), T0)
    expect(H.links(t)[0].shots?.map((s) => s.path)).toEqual(["/Users/paul/shots/a.png", "/Users/paul/shots/b.png"])
  })
  test("two replicas recording at once both keep theirs, in either order", () => {
    const a = thread("fp-paul")
    const b = M.parseThread(JSON.parse(JSON.stringify(a)))!
    H.record(a, "fp-paul", seen({ url: "https://github.com/acme/api/pull/12", kind: "pr", label: "auth · PR #12" }), T0)
    H.record(b, "fp-marie", seen({ url: "https://auth-preview.acme.dev/", kind: "preview", label: "auth · preview" }), T0)
    const ab = M.merge(a, b)
    const ba = M.merge(b, a)
    expect(M.same(ab, ba)).toBe(true)
    expect(H.links(ab).map((l) => l.kind).sort()).toEqual(["pr", "preview"])
  })
  test("capped: the least recently seen folded into a count, then compacted", () => {
    const t = thread()
    for (let i = 0; i < 12; i++) H.record(t, "fp-paul", seen({ url: `https://acme.dev/p${i}`, seen: T0 + i * DAY }), T0)
    expect(H.cap(t, "fp-paul", T0, 10, 100)).toBe(2)
    expect(H.links(t).length).toBe(10)
    expect(H.links(t).some((l) => l.url.endsWith("/p0"))).toBe(false)
    expect(H.foldedCount(t)).toBe(2)
    // The tombstone keeps no URL, label or screenshot.
    const tomb = Object.values(t.links).find((i) => i.gone)!
    expect([tomb.url, tomb.label, tomb.shots]).toEqual(["", "", undefined])
    // Past the tombstone limit, the oldest become a running count.
    for (let i = 12; i < 20; i++) H.record(t, "fp-paul", seen({ url: `https://acme.dev/p${i}`, seen: T0 + i * DAY }), T0)
    H.cap(t, "fp-paul", T0, 10, 4)
    expect(H.links(t).length).toBe(10)
    expect(H.foldedCount(t)).toBe(10)
    expect(Object.values(t.links).filter((i) => i.gone && i.folded).length).toBeLessThanOrEqual(4)
    // The default cap applies to every record.
    const big = thread()
    for (let i = 0; i < H.MAX_LINKS + 5; i++) H.record(big, "fp-paul", seen({ url: `https://acme.dev/q${i}`, seen: T0 + i * 1000 }), T0)
    expect(H.links(big).length).toBe(H.MAX_LINKS)
    expect(H.foldedCount(big)).toBe(5)
  })
  test("sealed with the rest: no URL readable in the file, read back whole; a file from before links opens", () => {
    const t = thread()
    H.record(t, "fp-paul", seen({ url: "https://auth-preview.acme.dev/login", kind: "preview", label: "auth · preview", shot: { path: "/Users/paul/shots/a.png", at: T0, machine: "desk" } }), T0)
    const key = newKey()
    const text = F.renderSealed(t, key, [])
    expect(text).toMatch(/^links: \S+$/m)
    for (const leak of ["auth-preview", "acme", "shots", "desk", "preview"]) expect(text).not.toContain(leak)
    const p = F.parse(text)
    if (p.kind !== "sealed") throw new Error("not sealed")
    expect(M.same(p.open(key)!, t)).toBe(true)
    const old = F.parse(text.replace(/^links: \S+\n/m, ""))
    if (old.kind !== "sealed") throw new Error("not sealed")
    const o = old.open(key)
    expect(o).not.toBeNull()
    expect(o!.links).toEqual({})
    // A blob moved into the links line does not open as links.
    const moved = text.replace(/^links: \S+$/m, `links: ${/^notes: (\S+)$/m.exec(text)![1]}`)
    const pm = F.parse(moved)
    if (pm.kind !== "sealed") throw new Error("not sealed")
    expect(pm.open(key)).toBeNull()
  })
  test("search: every word, kinds by name, dates", () => {
    const t = thread()
    H.record(t, "fp-paul", seen({ url: "http://localhost:4100/login", kind: "local", label: "auth · web", name: "auth.localhost", seen: T0 }), T0)
    H.record(t, "fp-paul", seen({ url: "https://auth-preview.acme.dev/login", kind: "preview", label: "auth · preview", seen: T0 + 10 * DAY, first: T0 + 10 * DAY }), T0)
    H.record(t, "fp-paul", seen({ url: "https://github.com/acme/api/pull/12", kind: "pr", label: "auth · PR #12", seen: T0 + 3 * DAY, first: T0 + 3 * DAY }), T0)
    const all = H.links(t)
    expect(H.search(all, { query: "login" }).length).toBe(2)
    expect(H.search(all, { query: "the login page preview" }).map((l) => l.kind)).toEqual(["preview"])
    expect(H.search(all, { query: "pull request" }).map((l) => l.label)).toEqual(["auth · PR #12"])
    expect(H.search(all, { query: "login", before: T0 + 5 * DAY }).map((l) => l.kind)).toEqual(["local"])
  })
})

// --- env -----------------------------------------------------------------------

const git = (cwd: string, ...args: string[]) => {
  const r = spawnSync("git", ["-C", cwd, ...args], { encoding: "utf8", env: { ...process.env, GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@t", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@t" } })
  if (r.status !== 0) throw new Error(`git ${args.join(" ")}: ${r.stderr}`)
  return r.stdout.trim()
}
const write = (f: string, s: string, mode = 0o644) => {
  fs.mkdirSync(path.dirname(f), { recursive: true })
  fs.writeFileSync(f, s, { mode })
  fs.chmodSync(f, mode)
}

function makeRepo(name: string) {
  const repo = path.join(TMP, name)
  fs.mkdirSync(repo, { recursive: true })
  git(repo, "init", "-q", "-b", "main")
  write(path.join(repo, ".gitignore"), [".env", ".env.*", "!.env.example", ".dev.vars", "config/*.local.*", "secrets/", "node_modules/", ".env.link", ""].join("\n"))
  write(path.join(repo, ".env.example"), "API_KEY=\n")
  write(path.join(repo, ".crosstalk/env"), ["# more for new worktrees", "secrets/*.pem", "!secrets/skip.pem", "../outside", "/etc/passwd", ""].join("\n"))
  git(repo, "add", ".")
  write(path.join(repo, ".env.production"), "TRACKED=1\n")
  git(repo, "add", "-f", ".env.production")
  git(repo, "commit", "-qm", "init")
  write(path.join(repo, ".env"), "SECRET=hunter2\n", 0o600)
  write(path.join(repo, ".env.local"), "LOCAL=1\n", 0o640)
  write(path.join(repo, ".env.sample"), "x\n")
  write(path.join(repo, ".dev.vars"), "CF=1\n")
  write(path.join(repo, "config/app.local.json"), "{}\n")
  write(path.join(repo, "config/app.json"), "{}\n")
  write(path.join(repo, "secrets/key.pem"), "PEM\n", 0o600)
  write(path.join(repo, "secrets/skip.pem"), "PEM\n")
  write(path.join(repo, "node_modules/pkg/.env"), "NOPE=1\n")
  write(path.join(repo, "apps/web/.env"), "WEB=1\n")
  write(path.join(repo, "apps/web/.gitignore"), "")
  fs.symlinkSync("/etc/hosts", path.join(repo, ".env.link"))
  return repo
}

describe("which local files a new worktree gets", () => {
  const repo = makeRepo("api")
  test("patterns: gitignore-like, a slash anchors, ** spans, nothing with ..", () => {
    expect(SEL.globToRe(".env")!.test("apps/web/.env")).toBe(true)
    expect(SEL.globToRe("config/*.local.*")!.test("config/app.local.json")).toBe(true)
    expect(SEL.globToRe("config/*.local.*")!.test("apps/config/app.local.json")).toBe(false)
    expect(SEL.globToRe("**/certs/*.pem")!.test("a/b/certs/x.pem")).toBe(true)
    expect(SEL.globToRe("**/certs/*.pem")!.test("certs/x.pem")).toBe(true)
    expect(SEL.globToRe("../x")).toBeNull()
    expect(SEL.globToRe("a/../../x")).toBeNull()
    expect(SEL.patterns("../outside\n#c\n!x\n").refused).toEqual(["../outside"])
  })
  test("ignored and untracked only; examples out; a symlink refused; the repo's own patterns; dependency folders not walked", () => {
    const s = SEL.select(repo)
    expect(s.files.map((f) => f.rel)).toEqual([".dev.vars", ".env", ".env.local", "apps/web/.env", "config/app.local.json", "secrets/key.pem"])
    expect(s.refused).toEqual([{ rel: ".env.link", why: "a symlink (never followed)" }])
    expect(s.patternsRefused).toEqual(["../outside"])
    expect(s.files.find((f) => f.rel === ".env")!.mode).toBe(0o600)
  })
  test("copied with their mode, never over what is there, never through a symlinked folder", () => {
    const wt = path.join(TMP, "api-wt")
    git(repo, "worktree", "add", "-q", "-b", "wt", wt)
    write(path.join(wt, ".env.local"), "MINE=1\n")
    fs.symlinkSync(TMP, path.join(wt, "secrets"))
    const r = CP.copyInto({ main: repo, worktree: wt, files: SEL.select(repo).files })
    expect(r.copied.sort()).toEqual([".dev.vars", ".env", "apps/web/.env", "config/app.local.json"])
    expect(r.present).toEqual([".env.local"])
    expect(r.refused).toEqual([{ rel: "secrets/key.pem", why: "a folder on the way is a symlink" }])
    expect(fs.statSync(path.join(wt, ".env")).mode & 0o777).toBe(0o600)
    expect(fs.lstatSync(path.join(wt, ".env")).isSymbolicLink()).toBe(false)
    expect(fs.readFileSync(path.join(wt, ".env.local"), "utf8")).toBe("MINE=1\n")
    expect(fs.existsSync(path.join(TMP, "key.pem"))).toBe(false)
    expect(git(wt, "status", "--porcelain")).toBe("?? secrets")
    // Copying is not done into the main checkout itself.
    expect(CP.copyInto({ main: repo, worktree: repo, files: SEL.select(repo).files }).copied).toEqual([])
  })
  test("a file the worktree's commit does not ignore is not copied there", () => {
    const repo2 = path.join(TMP, "api2")
    fs.mkdirSync(repo2)
    git(repo2, "init", "-q", "-b", "main")
    write(path.join(repo2, "README"), "x")
    git(repo2, "add", ".")
    git(repo2, "commit", "-qm", "init")
    const wt = path.join(TMP, "api2-wt")
    git(repo2, "worktree", "add", "-q", "-b", "wt", wt)
    write(path.join(repo2, ".gitignore"), ".env\n")
    write(path.join(repo2, ".env"), "S=1\n")
    const r = CP.copyInto({ main: repo2, worktree: wt, files: SEL.select(repo2).files })
    expect(r.copied).toEqual([])
    expect(r.refused[0]).toEqual({ rel: ".env", why: "not ignored by git in the worktree" })
  })
})

describe("asked once per repo", () => {
  test("the first worktree asks; the next does not; a yes copies, into new ones too; a no is kept", () => {
    const repo = makeRepo("billing")
    const wt1 = path.join(TMP, "billing-1")
    const wt2 = path.join(TMP, "billing-2")
    git(repo, "worktree", "add", "-q", "-b", "b1", wt1)
    git(repo, "worktree", "add", "-q", "-b", "b2", wt2)
    const first = E.prepare({ main: repo, worktree: wt1, sessionId: "s1" })
    expect(first.copied).toEqual([])
    expect(first.offer?.question).toBe("Copy .dev.vars and 5 other local files into new worktrees of billing? They are gitignored and stay on this machine: never in git, a thread or the relay.")
    expect(JSON.stringify(first)).not.toContain("hunter2")
    expect(E.prepare({ main: repo, worktree: wt2, sessionId: "s2" }).offer).toBeUndefined()
    expect(fs.existsSync(path.join(wt1, ".env"))).toBe(false)
    expect(E.mainForId(first.offer!.id)).toBe(E.keyOf(repo))
    const yes = E.answer({ main: repo, yes: true, worktrees: [wt1] })
    expect(yes.copied[wt1]?.length).toBe(6)
    expect(yes.text).not.toContain("hunter2")
    expect(fs.readFileSync(path.join(wt1, ".env"), "utf8")).toBe("SECRET=hunter2\n")
    // A worktree made after the yes gets them without being asked.
    const later = E.prepare({ main: repo, worktree: wt2 })
    expect(later.copied.length).toBe(6)
    expect(later.offer).toBeUndefined()
    // The answer is kept: a no stops it, and nothing asks again.
    E.answer({ main: repo, yes: false })
    const wt3 = path.join(TMP, "billing-3")
    git(repo, "worktree", "add", "-q", "-b", "b3", wt3)
    expect(E.prepare({ main: repo, worktree: wt3 })).toEqual({ copied: [], state: "no" })
    expect(E.consent(repo)).toBe("no")
  })
  test("a repo with nothing to copy asks nothing", () => {
    const repo = path.join(TMP, "plain")
    fs.mkdirSync(repo)
    git(repo, "init", "-q", "-b", "main")
    write(path.join(repo, "README"), "x")
    git(repo, "add", ".")
    git(repo, "commit", "-qm", "init")
    const wt = path.join(TMP, "plain-wt")
    git(repo, "worktree", "add", "-q", "-b", "w", wt)
    expect(E.prepare({ main: repo, worktree: wt })).toEqual({ copied: [] })
    expect(E.consent(repo)).toBeUndefined()
  })
  test("CROSSTALK_NO_ENV_COPY turns it off", () => {
    process.env.CROSSTALK_NO_ENV_COPY = "1"
    try {
      expect(E.prepare({ main: path.join(TMP, "api"), worktree: path.join(TMP, "api-wt") })).toEqual({ copied: [] })
    } finally {
      delete process.env.CROSSTALK_NO_ENV_COPY
    }
  })
})
