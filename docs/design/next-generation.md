# The next generation

Status: decided in an interview on 2026-11-01, and built as a first version on
2026-11-02. Where each part lives, and what has not yet been checked in real use,
is in [Built](#built) at the end.

## In two sentences

**You say what you want, and you answer questions.** Everything else is agents
working in threads with the people you trust.

## The problem this fixes

A room today belongs to an identity, not to a session. When a message arrives,
`pickSession()` in `src/daemon.ts` delivers it to the session the sender named,
or else to whichever local session is idle, or any live one, or the first one
ever registered. The message's subject plays no part. So with api, firmware and
docs open, a note about the auth token format lands in whichever is idle: the
right person, the wrong chat.

And crosstalk can only talk to sessions you already started. It cannot start
one, reopen one, or bring a question from one to where you are looking.

## Three nouns

Everything a person meets is one of three things. Everything else is machinery,
named only in "how it works".

| Noun | What it is |
|---|---|
| **People** | Everyone you trust: your repos' collaborators, your own machines, and anyone outside your repos you verified with four words. |
| **Threads** | A piece of work. It knows things, it has features to ship, and it has things running and places to look. |
| **Questions** | The only way crosstalk asks anything of a person: one mechanism, answered with a picker, a typed `@thread`, or plain words. |

**Inside a thread**, four parts, and no others:

| Part | Holds | Was |
|---|---|---|
| **Notes** | What the thread knows, one list with kinds: decision, fact, task, rule, recap | decisions, facts, tasks, rules, recaps |
| **Features** | What ships: risk, flag and stage, evidence, review | features |
| **Running** | What it runs and where to look: servers, links, previews, PRs, shares, screenshots | services, URLs, previews, PRs, shares, screenshots, ports |
| **History** | Everything it once had in Running and Notes, searchable | links history |

**Machinery** (never a noun in the UI): sessions and workers, worktrees and
ports, the proxy, the relay, keys, flags providers, reviewer agents, the main
session. People say "put two more on auth", not "spawn a session".

**Messages** are what people say to each other in a thread. They are not a
fourth noun: a message either informs (read it when you like) or asks (it is a
question).

**Rooms are gone.** The four words remain for people outside your repos.

**Eight tools**, each with an action, instead of one per feature:

| Tool | For |
|---|---|
| `thread` | read a thread; add a note; change a feature or status; move or leave |
| `say` | tell or ask people; reply; hand a message to the agent |
| `work` | start, stop, resume, background, rename workers; start and stop servers |
| `look` | what's running and where: links, open, screenshots, share, QR, history |
| `ship` | ready, review, evidence, flags, incidents |
| `people` | trust, mute, join with words, link machines |
| `answer` | answer a question |
| `doctor` | what is wrong and how to fix it |

Every tool description is loaded into every session on every turn, so fewer,
broader tools cost less context and are easier for an agent to choose between.

## Principles

- **Native to the code CLI.** No app, no TUI, no dashboard, no tmux. Plugin,
  hooks, MCP and one daemon. You drive it in plain language from any session.
- **Nothing to remember.** No command, prefix or syntax is ever required.
  Every choice crosstalk needs comes with its options as buttons or Claude
  Code's own picker; everything else you say in plain words to any agent.
  `@` shortcuts exist for people who like them, and nothing depends on them.
- **Nothing to start.** No app or multiplexer to launch first, no room to
  create, no command to remember. You open an ordinary session in whatever
  terminal you use, and everything grows out of it. Anything that needs a step
  before you can work is a design bug: it is what was wrong with rooms, and
  what is wrong with herdr, where every terminal has to live inside it.
- **Automatic before explicit.** You never say which thread or session
  something belongs to. When crosstalk is unsure, it asks once and remembers.
- **Nobody reads code.** People decide what should happen and judge whether it
  did. Agents write the code, and other agents review it.
- **One place.** The thread file is the only state. Everything you see is read
  from it.

## People

**There is no join step.** The repository already knows your team:

- **Collaborators are trusted automatically.** The first time you open a
  session in a repo, crosstalk reads its collaborators from the host and their
  published SSH keys (`github.com/<user>.keys`). Messages are sealed to those
  keys. Nobody types or reads anything.
- **Four words, only for people outside the repo**, such as a contractor or a
  friend on another project. Read aloud once, fingerprints crossing over, as
  today.
- **Your own machines link themselves.** Each machine has its own key, listed
  on your account. Every key on your account is you. Nothing is copied
  between machines.

The cost: for collaborators you trust the host not to swap a key to put itself
in the middle. It still cannot read anything on its own. If a collaborator's
key ever changes, that is a question to you, not something accepted silently.

Either way a person ends up **verified**, and that is the only level there is:
verified people in a thread can do anything in it. There is no ladder.

You can **mute** a person or a thread. Nothing else about who may interrupt you
needs configuring, because interruptions follow the question rule below.

A verified person's words still always arrive as data, never inside your turn
(see `DECISIONS.md`). Being verified decides what they can do, not how their
text is presented to your agent.

This is a clean break: existing rooms are not converted. Collaborators need
nothing; anyone outside a shared repo is verified again with four words.

**Bots** (decided): a member that declares itself an agent (`--agent`) can
post to threads and rooms, and nothing more. It never starts or resumes a
session on anyone's machine (spawn, gather, restore and shipping refuse to act
for it), never answers a question (its answers, in a reply or written into a
thread, are not taken, and its rules are ignored), and is never above notify.
See `src/ui-extra/bots.ts`.

