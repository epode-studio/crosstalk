// Snapshots of what crosstalk's mod draws: the trees mod/draw.tsx returns,
// laid out as text frames by ./render.ts, against the files in
// ./__snapshots__/. Each file is the frame as plain text and its styled runs,
// so a change to the pane or a card shows as a readable diff.
//
//   bun test test/snapshots/mod.test.ts
//   UPDATE_SNAPSHOTS=1 bun test test/snapshots/mod.test.ts    write them anew
//
// Covered: message cards with and without attachments at 60 and 120 columns;
// the thread pane with every section (status, people, recap, QR, waiting,
// notes, features, running with servers, previews, PRs, what is shown to
// people, links and screenshots, recent, history) in light and dark; the
// pane while it loads; the status line; the band of questions crosstalk asks.

import { describe, expect, test } from "bun:test"
import fs from "node:fs"
import path from "node:path"
import { ELS, frame, h, type Theme } from "./render.ts"
import { statusLine } from "../../src/ui-extra/pure.ts"
import type { Item, Pane } from "../../mod/types/index.d.ts"
;(globalThis as any).h = h
const D = await import("../../mod/draw.tsx")

const DIR = path.join(import.meta.dir, "__snapshots__")
const UPDATE = process.env.UPDATE_SNAPSHOTS === "1"

/** Compare with the stored snapshot, or write it with UPDATE_SNAPSHOTS=1 (and when there is none yet). */
function snapshot(name: string, text: string) {
  const file = path.join(DIR, `${name}.txt`)
  if (UPDATE || !fs.existsSync(file)) {
    fs.mkdirSync(DIR, { recursive: true })
    fs.writeFileSync(file, text)
    if (!UPDATE && process.env.CI) throw new Error(`no snapshot ${name} yet; run with UPDATE_SNAPSHOTS=1 and commit it`)
    return
  }
  expect(text).toBe(fs.readFileSync(file, "utf8"))
}

const NOW = Date.parse("2026-11-02T10:00:00Z")
const MIN = 60_000
const HOUR = 60 * MIN

const card = (o: Partial<Item>): Item => ({ id: "msg:1", kind: "message", sessionId: "s1", state: "pending", createdAt: NOW, updatedAt: NOW, from: "marie", thread: "auth", text: "Token format changed to v2. v1 accepted until 0.2", ts: NOW - 2 * MIN, ...o })

const CARDS: Record<string, Item[]> = {
  "card-plain": [card({})],
  "card-attachments": [
    card({
      chips: [
        { kind: "diff", label: "src/auth/token.ts +42 −18", bytes: 3_400 },
        { kind: "file", label: "docs/tokens.md", bytes: 1_250_000 },
      ],
    }),
    card({ id: "msg:2", kind: "ask", from: "jo", thread: "billing", text: "can billing read v2 tokens yet, or should we wait for the parser change to land first?", ts: NOW - 40 * MIN, raisedAt: NOW - 5 * MIN, chips: [{ kind: "turns", label: "last 6 turns", bytes: 900 }] }),
  ],
}

const QUESTIONS: Item[] = [
  { id: "ship:1", kind: "ship", sessionId: "s1", state: "pending", createdAt: NOW, updatedAt: NOW, thread: "auth", question: "Turn auth-v2-tokens on for your own accounts? Errors held at 0 for an hour in the dark launch." },
  { id: "restore:1", kind: "restore", sessionId: "s1", state: "pending", createdAt: NOW, updatedAt: NOW, count: 6 },
  { id: "thread:1", kind: "thread", sessionId: "s1", state: "pending", createdAt: NOW, updatedAt: NOW },
  { id: "rule:1", kind: "rule", sessionId: "s1", state: "pending", createdAt: NOW, updatedAt: NOW, raisedAt: NOW - MIN },
  { id: "attn:ctx:1", kind: "attention", sessionId: "s1", state: "pending", createdAt: NOW, updatedAt: NOW, from: "api", question: "api's context is 91% spent. Start fresh from auth?" },
  { id: "route:1", kind: "route", sessionId: "s1", state: "pending", createdAt: NOW, updatedAt: NOW, from: "ben" },
  { id: "doctor:1", kind: "doctor", sessionId: "s1", state: "pending", createdAt: NOW, updatedAt: NOW, question: "crosstalk found the relay unreachable: run /crosstalk:doctor" },
  { id: "invite:1", kind: "invite", sessionId: "s1", state: "pending", createdAt: NOW, updatedAt: NOW, text: "3644-cherry-horn-cataract-redwing" },
]

const QR_ROWS = ["█▀▀▀▀▀█ ▄▀▄ █▀▀▀▀▀█", "█ ███ █ ▀█▀ █ ███ █", "█ ▀▀▀ █ █▄▀ █ ▀▀▀ █", "▀▀▀▀▀▀▀ ▀ ▀ ▀▀▀▀▀▀▀"]

