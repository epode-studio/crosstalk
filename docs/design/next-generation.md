# The next generation

Status: workshopped, not built. Decided in an interview on 2026-11-01.

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

## Four nouns

| Noun | What it is |
|---|---|
| **People** | Everyone you trust: your repo's collaborators, plus anyone you verified with four words. |
| **Threads** | A piece of work and the conversation about it, shared with some of those people. One file in the repo. |
| **Features** | The shippable parts of a thread. Each is everyday or risky, and may have a flag. |
| **Questions** | The only way crosstalk ever asks anything of a person. |

Sessions, recaps, reviewers, footprints and relays exist, but they are
machinery. Nobody needs to know about them to use crosstalk.

Words used everywhere, in docs, tool output and the statusline: these four and
nothing else.

## Principles

- **Native to the code CLI.** No app, no TUI, no dashboard, no tmux. Plugin,
  hooks, MCP and one daemon. You drive it in plain language from any session.
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

Bots need a decision: probably a bot is a member that can post to a thread but
cannot start sessions on your machine.

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
answer there, or by typing `@auth y`, which the mod takes before it becomes a
prompt. The mod also takes incoming peer messages so the model never reads
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
| Terminal.app | AppleScript | frontmost tab only |
| Windows Terminal | `wt -w 0 nt` | no |
| Ghostty, VS Code terminal | limited | limited |

Terminals that can do neither get a desktop notification with the command to
paste. On macOS, AppleScript needs a one-time Automation permission.

**crosstalk never takes focus on its own.** It opens or focuses a tab only when
you ask, or when you click a notification.

### Focus-aware, plus a main session

- **By default, focus-aware.** A question goes to the tab you are looking at,
  hidden from its agent as above. A desktop notification names the asking
  thread, and clicking it jumps to that session's tab.
- **A main session, when you want one.** Any session becomes main when you say
  so ("be my crosstalk main", or `@main`). Nothing new is launched. From then
  on it only coordinates: it leaves its threads, so cross-cutting talk never
  mixes with code work, and its context is threads, people and questions. It
  gets the sidebar pane, and it is where you wrangle every session from.

**With a main session open, working sessions only ask about their own
thread.** Everything that cuts across threads goes to main instead: questions
from other threads, unmatched messages, threads about to combine, a key that
changed. A working session's band shows only what its own agents are waiting
on. Closing main sends everything back to focus-aware.

## Getting someone on it

There is one idea: **get someone on it**. Whether that means steering a session
that is already open, resuming yesterday's, or starting a new one in the
background is crosstalk's choice. If the choice matters, it is a question.
Fanning out is starting several features at once.

Routing to the right open session ships first, since that is today's bug.
Everything else builds on the same matching.

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

Steering goes the same way: `@api stop` or `@auth put two more on it` is
handled by the hook and never reaches the current agent. Asking the current
agent itself ("what's running?") is the one way another thread enters its
context, and only because you asked it.

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
| Open in IDE | `@auth open` opens that worktree in your editor |
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
watch one, and `@auth open` does that for you, in a new tab of your own
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

- **Your flag provider** (LaunchDarkly, PostHog, GrowthBook, Statsig): crosstalk
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

## Commands

Two:

- `/crosstalk:join` for the four words with someone outside your repos.
- `/crosstalk:doctor` for when something is broken.

Everything else, from muting someone to asking what Marie is working on or
linking another machine, is plain language in any session.

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
| Fourteen slash commands | Two |
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
5. **Bots.** Whether a bot is just a verified member or something narrower.