## Threads

**A thread is one file**, `<name>.md` on the thread ref (below):

```
---
status: active          # active · waiting · done · archived
people: [paul, marie]
files: [src/auth/**, src/api/tokens.ts]
branches: [token-v2]
features:
  - name: v2 token format
    risk: risky
    flag: auth-v2-tokens     # provider, at internal
  - name: token expiry banner
    flag: token-expiry-ui    # built-in, at 100%
  - name: tidy token parser  # everyday, shipped on merge
---

## Recap
Moving tokens to v2 format; v1 kept for one release.

## Questions
- keep the v1 endpoint? (blocking)

## Decisions
- 2026-11-01 · paul · v1 tokens accepted until 0.2

## Facts
- staging DB is shared with the demo env

## Tasks
- [ ] remove v1 parser after 0.2
```

Today's separate facts, tasks and decisions are sections of this file. The
statusline, the opening banner, the session name, the digest and the PR
description are all read from it.

**Sealed unless marked public.** The file is committed encrypted to the
thread's people, so it is private even in a public repo. Mark a thread public
to commit it in plain text.

**Threads live on their own git ref, `refs/crosstalk/threads`,** never checked
out. Git syncs and versions them, but they never appear in your working tree,
main's history or a PR, so the repo does not bloat. crosstalk adds the refspec
so a fetch brings them. When a thread closes, it is squashed to its decisions,
and old revisions are left for git to collect.

**A readable summary for public threads.** `THREADS.md` in the tree lists each
public thread in a line or two: status, people, open questions, latest
decision. It is rewritten only when a public thread's status changes, so people
browsing the repo, and agents without crosstalk, can see what is going on.
Sealed threads never appear in it.

**Sync: live over the relay, committed on change.** Updates reach the thread's
people at once over the relay. The thread ref gets a commit only when status,
features, decisions or questions change.

**Threads find their sessions.** Nobody names a thread or binds a session.
crosstalk matches sessions to threads by the files they touch and their repo and
branch. When those are ambiguous, a recap of the session is written at the end
of its turn to settle it. Still unsure means a question. A session can be in
any number of threads.

**Threads find their people.** When your session starts a thread, a verified
person's session working on the same thing joins it without a prompt. Nobody
unverified can be pulled in.

**Talking is per thread.** "Tell marie the token format changed" goes to the
threads this session is in, and reaches only Marie's sessions in those same
threads.

**Threads fade and combine.** A thread nobody touches for a while archives, and
comes back with new activity. Two threads that turn out to be the same work
combine into one, even if their people differ, and everyone is told who can now
read what.

You see a session's threads in the statusline (`◢ auth · tokens  2 people`),
in one line when the session opens, and in the session's name.

**First build** (`src/threads/`). Where it settled something this section left
open:

- *The default branch is not a thread.* "Same repo and branch, same thread"
  holds on work branches; on main the files decide, and three new files in one
  folder start a thread named after it.
- *Merging.* Sections merge on their own: meta and recap last-writer-wins on a
  Lamport clock, every list as a set of items with last-writer-wins per item
  and tombstones. Two people appending a decision at once both keep theirs.
- *Keys.* One random key per thread, each section sealed with it separately;
  the key is wrapped per person under the pairwise channel key. Room members
  without a direct channel cannot be wrapped for yet.