const PANE: Pane = {
  thread: "auth",
  status: "active",
  repo: "github.com/acme/api",
  recap: "Moving tokens to v2 format; v1 kept for one release.",
  people: ["paul", "marie"],
  sessions: 2,
  waiting: ["keep the v1 endpoint? (blocking)", "jo asks: can billing read v2 yet?"],
  notes: [
    { kind: "task", text: "remove the v1 parser after 0.2", state: "open" },
    { kind: "task", text: "write the migration note", state: "claimed", who: "marie" },
    { kind: "decision", text: "v1 tokens accepted until 0.2", who: "paul", at: NOW - 3 * HOUR },
    { kind: "fact", text: "staging DB is shared with the demo env", who: "marie", at: NOW - 26 * HOUR },
    { kind: "rule", text: "always keep one release of overlap", who: "paul", at: NOW - 3 * 24 * HOUR },
  ],
  recent: [
    { from: "jo", text: "can billing read v2 yet?", ts: NOW - MIN },
    { from: "marie", text: "token format changed to v2", ts: NOW - 2 * MIN },
  ],
  features: [
    { name: "v2 token format", risk: "risky", flag: "auth-v2-tokens", stage: "internal", state: "merged" },
    { name: "tidy token parser", risk: "everyday" },
  ],
  running: [
    { kind: "server", label: "auth · web", url: "http://auth.localhost:1355", raw: "http://localhost:4100", ports: [4100], alive: true, owner: "you", thread: "auth" },
    { kind: "server", label: "worker", alive: false, owner: "you", broken: "exited with status 1" },
    { kind: "preview", label: "auth · preview", url: "https://auth-pr-12.vercel.app", alive: true, owner: "you" },
    { kind: "pr", label: "auth · PR #12", url: "https://github.com/acme/api/pull/12", alive: false, owner: "you" },
    { kind: "share", label: "auth · web", alive: true, owner: "you", with: ["marie"], until: NOW + 7 * HOUR },
    { kind: "share", label: "billing · web", url: "http://billing.jo.localhost:1355", alive: true, owner: "jo", until: NOW + 2 * HOUR },
    { kind: "link", label: "auth · acme.dev/cb", url: "https://acme.dev/cb?page=2", alive: true, owner: "you" },
    { kind: "screenshot", label: "auth · web", path: "/login", alive: true, owner: "you", before: { file: "/Users/paul/.claude/crosstalk/shots/auth-login-before.png", at: NOW - 20 * MIN }, after: { file: "/Users/paul/.claude/crosstalk/shots/auth-login-after.png", at: NOW - MIN } },
  ],
  history: [
    { kind: "pull request", label: "auth · PR #9", at: NOW - 3 * 24 * HOUR, url: "https://github.com/acme/api/pull/9" },
    { kind: "fact, corrected", label: "tokens expire after 1h", at: NOW - 5 * 24 * HOUR },
    { kind: "task, done", label: "add the v2 parser", at: NOW - 2 * 24 * HOUR },
  ],
  qr: { label: "auth · preview", caption: "https://auth-pr-12.vercel.app", rows: QR_ROWS, at: NOW },
}

const raisable = (it: Item) => it.raisedAt === undefined

describe("message cards", () => {
  for (const [name, list] of Object.entries(CARDS))
    for (const cols of [60, 120])
      test(`${name} at ${cols} columns`, () => {
        snapshot(`${name}-${cols}`, frame(`${name} · ${cols} cols`, D.bandTree(ELS, list, "", NOW, cols, raisable), cols, "dark"))
      })
  test("a card follows the theme: frame, sender and thread are theme keys", () => {
    const light = frame("card", D.bandTree(ELS, CARDS["card-plain"]!, "", NOW, 60, raisable), 60, "light")
    snapshot("card-plain-60-light", light)
    expect(light).toContain("fg=inactive:#666666")
    expect(light).toContain("fg=claude:")
    expect(light).toContain("fg=suggestion:#5769f7")
  })
})

describe("the thread pane", () => {
  for (const theme of ["light", "dark"] as Theme[])
    test(`every section, ${theme}`, () => {
      snapshot(`pane-${theme}-60`, frame(`pane · ${theme} · 60 cols`, D.paneTree(ELS, PANE, "", NOW, undefined, { expanded: true }), 60, theme))
    })
  test("every section, dark, 120 columns", () => {
    snapshot("pane-dark-120", frame("pane · dark · 120 cols", D.paneTree(ELS, PANE, "", NOW, undefined, { expanded: true }), 120, "dark"))
    // What a thread's pane shows to begin with: what is open and running; the rest behind "more".
    snapshot("pane-collapsed-60", frame("pane · collapsed · 60 cols", D.paneTree(ELS, PANE, "", NOW), 60, "dark"))
  })
  test("while it loads, and when it cannot show the thread", () => {
    snapshot("pane-loading", [frame("pane · loading", D.paneTree(ELS, null, "", NOW), 60, "dark"), frame("pane · no thread", D.paneTree(ELS, null, 'no thread called "nope"', NOW), 60, "dark")].join("\n"))
  })
})

