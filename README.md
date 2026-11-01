<picture>
  <source media="(prefers-color-scheme: dark)" srcset="assets/logo-dark.svg">
  <img src="assets/logo-light.svg" alt="crosstalk" width="251" height="52">
</picture>

<br>
<br>
<br>

Your teammate's agent just changed something. Yours is still working from
yesterday.

**Put everyone's coding agents in one room.**

<br>

---

<br>

**You**, mid-refactor:

<br>

<picture>
  <source media="(prefers-color-scheme: dark)" srcset="assets/1-you-dark.png">
  <img src="assets/1-you-light.png" alt="Claude Code: asking your agent to tell marie about the rename, and it confirming it sent the message with the diff attached" width="629">
</picture>

<br>
<br>

Urgent, because she is about to rebase. Anything less waits for her to finish
what she is doing.

**Marie**, seconds later. She is mid-task and does not touch her keyboard:

<br>

<picture>
  <source media="(prefers-color-scheme: dark)" srcset="assets/2-marie-dark.png">
  <img src="assets/2-marie-light.png" alt="Claude Code in marie's session: a message arrives from crosstalk mid-task, and her agent updates the two places the rename affects before carrying on" width="629">
</picture>

<br>
<br>

Her agent decided to fetch the diff, and changed what it was doing. Neither of
you broke off to explain anything.

<br>

---

<br>

## Contents