- *THREADS.md* is written only for repos with a public thread, and left as an
  unstaged change.
- *Squash* is of content (an archived thread keeps decisions, features and
  rules); the ref's history is not rewritten, since that would need a forced
  push.

## Questions

**Everything crosstalk asks of a person is a question**, with options and a
default:

- something is unclear about what you asked for
- a message arrived and no open session is in its thread (`[resume / new / hold]`)
- the author and reviewer agents disagree
- an agent wants to lower a feature's risk
- a risky feature has evidence ready, or its flag is ready for the next step
- two threads are about to combine

There is no separate approval step. Answering is approving.

**One rule decides where a question shows up:**

| The asker is | You are | It appears |
|---|---|---|
| blocked | in a session | shown to you in that session, hidden from its agent |
| blocked | away | on your phone |
| not blocked | anywhere | in the digest at the next pause |

The statusline always shows how many are waiting. The answer goes back to
whoever asked. Whether a question has been answered is kept by the daemon, not
the session, so it survives a restart or `--resume`.

**A question never enters another thread's context.** A question from auth
shown while you are in firmware is for you, not for the firmware agent. It
appears in crosstalk's **mod**, Claude Code's plugin UI (a band above the
prompt, a status line, toasts), which you see and the model does not. You
answer by picking an option or pressing a key on the card. Typing `@auth y` is
an optional shortcut the mod takes before it becomes a prompt. The mod also takes incoming peer messages so the model never reads
them. Where mods are unavailable, a `UserPromptSubmit` hook blocks the `@`
prompt instead, which keeps it from the model but still leaves it in the
transcript file.

**Proven by the spike** (`spike/mod/README.md`, Claude Code 2.1.316): the mod's
status line, band, toasts, typed `@thread` answers, band buttons and consumed
peer messages reach neither the model, the transcript file, prompt history nor
a resumed session. Three rules follow from what did leak:

- Answers go through the band or a typed `@thread`, never a slash command,
  whose typed line lands in prompt history.
- `$.ui.log` is written to the transcript file, so it never carries question or
  message text.
- The fallback prefix must not be one Claude Code already claims: `!` runs as a
  shell command and puts the text in the model's context. Otherwise the fix for
cross-talk would bring it straight back.

**"In a session" means the one you are looking at.** The last session you
typed in is not necessarily that one, so crosstalk asks the terminal (see
below). Where the terminal cannot say, it falls back to the last session you
typed in, and the statusline badge in every session covers the gap.

### The terminal

crosstalk drives your terminal app through a small adapter per terminal, chosen
from `$TERM_PROGRAM`. It matches a tab to a session by the process id or tty in
the session registry.

| Terminal | Open a tab | Knows which tab is in front |
|---|---|---|
| iTerm2 | AppleScript / Python API | yes |
| kitty | `kitty @ launch --type=tab` | yes, `kitty @ ls` |
| WezTerm | `wezterm cli spawn` | yes, `wezterm cli list-clients` |
| tmux, inside any terminal | `tmux new-window` | yes |
| Terminal.app | AppleScript (`do script`; tabs need Accessibility) | yes, by matching `tty of tab` |
| Windows Terminal | `wt -w 0 nt` | no |
| Ghostty, VS Code terminal | limited | limited |

**Terminal.app comes first**, because it is what we use. It has no tab colour
or badge escape codes, but its AppleScript can set a tab's background colour
and settings profile, and read each tab's tty, which is enough to show status
per tab and to know which session is in front. Opening a tab in an existing
window needs Accessibility permission; without it, a new window.

Terminals that can do neither get a desktop notification with the command to
paste. On macOS, AppleScript needs a one-time Automation permission.

**crosstalk never takes focus on its own.** It opens or focuses a tab only when
you ask, or when you click a notification.

### Focus-aware, plus a main session

- **By default, focus-aware.** A question goes to the tab you are looking at,
  hidden from its agent as above. A desktop notification names the asking
  thread, and clicking it jumps to that session's tab.
- **A main session, when you want one.** Any session becomes main when you say
  so ("make this my main session"). Nothing new is launched. From then
  on it only coordinates: it leaves its threads, so cross-cutting talk never
  mixes with code work, and its context is threads, people and questions. It
  gets the sidebar pane, and it is where you wrangle every session from.

**With a main session open, working sessions only ask about their own
thread.** Everything that cuts across threads goes to main instead: questions
from other threads, unmatched messages, threads about to combine, a key that
changed. A working session's band shows only what its own agents are waiting
on. Closing main sends everything back to focus-aware.