describe("the band", () => {
  for (const theme of ["light", "dark"] as Theme[])
    test(`the questions crosstalk asks, and the digest's line, ${theme}`, () => {
      snapshot(`band-questions-${theme}`, frame(`band · ${theme} · 100 cols`, D.bandTree(ELS, QUESTIONS, "◢ yesterday: 2 decisions, 1 merge in 2 threads · say \"what happened?\" for the digest", NOW, 100, raisable), 100, theme))
    })
})

describe("the status line", () => {
  test("its forms", () => {
    const server = { kind: "server" as const, label: "auth · web", url: "http://auth.localhost:1355", alive: true, owner: "you" }
    const cases: [string, Parameters<typeof statusLine>[0]][] = [
      ["a thread, one server, one waiting", { threads: ["auth"], running: [server], waiting: 1 }],
      ["two threads, three things running", { threads: ["auth", "tokens"], running: [server, { ...server, kind: "preview", url: "https://p.dev" }, { ...server, label: "api" }], waiting: 0 }],
      ["no thread: what the cards are about", { threads: [], cards: ["billing"], waiting: 2 }],
      ["no thread and no card: the repo", { threads: [], repo: "api", label: "paul", waiting: 0 }],
      ["the watch said where", { threads: ["auth"], where: "auth.localhost:1355", waiting: 0 }],
      ["the main session", { threads: ["auth"], waiting: 1, main: { sessions: 3, threads: 2, waiting: 5 } }],
      ["nothing waiting, nothing running", { threads: ["auth"], waiting: 0 }],
    ]
    snapshot("status-line", cases.map(([what, o]) => `${what}\n  ${statusLine(o) ?? "(no status line)"}`).join("\n") + "\n")
  })
})

describe("main's inbox", () => {
  const NOW0 = Date.parse("2026-11-10T12:00:00Z")
  const it = (o: Partial<Item>): Item => ({ id: "x", kind: "attention", sessionId: "main", state: "pending", createdAt: NOW0 - 5 * 60_000, updatedAt: NOW0, ...o }) as Item
  const ROWS: Item[] = [
    it({ id: "attn:perm:s1", question: "Allow api to run `npm install`?", thread: "api", options: ["Allow", "Deny"], createdAt: NOW0 - 60_000 }),
    it({ id: "attn:merge:u1@1", question: "auth · PR #12 is green and approved. Merge it?", thread: "auth", text: "Checks passed 3 min ago.", options: ["Merge it", "Not yet", "Always merge my green PRs"] }),
    it({ id: "msg:1", kind: "message", from: "marie", thread: "billing", text: "token format changed, see the diff", createdAt: NOW0 - 3 * 3_600_000 }),
  ]
  // A press is the engine's: here a Button is drawn as its hotkey and label, as the terminal's plain one reads.
  const asText = (n: any): any =>
    Array.isArray(n) ? n.map(asText) : n && typeof n === "object" && n.type === "Button"
      ? { type: "Text", props: { dimColor: n.props.dimColor, children: [n.props.hotkey ? `${n.props.hotkey}: ` : "", ...asText(n.props.children ?? [])] } }
      : n && typeof n === "object" && n.props ? { ...n, props: { ...n.props, children: asText(n.props.children ?? []) } } : n
  const noop = { open: () => {}, choose: () => {}, snooze: () => {}, done: () => {} }
  const E = { ...ELS, Button: "Button" }

  test("one row each, most pressing first; the open one shows its context and choices on 1 to 4, s and e", () => {
    const tree = D.inboxTree(E, ROWS, undefined, NOW0, noop)
    snapshot("inbox-dark-70", frame("inbox · dark · 70 cols", asText(tree), 70, "dark"))
    const open = frame("inbox · second open", asText(D.inboxTree(E, ROWS, "attn:merge:u1@1", NOW0, noop)), 100, "dark")
    expect(open).toContain("1: Merge it")
    expect(open).toContain("s: snooze")
    expect(open).not.toContain("e: done") // done only dismisses a message; on a question it would answer it
    expect(frame("inbox · empty", D.inboxTree(E, [], undefined, NOW0, noop), 70, "dark")).toContain("Nothing needs you.")
  })

  test("a press answers through the actions it is given", () => {
    const seen: string[] = []
    const on = { open: (id: string) => seen.push(`open ${id}`), choose: (_: Item, c: string) => seen.push(`choose ${c}`), snooze: () => seen.push("snooze"), done: () => seen.push("done") }
    const buttons: any[] = []
    const walk = (n: any) => (Array.isArray(n) ? n.forEach(walk) : n && typeof n === "object" && n.props ? (n.type === "Button" && buttons.push(n), walk(n.props.children ?? [])) : null)
    walk(D.inboxTree(E, ROWS, undefined, NOW0, on))
    for (const b of buttons) b.props.onPress({})
    // A permission: only its own answers, never snoozed or dismissed past its deadline.
    expect(seen).toEqual(["open attn:perm:s1", "choose Allow", "choose Deny", "open attn:merge:u1@1", "open msg:1"])
    expect(buttons.filter((b) => b.props.hotkey).map((b) => b.props.hotkey)).toEqual(["1", "2"])
  })
})
