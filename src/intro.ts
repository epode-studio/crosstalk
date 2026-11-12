// What you can say to crosstalk, in plain words: the welcome the first time it
// runs on a machine, and the answer to "what can crosstalk do?".
//
// One list, so the welcome, the answer and the README say the same things.
// Nothing here is a command: each line is something a person says to any agent.

import fs from "node:fs"
import path from "node:path"
import { P } from "./config.ts"
import { LEGEND } from "./ui-extra/pure.ts"

export type Group = { title: string; lines: string[] }

export const THINGS: Group[] = [
  {
    title: "Your sessions",
    lines: [
      `"show me all my agents" — a live list beside the chat: who's working, who's waiting on you`,
      `"what's running?" — the same, as an answer`,
      `"tidy up my sessions" — closes the ones you're not using, folds duplicates into one`,
      `"show me the board" — every thread on one page in your browser: what waits on you, tasks, decisions, PRs`,
      `"work through the open tasks" — agents take the open tasks by themselves, two at a time ("stop working the board" to stop)`,
      `"close billing" · "resume the one where I fixed login" · "call this one payments"`,
      `"park billing" — out of sight until you need it; "unpark billing" brings it back`,
      `"restore them" — after a restart, every session back in its tab`,
      `"make this the main session" — your inbox: questions come there, one at a time`,
      `"plan my day" — the open work, to pick today's few threads; agents take those`,
      `"wrap up for today" / "pick up where I left off" — what shipped, what's open for tomorrow`,
      `"I'm focusing for an hour" — only what stops an agent interrupts; a summary at the end`,
      `"I'm going to bed" / "out for a walk" — do not disturb: everything waits in your inbox, and you hear what happened when you're back`,
    ],
  },
  {
    title: "More hands",
    lines: [
      `"put two more agents on auth" — each in its own copy of the code; four at once at most, the rest wait their turn`,
      `"run the dev server" — it keeps running when the session ends, at auth.localhost`,
      `"show me the auth page before and after"`,
    ],
  },
  {
    title: "Your team",
    lines: [
      `"tell marie the token format changed, with the diff"`,
      `"what's marie working on?" · "ask marie's api session what /devices returns"`,
      `"show marie the auth page" — your running app, only for her`,
      `"mute jo for an hour"`,
    ],
  },
  {
    title: "Your work",
    lines: [
      `"what did we decide about v1?" · "what happened while I was away?"`,
      `"ship it" — reviewed by another agent, behind a flag when it's risky`,
      `a reply that ends with an "Open" list: kept as tasks, and your inbox asks "Carry on?"; crosstalk proposes, you delegate`,
    ],
  },
  {
    title: "When something's off",
    lines: [`"is crosstalk OK?" — checks itself and says what to fix`],
  },
]

/** The whole list, for "what can crosstalk do?". */
export function introText(): string {
  return [
    `Things to say to any session. Nothing to remember: say it in your own words, and when crosstalk needs a choice it asks.`,
    ...THINGS.flatMap((g) => ["", g.title, ...g.lines.map((l) => `  ${l}`)]),
  ].join("\n")
}

/** The short welcome: a handful of lines, once per machine. */
export function welcomeText(): string {
  return [
    `◢ crosstalk is on. Nothing to learn: just say what you want. Try:`,
    `  "show me all my agents"  ·  "tidy up my sessions"  ·  "put two more agents on this"`,
    `  "tell marie what changed"  ·  "restore them" after a restart`,
    `  Tabs and lines show: ${LEGEND}.`,
    `  "what can crosstalk do?" for the rest.`,
  ].join("\n")
}

const marker = () => path.join(P.root, "welcomed")

/** The welcome, the first time on this machine; null after. */
export function welcomeOnce(): string | null {
  try {
    if (fs.existsSync(marker())) return null
    fs.mkdirSync(P.root, { recursive: true, mode: 0o700 })
    fs.writeFileSync(marker(), new Date().toISOString(), { mode: 0o600 })
    return welcomeText()
  } catch {
    return null
  }
}