## Messages are UI

Through the mod, everything crosstalk shows is UI you act on, not text in the
chat.

**A message is a card** in the band above your prompt:

```
╭─ ◢ marie · auth ─────────────────────────────── 2m ─╮
│ Token format changed to v2. v1 accepted until 0.2   │
│ ▸ diff  src/auth/token.ts  +42 −18                  │
╰─────────────────────────────────────────────────────╯
```

**The card shows; the picker acts.** Keys on the band only work after
ctrl+x tab focuses it, and that is something to remember, so the card carries
no keys. Instead, when your prompt is empty and the session idle, the card's
actions come up as Claude Code's picker, numbered on screen:

```
◢ marie · auth
  ❯ 1 Hand to agent
    2 Reply
    3 Open thread
    4 More…           → Mute / Later
```

Claude Code's picker takes four options, so Mute and Later sit one step
further, behind More….

If you are busy, the card waits in the band and the picker comes when you
stop. Saying "hand marie's message to the agent" works too. Handing it over
gives the agent the message and its attachments as data and starts a turn, so
you see it act on it.

Your agent reads nothing until you hand it over. A message about this session's own thread goes to
the agent automatically, and the card says so. Attachments (a diff, a file, a
few turns) are chips with a label and size, fetched only when opened.

**A question is Claude Code's own picker**, so it feels native:

```
◢ api-worker · auth asks
  Keep the v1 endpoint for one more release?
  ❯ Yes, until 0.2
    No, remove it now
    Open the thread
```

**The status line** is one glance, in plain text, since the status line takes
no colour or links: `auth · tokens · marie, jo · 2 waiting`. Colour and links
live in the band and the pane.

**The pane** shows a thread: status, people, what is waiting, the latest
decision, recent messages. It opens as a sidebar by itself on terminals 144
columns or wider. Narrower, it opens when you ask ("show me auth"), docked from
110 columns, above the prompt below that.

**Toasts** carry what needs no action: "jo joined auth", "rule applied".

Outside Claude Code, the tab's colour shows something is waiting, and a desktop
notification takes you there.

**Proven** (`spike/mod/README.md`, M2): picker questions and answers, cards
that are shown or muted, and the pane reach neither the model, the transcript,
history nor a resumed session. A card reaches the model only once handed over.

Rules from the spike:

- A picker takes over the keyboard, so it only comes up when the prompt is
  empty and the session idle, and is never raised again by itself after a
  restart.
- The picker's header holds 12 characters, so "api-worker · auth asks" goes in
  the question text.
- Whether a card was handed over, muted or answered is kept by the daemon, so
  nothing comes back twice after a restart.

## Answers become rules

The second time you give the same answer to the same kind of question,
crosstalk asks once more: "Always do this?" Yes makes it a **standing rule**,
and it never asks that again. The number of questions should shrink every week;
that is the metric.

Rules are **repo-wide from the start**, kept in one file on the thread ref.
A rule takes effect for the whole team at once and shows up once in each
teammate's digest. Anyone can change or undo it, and that is announced too.

## Agents talk without being told

When an agent changes a file, function, API or schema that another thread's
footprint includes, that thread's agent hears about it, with the diff attached.
No person is involved unless the agent receiving it needs a decision.

**Conflicts are agreed before they happen.** When two threads edit the same
function before either has merged, both agents are told at once. They agree who
changes what, or one rebases onto the other, and record it as a decision in
both threads. A person is asked only if they cannot agree.

## Getting someone on it

There is one idea: **get someone on it**. Whether that means steering a session
that is already open, resuming yesterday's, or starting a new one in the
background is crosstalk's choice. If the choice matters, it is a question.
Fanning out is starting several features at once.

Routing to the right open session ships first, since that is today's bug.
Everything else builds on the same matching.

**Sessions are disposable.** The thread file carries the work, so instead of
letting a session compact again and again, crosstalk ends it when its context
is spent and starts a fresh one from the thread.

**Staffing is a suggestion.** "auth has been stuck for 2 hours, add a second
agent?" is a question. There are no budgets to set or watch.

**Restarts restore themselves.** crosstalk remembers every open session's id,
folder and terminal tab. After a restart, crosstalk sees that sessions were
open and none of them ended normally. The first session you open asks once:
"Restore your 6 sessions from before the restart?" Yes reopens each one in its
own tab, in the same order, as `claude --resume <id>` in its folder, so the
conversation comes back whole. Sessions crosstalk started in the background
resume by themselves.