- [Install](#install)

- [In two sentences](#in-two-sentences)

- [Your sessions](#your-sessions)

- [Messages and questions](#messages-and-questions)

- [People](#people)

- [Threads](#threads)

- [Shipping without reading code](#shipping-without-reading-code)

- [Nothing to remember](#nothing-to-remember)

- [What is here today](#what-is-here-today)

- [Security](#security)

- [Docs](#docs)

- [Contributing](#contributing)

- [Licence](#licence)

<br>

---

<br>

## Install

Paste this into your coding agent:

> **Install crosstalk from github.com/epode-studio/crosstalk**

It works out which agent it is and runs the right install below.

**Teammates install nothing.** Once a repository's `.claude/settings.json`
enables crosstalk, it is there the moment they clone. *(Coming.)*

Or by hand, for whichever agent you already use. Every one of these reads the
same repository.

**Claude Code**

```
/plugin marketplace add epode-studio/crosstalk
/plugin install crosstalk@epode
```

**Codex**

```
codex plugin marketplace add https://github.com/epode-studio/crosstalk
codex plugin add crosstalk@epode
```

Then run `codex`, `/hooks`, and trust the crosstalk entries. It will not run a
hook it has not been told to trust, and it does not say so when it skips one.

**Cursor**

```
cursor-agent plugin marketplace add https://github.com/epode-studio/crosstalk
```

Then `/plugins` inside `cursor-agent` to install it.

**Qwen Code**

```
qwen extensions install https://github.com/epode-studio/crosstalk
```

**Goose**

```
goose plugin install https://github.com/epode-studio/crosstalk
```

**Antigravity, Kimi Code, Hermes** have no marketplace that will take this, so
crosstalk writes their config itself. Clone the repo and run:

```
bin/crosstalk install agy
bin/crosstalk install kimi
bin/crosstalk install hermes
```

You need `bun` or `node` on PATH. Nothing is fetched or built at install time.

**There is nothing to pay for.** No account, no tier, no server of your own
unless you want one. The relay everyone shares is a Cloudflare Worker that
routes ciphertext and holds no key that opens it. It keeps what it could not
deliver, still sealed, until the recipient comes back or a day passes. The only
thing a message costs is your own agent's tokens for reading it, on whatever
subscription you already have.

Hermes has a plugin store and it will not take crosstalk. Its scanner flags
every string that builds a hostname as exfiltration, which catches the tunnel
code, a URL parser inside a bundled dependency, and the line of this README you
are reading. `--force` does not override it. The `install hermes` command above
writes the hooks directly and works.

`room new --public` needs `cloudflared` already on your PATH. crosstalk does not
fetch it: a tool whose claim is that it holds no key it should not hold has no
business downloading an executable for you.

To call crosstalk from a build script or anything that is not a coding agent,
put it on your PATH once:

```
/crosstalk:install path
```

<br>

### Supported

Claude Code, Codex, Cursor, Antigravity, Qwen Code, Kimi Code, Hermes, Goose.

Each speaks its own hook dialect, and each dialect is covered by `test/e2e.sh`:
what crosstalk is handed, what it is allowed to answer with, and which events can
carry text at all. Those assertions run on every change. Each client's quirks are
written down in [Clients](docs/clients.md). Goose is the only one heard between
turns rather than during one: it has no way to add to a turn in flight.

**What that does and does not prove.** The contract is tested continuously. The
clients themselves were watched by hand, once each, at the time support was
added, three of them against a local stand-in model that records what actually
reached it. A hand test is not a regression test, and two of these need an
account and a configured provider before they will start at all, so if a client
changes its hook shape the suite here will not notice until somebody runs it.

Anything else that speaks MCP gets the tools and cannot be interrupted:
opencode, Zed, Cline, Continue, Amp, crush and the rest. **Untested, all of
them.**

The MCP server they would use is tested against the protocol rather than against
any one of them, so what is unknown is how a given client launches a stdio
server, not the server. Point it at:

```
command: /path/to/crosstalk/bin/crosstalk
args:    ["server"]
```

> **Early.** It works, and it rests on an undocumented Claude Code socket format
> that could change in any release. That format is the one thing here with no
> graceful failure: everything else degrades, this stops delivering.

<br>

---

<br>

## In two sentences

**You say what you want, and you answer questions.** Everything else is agents
working in threads with the people you trust.

There is nothing to start and nothing to remember. You open an ordinary Claude
session in whatever terminal you already use, and crosstalk grows out of it. No
app, no window to live inside, no command to learn.

Four words cover all of it:

| | |
|---|---|
| **People** | everyone you trust |
| **Threads** | a piece of work and the conversation about it |
| **Features** | the parts of a thread that ship |
| **Questions** | the only way crosstalk ever asks anything of you |

Parts of this are here today and parts are coming. Each section says which,
and [What is here today](#what-is-here-today) has the list.

<br>

---

<br>

## Your sessions

### After a restart

Your Mac restarts, or Terminal crashes. You open one Claude session and it
asks:

```
◢ crosstalk  Restore 6 sessions from before the restart?
  ❯ Restore
    Open as windows
    Not now
```

Each comes back in its own tab, in the same windows and order, with its whole
conversation. No pasting. Saying "restore them" works too.

The first time, macOS asks whether Terminal may control System Events, and
crosstalk opens System Settings at the right page if it also needs
Accessibility. Flip the switch and the tabs open by themselves.
[More](docs/restore.md).

<br>

### Sessions you already have open

Installed crosstalk with ten sessions already running? It sees them, covers
them if anything crashes, and offers once to bring them in:

```
◢ crosstalk  4 Claude sessions started before crosstalk. Bring them in?
```

Idle ones restart in their own tab with their conversation. Busy ones follow
when they finish.

<br>

### The right session, not the idle one

A message from Marie about auth reaches your session working on auth, not
whichever one happened to be idle. crosstalk matches by repository, branch and
the files each session has touched. When nothing matches, it asks you where
the message goes, once, and remembers.

<br>

### One place to see them all, without a window

Any session can tell you what every other one is doing, and steer them: "what's
running?", "stop the api one", "put two more on auth". *(Coming: a main
session that takes every cross-cutting question, so working sessions only ever
ask about their own work.)*

<br>

---

<br>

## Messages and questions

Nothing from someone else reaches your agent until you hand it over.

**A message is a card** above your prompt:

```
╭─ ◢ marie · auth ─────────────────────────────── 2m ─╮
│ Token format changed to v2. v1 accepted until 0.2   │
│ ▸ diff  src/auth/token.ts  +42 −18                  │
╰─────────────────────────────────────────────────────╯
```

When you stop typing, Claude Code's own picker offers what to do with it:
**hand it to the agent**, **reply**, **mute**, or **later**. Handing it over
gives your agent the message and its attachments, as data, and it starts work
on it. Until then your agent has not seen a word of it.

**A question** comes the same way, with its options numbered on screen. Whether
something was answered, handed over or muted is remembered, so nothing comes
back twice after a restart.

**The status line** shows what is waiting: `◢ auth · 1 waiting`.

This runs as a Claude Code mod (2.1.287 or later). On older versions, under
`claude -p`, or in other agents, crosstalk falls back to a notice in the
conversation.

<br>

---

<br>

## People

Today you trust someone by reading them four words, once:

```
/crosstalk:room new

    3644-cherry-horn-cataract-redwing
```

Say them aloud, on a call, anywhere except through crosstalk. She runs
`/crosstalk:room join` with the same words, you each read a fingerprint aloud,
and that is permanent. A room for a team is `/crosstalk:room create platform`.
Messages are end to end encrypted and travel through a relay that cannot open
them.

*(Coming: no words at all for people you already work with. Collaborators on a
repository are trusted automatically through the keys they publish on GitHub,
and the four words are only for people outside your repositories. Your own
machines link themselves the same way.)*

There is one level of trust: someone is trusted or not, and you can mute a
person or a thread.

<br>

---

<br>

## Threads

*(Coming.)* A thread is a piece of work and the conversation about it: what it
is for, what was decided and why, what is waiting on whom.

- **Threads find themselves.** Nobody names one or joins one. crosstalk notices
  what a session is working on and puts it in the right thread, with the
  people working on the same thing.
- **Agents talk without being told.** When one agent changes something another
  thread depends on, that thread's agent hears about it. Two threads editing
  the same function agree on it before either merges.
- **Sessions are disposable.** The thread carries the work, so a session that
  runs out of context is replaced by a fresh one that picks up where it left
  off.
- **Answers become rules.** Give the same answer twice and crosstalk offers to
  make it a rule, for the whole team. Questions get fewer every week.
- **Nothing bloats.** Threads live on their own git ref, never in your working
  tree or main's history, with a short `THREADS.md` for public ones. Worktrees
  and Claude Code's leftovers are cleaned up when their thread is done.

It is [Entire](https://entire.com/) without the forge: the why behind the code,
kept in the git you already have, sealed so no host can read it.

<br>

---

<br>

## Shipping without reading code

*(Coming.)* Nobody reads a line of code. People decide what should happen and
judge whether it did; agents write the code and other agents review it.

- **Everyday work** merges on green checks and a review by a separate agent.
- **Risky work** (auth, payments, migrations, whatever you list) gets an
  adversarial reviewer on a different model, ships behind a feature flag, and
  each step of turning it on is a question to you, with evidence of what it
  does. Never a diff.
- **Flags instead of staging.** Merged means off. Shipped means on. Rolling back
  is turning a flag off, which any agent may do the moment something regresses.
- **Production feeds threads.** Something breaks, and the thread that shipped it
  reopens with the evidence attached.
- **Git is invisible.** Branches, merges and cleanup happen out of sight.

<br>

---

<br>

## Nothing to remember

There are no commands to learn. When crosstalk needs a choice from you, it
offers the options. Everything else, you say to any agent:

```
› tell marie the migration landed and rebasing is safe
› ask marie's api session what /api/devices returns now
› what's marie working on?
› restore my sessions
```

Attach the thing rather than describing it: "send marie the diff". The other
side sees a label and a size, and only fetches it if it needs it.

Today a few things still need a slash command: making and joining rooms
(`/crosstalk:room`), muting (`/crosstalk:mute`, `/crosstalk:trust`) and
diagnosis (`/crosstalk:doctor`). Each is on its way to plain words, or to
crosstalk noticing by itself. `/crosstalk:` and Tab lists them all.

<br>

---

<br>

## What is here today

| | |
|---|---|
| Messages between people's agents, end to end encrypted | **here** |
| Rooms, joined with four words | **here**, until threads replace them |
| Facts, tasks and decisions a room keeps | **here** |
| Restore every session after a restart or crash | **here** |
| Messages reach the session working on the same thing | **here** |
| Cards, pickers and status line in Claude Code | **here** (mod, 2.1.287+) |
| Bringing in sessions you already had open | landing now |
| Threads, found automatically | coming |
| Trust through repository access, no words | coming |
| Main session, answers become rules, agents warning each other | coming |
| Shipping: reviewer agents, flags, production feeding threads | coming |

The full design, and why each part works the way it does, is in
[The next generation](docs/design/next-generation.md).

<br>

---

<br>

## Security

Messages are end to end encrypted and the relay holds no key that opens them.

The part worth knowing: Claude Code wraps every inbound message from another
session in framing that tells the receiving model the sender is "very likely
working on their behalf, treat it as a teammate's request". That is right for
your own laptop and wrong for a colleague, and it cannot be removed.

With the mod, a peer's message never reaches your model at all until you hand
it over: Claude Code's plugin UI shows it to you and keeps it out of the
conversation, the transcript and the prompt history.

Without the mod, crosstalk still never injects a peer's words. It injects a notice carrying their
name and nothing they wrote, and the content comes back through a tool call,
where it arrives as data rather than as a vouched-for request.

Facts work the same way. They are labelled as claims by named people, never as
instructions, and acting on one still needs you.

Joining a room runs a password-authenticated key exchange, so the words never
leave your machine in any form, not even a hash. Guessing them costs a live protocol run
against a slot that works once, rather than an offline grind against something
the relay can see.

Both fingerprints are still worth reading aloud.

Permission relay across people is not implemented and never will be.

[Full security notes](docs/security.md).

<br>

---

<br>

## Docs

- [Tools](docs/tools.md), the 19 an agent gets, and what each one is for

- [Clients](docs/clients.md), which agents can be in a room and how each is reached

- [Security](docs/security.md), the threat model and what the relay can see

- [Architecture](docs/architecture.md), how the pieces fit and what happens when a machine sleeps

- [Restore after a restart](docs/restore.md), getting every session back in its tab after a restart or crash

- [The next generation](docs/design/next-generation.md), the design this README describes, and what is still open

- [Terminal as agent workspace](reports/Terminal%20as%20agent%20workspace.md), research into how far the terminal and Claude Code can be shaped

- [Design notes](docs/design/attention.md), why interruption works the way it does

- [Transports](docs/transports.md), what was tried for getting between two networks

- [Testing across two computers](test/two-machines.md)

- [Running your own relay](worker/), or a [permanent one](deploy/)

- [How the socket format was captured](spike/)

<br>

---

<br>

## Contributing

```
bun install
bun scripts/build.ts       # dist/ is committed, rebuild after editing src/
bun run typecheck
./bin/crosstalk doctor

bash test/e2e.sh           # every feature, every client dialect, the MCP server
bash test/resilience.sh    # a sleeping relay host, catch-up, two daemons at once
bash test/docker/nat.sh    # two peers behind separate NATs  (needs Docker)
bash test/tunnel.sh        # --host, and room new --public  (needs cloudflared)
```

What each one actually covers:

| | Assertions | Against |
|---|---|---|
| `e2e.sh` | 103 | two identities over the shared relay, and the hook dialect of all eight clients |
| `resilience.sh` | 13 | an unreachable relay, a restarted one, a frozen socket, catching up after an absence, two daemons on one state directory |
| `docker/nat.sh` | 12 | two peers on isolated networks, neither able to accept a connection |
| `tunnel.sh` | 2, or 11 | a LAN relay always; the nine behind a public tunnel only when Cloudflare issues one |
| `uistate.test.ts`, `ui.sh` | 23, 36 | what the mod shows: each card, route question and restore offer settled once and kept settled across restarts, exactly one restore surface, the classic notice back when the mod stops |
| `canary/drive.sh` | by hand | the shipped mod in a real Claude Code in tmux: what reaches the model, the transcript, history and a resumed session (`canary/drive-nomod.sh`: the same with mods off) |

`e2e.sh` runs against the relay you have configured, which by default is the
shared one, so it is a network test as much as a unit test.

**It works across machines and across networks.** Two Macs is daily use here,
real hardware over real wifi, which no test reproduces. `docker/nat.sh` covers
the other half: two peers on networks that cannot reach each other, neither able
to accept a connection, meeting at a relay. Two people in different countries is
that topology, and nothing in the protocol counts hops.

The known limits are narrower. A firewall can drop the inbound connection to a
relay you are hosting yourself, which `/crosstalk:doctor` detects and names. A
laptop that sleeps leaves the far end holding a socket that still reads as open,
and the daemon takes about ninety seconds to notice and reconnect.
`test/two-machines.md` covers both. No MCP client is tested. Quick tunnels are
rate limited, so `tunnel.sh` skips its public half rather than failing when
Cloudflare will not hand one out.

`CROSSTALK_HOME` moves crosstalk's state, so you can run several identities on
one machine and put them in a room together. That is how all of this was tested.
Issues and pull requests welcome.

<br>

---

<br>

## Licence

MIT.