A session crosstalk starts has the permissions of whoever caused it. A verified
person's message can get a session on it on your machine. When nothing open
fits, you are asked first.

## Wrangling every session

What herdr and Superset give you is one place to see and steer every session.
Here that place is **whichever session you are in**. Any session can:

- list every session, its threads, and whether it is working, done or waiting on you
- steer one ("tell the api one to stop"), or get more on a thread ("put two more on auth")
- receive questions from all of them, by the question rule

The statusline in every session shows how many are waiting on you. There is no
home session and no window.

Steering is plain language ("stop the api one", "put two more on auth") or
buttons in the pane. Saying it to the current agent puts it in that agent's
context, which is fine: it is your request, in your session. The optional `@`
shortcuts (`@api stop`) go through the mod and never reach the agent.

## The terminal is the app

Superset (now [Paradev](https://paradev.com/)) and herdr are apps for running
many agents at once: a sidebar of agents, their status, worktrees, launching,
notifications. Your terminal already has tabs, titles, colours, badges and
notifications. crosstalk drives them, so the terminal *becomes* the app.

| Paradev | Your terminal, driven by crosstalk |
|---|---|
| Sidebar of agents | Your tabs, one per thread, named after it |
| Working / blocked / waiting | Tab colour, badge and progress indicator |
| Agent needs you | Desktop notification; clicking it focuses the tab |
| Launch an agent | A new tab running your harness in its own git worktree |
| Workspaces | One window per repo, one tab per thread |
| Open in IDE | "open auth in my editor", or a button in the pane |
| Phone app | Phone push for blocking questions, plus Claude's remote control |
| Remote machines | Your linked machines |
| Diff viewer | Left out on purpose: nobody reads code; you get evidence instead |

**Full layout.** crosstalk arranges the windows itself: a window per repo, tabs
in thread order, a tab opened when a thread gets a session, closed when the
thread is done. It still never takes focus on its own.

**Your terminal, not ours.** Your own sessions stay in whatever terminal you
opened them in. crosstalk adapts to it through the adapters above and never
asks you to move into tmux or anything else.

**tmux, invisibly.** Sessions crosstalk starts for you run in a tmux server it
keeps in the background. They survive closing your window, which is herdr's
real benefit, without its launch step. You never attach unless you want to
watch one, and "show me auth" does that for you, in a new tab of your own
terminal. On a linked machine the same background server holds its sessions.

**If you already live in tmux**, crosstalk uses it directly, with full layout,
through tmux's own window options (`rename-window`, `window-status-style`)
rather than escape codes, which tmux does not pass through reliably. Full
layout in other terminals starts with those that have real APIs (iTerm2,
kitty, WezTerm).

Outside tmux, status is written as escape codes to the session's own tty, found
from the process id in the session registry. Status comes from crosstalk's own
hooks. OSC 7501, the Program Status Protocol Claude Code can speak, only flows
once the terminal answers its query, and almost no terminal does yet.

**To test first:** whether Claude Code overwrites a tab or window name crosstalk
sets, and whether writing to another session's tty is reliable outside tmux.

## Shipping

Nobody reads code, so the PR is plumbing: agents open it, checks and a
reviewer agent gate it, and it merges by itself. The thread, not the PR, is
where work is followed from idea to merge. A thread can produce several PRs
across several repos.

**Two kinds of feature:**

| | Everyday | Risky |
|---|---|---|
| **What makes it so** | the default | touches a path in `.crosstalk/risk`, or an agent raised it |
| **Review** | a fresh agent session | an adversarial reviewer on a different model or client, plus a security pass |
| **Flag** | optional, when visible to users | yes, ideally through your flag provider |
| **Ships** | on merge, or by flag automatically if metrics hold | each flag step is a question, with evidence attached |

An agent may make a feature risky on its own. Making one everyday again is a
question.

**Evidence** is what changed in behaviour, in plain language, with proof: tests,
evals, before and after, a screenshot or demo. Never a diff.

**Flags instead of staging.** Merged means in main and off. Shipped means on.
Rollback is turning a flag off, which any agent may do at any time and tell you
afterwards. A risky feature's evidence comes from a preview deploy before merge,
a dark launch next to the old path after it, then your own accounts first, with
agents watching to turn it off on any regression.

Flags live in one of two places:

- **Your flag provider** (Unleash, LaunchDarkly, PostHog, GrowthBook, Statsig): crosstalk
  drives it and reads its metrics. Turning a flag off is instant. Preferred for
  risky features.
- **A built-in flags file** for teams with nothing: `.crosstalk/flags`, read by
  the app at deploy. Turning a flag off takes as long as a deploy.

Once a flag is fully on, an agent removes it and the old path. A thread closes
when its flags are gone and its questions answered.

**What is faster:** wrong approaches are caught before code, through questions;
people never see failing work; a change across repos is one thread; blocked
agents ask in seconds. CI is still compute: checks run in the session before a
push, so hosted CI confirms rather than discovers, but a slow suite stays slow.

## Disk

Claude Code leaves worktrees, session data and duplicated dependencies behind,
and they fill disks. crosstalk knows what each one is *for*, so it can clean up:

- **A worktree belongs to a thread.** When the thread merges or goes quiet,
  crosstalk removes the worktree and prunes it. The thread file holds what is
  needed to start again, so a worktree is always disposable.
- **Dependencies are shared, not copied.** Worktrees reuse the main checkout's
  `node_modules`, venv or build cache through hardlinks or the package
  manager's global store.
- **Claude Code's own leftovers.** Stale Claude Code worktrees and session data
  for threads long done are pruned too.
- **A disk budget.** "Worktrees and old sessions are using 18 GB; free 14 GB
  from 6 finished threads?" is a question the first time, and a standing rule
  once answered. Nothing is deleted without that.

## Production feeds threads

When something goes wrong in production, it depends on whether the cause is
known:

- **Clear cause** (a flag killed automatically, or errors in code a thread
  shipped recently): **the thread that shipped it reopens**, with the evidence
  attached. Its agents already have the context, so they are fastest to fix it.
- **Unclear cause**: **a new incident thread** starts and looks for it. Once
  found, it links to or combines with the thread that shipped it.

Either way, a person hears about it only through the usual rules: a question
when something is risky or the agents need a decision.

## Git is invisible

Nobody thinks about git. Each agent works in its own worktree, so parallel
agents never step on each other. Their work merges into main in small pieces
many times a day, behind flags, so it rarely conflicts, and when it does the
agents settle it between themselves. Branches, rebases, merges and cleanup
happen out of sight. You see threads and questions.

## No commands

Nothing has to be remembered:

| Need | How |
|---|---|
| A choice crosstalk needs from you | Buttons or Claude Code's picker, offered when it comes up |
| Restore after a restart | "Restore 6 sessions? [Yes] [No]", or say "restore them" |
| Joining someone outside your repos | Say "marie gave me words: cherry horn…", and the agent does it |
| Something broken | crosstalk notices and tells you, with the fix. "Is crosstalk OK?" works too |
| Anything else | Plain words to any agent: "mute jo", "what's marie on?", "show me auth" |

Under the hood the agent calls crosstalk's tools; slash commands and the CLI
remain for scripts and people who like them.

## Installing

**Teammates install nothing.** The repo's `.claude/settings.json` enables
crosstalk, so it is there the moment they clone, and collaborators are trusted
automatically. Joining a team is `git clone`.

**A stranger on the website gets one sentence:**

> Paste this into your coding agent: "Install crosstalk from
> github.com/epode-studio/crosstalk"

The agent works out which harness it is running in and runs the right install,
which the README documents per harness. The commands for each harness stay
below that line for people who want them.

The full research behind the terminal and Claude Code sections is in
[`reports/Terminal as agent workspace.md`](../../reports/Terminal%20as%20agent%20workspace.md).

## Against Entire

[Entire](https://entire.com/) is a hosted Git forge that keeps the *why* behind
code: agent sessions captured as checkpoints, Trails instead of pull requests,
shared memory, search. To get it, you move your repositories to them.

crosstalk is **Entire without the forge**: the same why, in the git and host
you already have, as thread files plus a sealed relay. It keeps recaps and
decisions, not transcripts.

Three claims to back with numbers:

| Claim | Proof |
|---|---|
| **Fewer tokens** | Agents start from the thread instead of re-reading the repo. Measure tokens to the first useful edit, with and without. |
| **Zero migration** | One plugin command on an existing repo. The install test is the proof. |
| **No one can read it** | The relay sees ciphertext, and thread files are sealed. A forge has to read your code to host it. |

And for the way of working: time from idea to merge, and human minutes per
merged thread.

## What this removes from today

| Today | Next |
|---|---|
| Named rooms, and invitations to them | Threads, found automatically |
| A five-level trust ladder | Verified, plus mute |
| Facts, tasks, decisions as separate stores | Sections of the thread file |
| Messages to whichever session is idle | Messages to sessions in the same thread |
| Fourteen slash commands | None to remember |
| Approvals, reviews and notices as separate things | Questions |

## Still open

Technical, each with a proposal:

1. **Keys for many threads.** Joining is automatic, so creating a thread must
   cost no exchange. Proposal: derive each thread's key from the pairwise keys
   its people already share. Re-derive when someone leaves, and issue a new key
   to everyone when two threads combine. Write up in `docs/security.md` first.
2. **What the relay sees.** Many thread ids would leak how much someone
   multitasks. Proposal: one connection and one id per person, with thread ids
   only inside sealed frames.
3. **Sealed files in git.** Encrypted files make useless diffs and conflict
   badly. Proposal: seal each section separately so edits to different
   sections merge, and let the relay's live copy settle the rest before
   anything is committed.
4. **Recaps stay local.** Matching runs on each person's machine against the
   shared thread file, so only the recap ever leaves it, sealed.
5. **Bots.** Decided: something narrower than a member (see People).

## URLs are what people review

Nobody reads code, so the running thing is what a person looks at. crosstalk
keeps track of it.

- **Every URL is collected and labelled:** local servers (from crosstalk's
  services and their detected ports), previews, pull requests, and links an
  agent's commands print. Each has what it is (`auth · dev server`,
  `auth · preview`, `auth · PR #12`), its thread, and whether it still answers.
  Dead ones drop off.
- **Names, not ports:** `http://auth.localhost`, through a small local proxy
  that follows each worktree's service wherever its port moves. Browsers already
  send `*.localhost` to this machine.
- **One list, anywhere:** in the pane, clickable; on the tab
  (`auth · auth.localhost`); and by asking any session ("what's the auth URL?",
  "open the billing preview").
- **Shared with teammates:** "show marie the auth page" gives her a link to the
  running server through the sealed relay, only for the people named; her agent
  can test against it. Nothing is public unless asked for.
- **Screenshots as evidence:** after a change, a headless browser captures the
  thread's URLs, before and after. Those are the evidence a person reviews.
- **Servers that look after themselves:** each URL is checked; a crash or error
  turns the tab red and tells the thread's agent, which restarts or fixes it.
- **On the phone:** a QR code in the pane opens a share link.
- **History:** every link, preview and screenshot a thread had, kept in its
  file.
- **Servers that just start:** a new worktree gets the main checkout's `.env`
  and other local secrets copied in. They stay on this machine: never in git,
  a thread or the relay.

## Built

Every part above has a first version on the branch, with its tests in
`bun run test`. What remains is checking it in real use, listed after the table.

| Part | Code | Docs |
|---|---|---|
| Routing by repo, branch and files | `src/footprint.ts`, `routeInbound` in `src/daemon.ts` | `docs/architecture.md` |
| Restore after a restart | `src/restore.ts` | `docs/restore.md` |
| Sessions already open | `src/gather.ts` | `docs/restore.md` |
| The mod: cards, pickers, status line, pane | `mod/register.tsx`, `src/uistate.ts`, `src/uicli.ts`, `src/ui-extra/` | `spike/mod/README.md` |
| Peer notices when channels are off | `src/channels.ts` | `docs/architecture.md` |
| Trust through repository access, first use per repo | `src/repotrust/` | `docs/security.md` |
| Threads, sealed, on their own ref; re-keying | `src/threads/` | `docs/architecture.md`, `docs/security.md` |
| Terminal workspace: tab status, new agents, background agents, layout, cleanup | `src/terminal/`, `src/spawn.ts`, `src/cleanup.ts` | `docs/terminal.md` |
| Wrangling every session: close and archive, find and resume past sessions (Claude Code's own history too), rename, move, background and pop out, across your own machines | `src/sessions/` | `docs/terminal.md` |
| Main session, rules, agents warning each other | `src/main.ts`, `src/coordinator.ts`, `src/rules/`, `src/warn/` | `docs/tools.md` |
| Recaps, fresh sessions, staffing, focus, notifications, phone, permission prompts | `src/attention/` | `docs/attention.md` |
| No commands, bots, editor, digest, standup, PR text | `src/ui-extra/` | `docs/tools.md` |
| Disk budget, team install, metrics, threads across repos | `src/disk/`, `src/install/`, `src/metrics/`, `src/threads/crossrepo.ts` | `INSTALL.md` |
| Shipping: risk, reviewers, evidence, merging, flags (Unleash first), previews, dark launch, metrics ramps, incidents | `src/shipping/` | `docs/shipping.md` |
| Long-running processes outlive sessions: services in crosstalk's tmux, ports per worktree, waiting for what a session started, cleanup that stops services first | `src/services/` | `docs/services.md` |
| URLs: every URL collected and labelled (services, previews, PRs, links in command output, tokens taken out), liveness, names instead of ports through a local proxy, one list in the pane, on the tab and from any session | `src/urls/` | `docs/urls.md` |
| Screenshots as evidence: captured after a turn that edits files and on demand (Playwright, else Chrome over DevTools), before and after per URL, bounded, attached to the thread's features' evidence, before / after in the pane, opened on request | `src/urls/shots/` | `docs/urls.md`, `docs/shipping.md` |
| Servers that look after themselves: a crash restarted once with backoff, the agent told with the log, a red "broken" tab, the person told only after the agent's own try fails, never a loop | `src/urls/health/`, `src/terminal/status.ts` | `docs/urls.md` |
| Phone, history, env: a QR code in the pane (public URLs, a local server's share link or the thread's preview, else the gap said plainly), every link, preview and screenshot kept in the thread's sealed `links` section, a new worktree's gitignored `.env` and other local files copied in on a yes asked once per repo | `src/urls/history/`, `src/env/` | `docs/urls.md` |
| Sharing a running server with named teammates: HTTP and websockets over the sealed peer channel, `<name>.<owner>.localhost` on their machine, expiry, revocation, people and target checks; a public link only when asked | `src/share/` | `docs/urls.md`, `docs/security.md` |

**Pull requests from sealed threads** carry the feature, its evidence and its
reviewers, never the thread's recap, decisions or open questions: a PR is
readable by everyone with access to the repo, which can be more people than the
thread is sealed to. Public threads put all of it in the PR. Decided 2026-11-02.

### Not yet checked in real use

- **On a Mac:** everything per terminal except restore (tested by hand in
  Terminal.app): tab tints, tab placement, focus, notifications that jump to a
  tab, iTerm2, kitty, WezTerm, Ghostty; services' `lsof` port and folder
  lookups.
- **The session manager on a Mac:** closing a session in Terminal.app or iTerm2, resuming
  one into a tab there, and sending one from a tab to the background were tested only in
  tmux on Linux, with a stub claude. Whether real Claude Code exits cleanly on SIGTERM
  mid-turn, and what its SessionEnd hook reports then, was not checked. Across machines was
  tested with two identities on one machine and one relay.
- **Between two people on two machines:** threads, repo trust, rules, warnings
  and shipping questions answered from another machine were tested with two
  identities on one machine.
- **With real accounts:** Unleash, LaunchDarkly, PostHog, GrowthBook and
  Statsig (mocks only), `gh` pull requests, preview hosts, Sentry alerts.
- **Real reviewer runs:** `claude -p` and `codex exec` as reviewers were
  replaced by stubs; whether Codex's default sandbox lets a review finish is
  open.
- **URLs on a Mac and with real dev servers:** port 80 without root, `open`,
  browsers' `*.localhost` with a port, the pane's OSC 8 links; Vite, Next.js
  and webpack HMR through the proxy (a bun server and a raw websocket stood
  in); real PostToolUse payloads; `gh pr view` on real PRs.
- **The QR code with a real phone:** checked by a decoder in the tests and the
  standard's vectors, never scanned; the mod's white-on-black drawing in
  Terminal.app and iTerm2. Sharing a local server with your own phone waits
  for the sharing build.
- **Env copying on a Mac:** modes on APFS, `O_NOFOLLOW`, `git check-ignore` on a
  case-insensitive file system; Claude Code's own worktrees were stood in for by
  `git worktree add` and the real hook.
- **Phone push:** Claude Code's own push needs Remote Control paired; ntfy was
  tested against a local stand-in.
- **Sharing between two machines:** tested with three identities on one
  machine and a local relay; the hosted relay (it carries share frames as plain
  sends), a public link through a real cloudflared, Vite or Next.js HMR through
  a share, and the share card in the mod on a Mac were not run.

