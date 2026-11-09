<picture>
  <source media="(prefers-color-scheme: dark)" srcset="assets/logo-dark.svg">
  <img src="assets/logo-light.svg" alt="crosstalk" width="251" height="52">
</picture>

<br>
<br>
<br>

**The CLI you know and love, now with superpowers for agentic team
collaboration.**

Same way of working. Same terminal, same `claude`, same sessions. Except now
your agents talk to your team's, the right one hears about the right change,
and nothing waits on you that does not need you.

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

- [In two sentences](#in-two-sentences)
- [Things to say](#things-to-say)
- [Three things you meet](#three-things-you-meet)
- [Superpowers](#superpowers)
- [Your terminal is the workspace](#your-terminal-is-the-workspace)
- [How it feels](#how-it-feels)
- [Install](#install)
- [People](#people)
- [Threads](#threads)
- [Questions](#questions)
- [Shipping without reading code](#shipping-without-reading-code)
- [Small things that add up](#small-things-that-add-up)
- [What is here today](#what-is-here-today)
- [How it works](#how-it-works)
- [Security](#security)
- [Docs](#docs)
- [Contributing](#contributing)
- [Licence](#licence)

<br>

---

<br>

## In two sentences

**You say what you want, and you answer questions.** Everything else is agents
working in threads with the people you trust.

<br>

## Things to say

No commands to learn. Open `claude` the way you always do and say what you
want, in your own words, to any session. When crosstalk needs a choice from
you, it asks.

**Your sessions**
- *"Show me all my agents."* A live list beside the chat: every session, what
  it is on, and which ones are waiting on you. The main session shows it by
  itself.
- *"Show me the board."* Every thread on one page in your browser: what
  waits on you, open tasks, decisions, features, pull requests and checks.
- *"Work through the open tasks."* Agents take the threads' open tasks by
  themselves, two at a time, in the background, investigations of failures
  first. *"Stop working the board"* stops it.
- *"Tidy up my sessions."* Closes the ones you are not using and folds
  duplicates into one. One question first; anything closed can come back.
- *"Close billing."* · *"Resume the one where I fixed login."* · *"Call this
  one payments."*
- *"Park billing."* Out of sight until you need it: nothing new starts in it
  and its questions wait, kept, not lost. *"Unpark billing"* brings it all
  back. Only an agent stuck on a permission still reaches you.
- *"Restore them."* After a restart or a crash, every session back in its
  tab, mid-conversation.
- *"Make this the main session."* Your inbox: every question, from crosstalk,
  your teammates and your agents' own, comes here one at a time, the most
  pressing first, with what you need to answer it. Answering closes it and the
  next one comes up. Its pane shows the inbox, your agents, pull requests,
  credit usage and what just happened.

**More hands**
- *"Put two more agents on auth."* Each gets its own copy of the code and
  already knows what the work is about. Four agents work at once at most;
  past that a new one waits its turn and starts by itself when one finishes
  (`CROSSTALK_WIP` changes the number).
- *"Run the dev server."* It keeps running after the session ends, at a name
  like `auth.localhost` instead of a port number.
- *"Show me the auth page before and after."*

**Your team**
- *"Tell marie the token format changed, with the diff."* It lands with her,
  in the session working on the same thing, not wherever she happens to be.
- *"What's marie working on?"* · *"Ask marie's api session what /devices
  returns."*
- *"Show marie the auth page."* Your running app, for her eyes only.
- *"Mute jo for an hour."*

**Your work**
- *"What did we decide about v1?"* · *"What happened while I was away?"*
- *"Ship it."* Another agent reviews it first, and anything risky goes out
  behind a switch you turn on step by step.
- No more *"tackle all open"*. When a reply ends with an Open list, crosstalk
  keeps each item as a task in the thread and the agent carries on with the
  new ones by itself, three rounds at most before it waits for you. What it
  would have left to you, it does too; where it needs your yes (approving,
  merging, a choice), it asks once in main, with the link, then does it.
  What only waits (CI, a review)
  is left alone, and picked up by itself once it moves. *"Stop tackling open
  items by itself"* turns that off.

**Your day**
- The first session of the day says what happened since you were last
  here, in one paragraph.
- *"Plan my day."* The open work, thread by thread; pick today's few and
  agents take those, the rest wait.
- *"Wrap up for today."* What shipped and was decided, and what is open for
  tomorrow. *"Pick up where I left off"* brings it back.
- Back in a tab after a while, one line says where you left off there.

**crosstalk keeps things in shape by itself**
- A session whose pull request merged closes once it is idle; any session
  idle three hours closes too. Never one that is busy, waiting on you, running
  a server or holding uncommitted changes. Each says so in Lately, and
  *"resume <name>"* brings it back with its conversation.
- A session whose context runs out starts fresh from its thread, in the same
  tab, at a natural break. *"Stop starting fresh by itself"* compacts as usual.
- New agents work out of sight while a main session is open; their questions
  come to main.
- An agent that keeps spending without changing anything (five dollars in
  half an hour, no edits) gets one question in main: stop it, or let it run.
- Questions from a session that has since ended are put away by themselves.
- Your pull request turns green and is approved: one question in main, merge
  it? Pick *Always* and green PRs merge by themselves, one quiet line each.
  *"Stop merging by itself"* goes back to asking.
- When a pull request in a shared thread merges or its checks fail, your
  teammates in that thread hear it once, in a line.
- Merge queues are watched: where your PR is in line and about when it
  merges. If it falls out on a failed check, it goes back in once (queue
  checks are often flaky); if it fails again or conflicts, the session working
  on it (or a new background agent) fixes it and puts it back. Taken out by
  hand, it is left alone. A queue stuck far longer than usual is said once.
  `CROSSTALK_NO_QUEUE=1` turns this off.

**Less to carry**
- *"I'm focusing for an hour."* Only what stops an agent interrupts you; the
  rest waits, and one line at the end says what did.
- *"I'm going to bed"* or *"out for a walk."* Agents keep going as far as
  they safely can: a question takes the agent's own recommendation, or it
  picks the safest reversible choice and writes down why; open lists are
  tackled; open tasks are worked, two agents at most, paused near your plan's
  limit. Permission prompts, deploys and anything only you can do wait. Your
  first message back says what happened, what was decided for you, and what
  it cost.
- Questions that don't stop an agent come together, every half hour or so,
  not one by one as they arise. After a dozen decisions in an hour,
  crosstalk suggests a break and holds what can wait.
- An agent's question that names a recommended option says so, and goes with
  it if you don't answer within fifteen minutes. You can always change it.
- A reply that ends with an Open list never stops you: its items are kept as
  tasks, and one quiet line says so.

**When something is off**
- *"Is crosstalk OK?"* It checks itself and tells you what to fix.

Forgot all this? Ask any session *"what can crosstalk do?"*

<br>

---

<br>

## Three things you meet

| | |
|---|---|
| **People** | everyone you trust: your repos' collaborators, your own machines, and anyone else you joined with four words |
| **Threads** | a piece of work, found automatically. Each has four parts: **Notes** (what it knows: decisions, facts, tasks, rules, its recap), **Features** (what ships, and how far it has got), **Running** (servers, previews, pull requests, links and screenshots: where to look) and **History** (everything it once had in Running and Notes) |
| **Questions** | the only way crosstalk ever asks anything of you, answered with a picker or in plain words |

Everything else, the sessions, copies of the code, ports, relays, keys and
reviewer agents, is machinery. You never need to know about it; it is in
[How it works](#how-it-works) for when you want to.

<br>

---

<br>

## Superpowers

Nothing about how you work changes. You still open `claude` and say what you
want. Coding agents already made writing code fast; everything around it stayed
slow: telling each other what changed, reading diffs, babysitting a dozen
agents, untangling branches. crosstalk takes that part away.

<br>

### You stop being the messenger

Today, when your agent changes something Marie's depends on, *you* notice, and
*you* tell her, and *she* tells her agent. With crosstalk the agents tell each
other. Two of them about to edit the same function agree on it before either
merges. You hear about it only when a decision is yours to make.

<br>

### You stop reading code

People decide what should happen and judge whether it did. Agents write the
code, and other agents review it. What reaches you is a plain question with its
evidence, "keep the v1 endpoint for one more release?", never a diff. Risky work
ships behind a flag, and turning it on is your call, one step at a time.

<br>

### You stop babysitting agents

Run as many agents as you like, in the terminal you already use. Each one knows
which thread it is in and who else is working on it. A message about the auth
work reaches the auth agent, not whichever one was idle. Questions from all of
them come to wherever you are, and none of them leaks into another agent's
conversation. Say "make this my main session" and every question that cuts
across threads goes there, so the others only ever ask about their own work.

<br>

### You stop explaining twice

What was decided and why is a note in the thread, with the code, not in a chat
log nobody reopens. A fresh agent, a teammate joining next month, or an agent on
another machine starts from what is already known. Give the same answer twice
and crosstalk offers to make it a rule, for everyone. The questions get fewer
every week.

<br>

### You stop thinking about git

Branches, merges, copies of the code and cleanup happen out of sight. Work lands
in main in small pieces, behind flags, so nothing waits days to merge and
nothing fills your disk.

<br>

---

<br>

## Your terminal is the workspace

Running many agents usually means a separate app: launch it first, keep every
terminal inside it, learn its window. crosstalk has none. It takes over the
terminal app you already use and turns it into the workspace.

- **Your tabs are the list of agents.** One per agent, opened, arranged and
  brought back by crosstalk: one window per repository, a thread's tabs side by
  side.
- **Tabs that say what they are.** Each tab is named after its thread and
  session, with the thread's colour in front: 🟣 auth · auth-1, 🟢 billing ·
  billing-2. After a restart, "Only the recent 4" brings back just the work in
  hand.
- **Status at a glance.** Each tab shows whether its agent is working,
  finished, or waiting on you: a progress mark where the terminal draws one,
  tab colour in iTerm2 and kitty, a window option in tmux. Terminal.app has no
  tab badge, only the background, so crosstalk leaves your backgrounds alone
  unless you set `CROSSTALK_TAB_COLOUR=1`.
  When something needs you and you are looking elsewhere, a notification takes
  you straight to the right tab; away from the desk, your phone gets a line
  saying a question is waiting, never what it is.
- **New agents on request.** "Put two more on auth" opens two tabs, each with
  its own agent working on its own copy of the code, already knowing what the
  thread is about: each starts from the thread's notes and open questions, then
  your task. Finished copies are offered for cleanup once their work is merged.
- **Start from anywhere.** There is no app to launch first and no window to
  live inside. Open any Claude session and everything grows out of it.
- **Nothing is lost.** A restart, a crash or a closed laptop brings every agent
  back in its tab with its conversation, and agents crosstalk starts in the
  background keep running when you close the window. "Show me auth" opens one.
- **Close one cleanly.** "Close billing" ends it as if you had quit it, once
  you say yes on the picker. Its dev server keeps running unless you say
  otherwise. It is archived, not lost, so a restart never offers it back. Its
  tab goes with it.
- **Tidy up.** "I'm overwhelmed" or "tidy up my sessions" puts one question to you: close
  the sessions you have left idle, fold sessions doing the same work into one
  (the one kept is told where the others had got to), and close the empty
  tabs ended sessions left behind. "And merge my windows" makes them tabs of
  one window. Nothing busy is touched, and anything closed can be resumed.
- **Find and resume past work.** "Find the one where I fixed the token refresh"
  searches what every past agent was about: its thread, recap, files, title and
  branch, including Claude Code's own history. "Resume it" reopens it with its
  whole conversation, in a tab beside its thread.
- **Rename and move.** "Call this one payments" renames the tab and its place in
  its threads. "This belongs in auth" moves it into that thread, and it stays.
- **Pop in and out.** "Send billing to the background" carries a tab's agent on
  out of sight, conversation and all, with its servers untouched. "Pop billing
  out" brings it back into a tab.
- **Across your machines.** From your laptop, "what's running on my desk?",
  "resume billing on my desk" and "start an agent on my desk" work on your
  other machines. Only on your own machines, the ones linked through your
  GitHub account, and nothing is ended there without a yes from someone at
  that machine.
- **Names, not numbers.** A thread's dev server is `http://auth.localhost`
  (`:1355` where port 80 needs privileges), and keeps that name when it moves.
  The tab says `auth · auth.localhost:1355`.
- **Not just your agents.** Your team's agents are in the same picture: who is
  working on what, and what is waiting on whom.

Terminal.app first, then iTerm2, kitty, WezTerm, Ghostty and tmux. What each
terminal can and cannot do: [docs/terminal.md](docs/terminal.md).

<br>

---

<br>

## How it feels

You open an ordinary Claude session, in whatever terminal you use. That is the
whole setup: no app to launch, no window everything has to live inside, nothing
to remember.

```
› tell marie the token format changed, with the diff
```

Marie is mid-task. Above her prompt:

```
╭─ ◢ paul · auth ─────────────────────────────── now─╮
│ Token format changed to v2. v1 accepted until 0.2  │
│ ▸ diff src/auth/token.ts +42 −18 3 KB              │
╰────────────────────────────────────────────────────╯
```

When she stops typing, Claude Code's own picker asks what to do with it: hand
it to her agent, reply, open the thread, mute, or later. Her agent has not seen
a word of it until she chooses.

Later, one of your agents needs a call from you:

```
◢ api-worker · auth asks
  Keep the v1 endpoint for one more release?
  ❯ 1 Yes, until 0.2
    2 No, remove it now
```

You press 1. That is your part.

<br>

---

<br>

## Install

Paste this into your coding agent:

> **Install crosstalk from github.com/epode-studio/crosstalk**

It works out which agent it is and runs the right install below, following
[`INSTALL.md`](INSTALL.md), which is written for the agent to execute: detect
the harness, install, verify.

**Teammates install nothing.** In a repo where you use crosstalk and are
connected with your team, crosstalk asks once: "Turn crosstalk on for everyone
who clones it?" Yes merges crosstalk's marketplace and plugin into the repo's
`.claude/settings.json`, keeping every other setting, and leaves it for you to
commit. After that, whoever clones the repo and trusts the folder in Claude Code
has crosstalk, with nothing to run.

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

**Works with** these terminals, for opening agents and restored sessions as
tabs, the state on each tab, and closing the tab a session leaves:

- **macOS:** Terminal.app (first), iTerm2, Ghostty, kitty, WezTerm.
- **Linux:** kitty (with remote control, `listen_on` set), WezTerm, GNOME
  Terminal, Konsole. GNOME Terminal and Konsole cannot close a tab from
  outside, so those stay open and crosstalk says so.
- **Windows:** Windows Terminal (`wt.exe`). Tabs are opened, never closed.
- **tmux**, anywhere: windows instead of tabs.

Anything else (Alacritty, xterm, …): inside tmux, tmux windows; otherwise
crosstalk prints the commands to paste. Details per terminal:
[docs/terminal.md](docs/terminal.md).

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

`/crosstalk:join --public` needs `cloudflared` already on your PATH. crosstalk
does not fetch it: a tool whose claim is that it holds no key it should not hold
has no business downloading an executable for you.

To call crosstalk from a build script or anything that is not a coding agent,
put it on your PATH once:

```
/crosstalk:install path
```

<br>

### Updating

**Nothing to run, once.** In any Claude session: `/plugin` → **Marketplaces** →
**epode** → **Enable auto-update**. Claude Code then installs each release in
the background, and the next session picks it up (crosstalk's background
process replaces itself). Repos where crosstalk is turned on for the team
have this set already.

**By hand, Claude Code**

```
claude plugin marketplace update epode
claude plugin update crosstalk@epode
```

Sessions you start afterwards run the new version, and the first of them
replaces crosstalk's background process if it is older (if the new one will
not start, the old one comes back and that version is left alone for an
hour). Sessions already open keep the old version until you restart them,
and each says so once, so nothing new is a mystery.

If `claude plugin marketplace list` shows `epode` as a **Folder** rather than
GitHub, it was added from a local copy and never sees a release. Switch it once;
your identity, people and threads are kept, since they live in
`~/.claude/crosstalk`, not in the plugin:

```
claude plugin marketplace remove epode
claude plugin marketplace add epode-studio/crosstalk
claude plugin install crosstalk@epode
```

Other agents update the way they installed it.

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

## People

**People you already work with need nothing.** Collaborators on a repository
are trusted through the SSH keys they publish on GitHub: each machine's
crosstalk identity is signed with the key you already use for git, and your
teammates check it against your GitHub keys. Your own machines find each other
the same way. If someone's key ever changes, that is a question to you, never
accepted silently.

**Four words, for anyone outside your repos**, a contractor or a friend on
another project:

```
/crosstalk:join

    3644-cherry-horn-cataract-redwing
```

Say them aloud, anywhere except through crosstalk. They run `/crosstalk:join`
with the same words (or tell their agent "join crosstalk with …"), you each read
a fingerprint aloud, and that is permanent. After that they are simply people
you work with: "the people you joined with words", in a thread like anyone else.

Either way a person ends up **verified**, the only level there is. You can mute
a person or a thread ("mute jo for an hour"); nothing else about who may
interrupt you needs configuring. [How it holds up](docs/security.md).

<br>

---

<br>

## Threads

A thread is a piece of work and the conversation about it. Nobody names one or
joins one: an agent on a work branch is in that branch's thread; on the default
branch, the thread whose files it touches. When it touches two threads' files
equally, you are asked once. A teammate's agent on the same branch or files
joins the thread too, and threads that turn out to be one piece of work combine,
telling everyone who can now read what.

Talking is per thread. Say "tell them the token format changed" and it goes to
the people in this thread, and reaches only their agents in it.

Every thread has four parts, and no others.

**Notes: what it knows.** One list, each note a decision, a fact, a task, a rule
or the recap. "We decided v1 stays until 0.2" is a decision with who and when;
"staging shares the demo database" is a fact anyone can confirm or correct; a
task is claimed before it is worked on, so two agents never do it twice; a rule
is an answer you gave twice, made standing. A fresh agent starts from the notes,
and digests, standups and pull request descriptions are read from them.

**Features: what ships.** Each is everyday or risky, with its flag and how far
it has rolled out, its evidence and its review. See
[Shipping without reading code](#shipping-without-reading-code).

**Running: what it runs and where to look.** One list: its dev servers by name
(`auth.localhost`), previews, pull requests, what you have shown to a teammate
or they to you, links its commands printed, and before and after screenshots,
each marked alive or dead. "What's the auth URL?", "open the billing preview"
and "show marie the auth page" all work from any agent.

**History: what it once had.** Every server, preview, pull request, link and
screenshot the thread ever had, and every note that ended (a task done, a fact
corrected), searchable: "what did the login page look like before the
redesign?" finds it with its date.

**You can see it.** "Show me auth" opens the thread beside the chat: its status
and people, what is waiting, then Notes, Features, Running and History. The
status line reads `◢ auth · auth.localhost:1355 · 1 for you`. None of it reaches
the model.

**Sealed unless public, and nothing bloats.** A thread is committed to its own
git ref, never your working tree or main's history, sealed so only its people
can read it, even in a public repo. Mark one public to commit it in plain text
and list it in `THREADS.md`. A thread nobody touches for 14 days archives down
to its decisions and rules; the rest moves to History.

<br>

---

<br>

## Questions

**Everything crosstalk asks of you is a question**, with its options as a
picker: "restore 6 agents?", "which thread is this part of?", "turn the flag on
for your own accounts?", "you answered this twice, always do it?". Answer with
the picker, by typing `@auth keep v1`, or in plain words to any agent. A
question waits for a pause in your typing and never interrupts a turn.

<br>

---

<br>

## Shipping without reading code

[How it works](docs/shipping.md). List the risky paths in
`.crosstalk/risk`, and when an agent says its work is ready:

- **Everyday work** merges on green checks and a review by a separate agent.
- **Risky work** (auth, payments, migrations, whatever you list) gets an
  adversarial reviewer on a different model, a preview deploy with its flag on,
  and ships behind a flag: dark first (the new path in shadow, mismatches
  counted), then your own accounts, then everyone. Each step is a question,
  with evidence and metrics, that any trusted person in the thread can answer
  from their own machine.
- **Flags instead of staging.** Merged means off; shipped means on. Rolling back
  is turning a flag off, which any agent may do, and crosstalk does by itself
  when metrics regress. An everyday flag goes to everyone by itself once its
  metrics hold. Flags live in **Unleash** first, or in LaunchDarkly, PostHog,
  GrowthBook, Statsig, or a plain `.crosstalk/flags` file.
- **Production reopens threads.** An alert that names a flag or a recent change
  reopens the thread that shipped it, and turns a risky flag off on the spot.
- **Merging is out of sight.** Straight to main, through a pull request that
  merges itself, or locally, as `.crosstalk/ship` says. Never a force push.

The measure is time from idea to merge, and how few of your minutes it took.

<br>

---

<br>

## Small things that add up

- **After a restart**, your first session offers to bring every agent back, in
  its tab, with its conversation. [How](docs/restore.md).
- **Agents you already had open** when you installed crosstalk are brought in
  once you say yes.
- **Dev servers outlive the agent.** "Run the dev server" starts it out of
  sight, on its own address, so parallel copies of the code never fight over
  :3000; the next agent is told what is running where, and nothing is
  restarted or removed under something still running. [How](docs/services.md).
- **Screenshots as evidence, servers that look after themselves.** After a turn
  that edits files, the thread's servers and previews are captured; each one's
  before and after go into its features' evidence, and "show me the auth page
  before and after" opens them. A server that crashes is restarted once, its
  agent told with the log, and if it keeps failing its tab turns red.
  [How](docs/urls.md#9-screenshots-as-evidence).
- **On the phone.** "Show me a QR for the billing preview" draws a QR code in
  the pane, for your eyes only. [How](docs/urls.md#6-on-the-phone).
- **Servers that just start.** A new copy of the code gets the main checkout's
  gitignored `.env`, `.dev.vars` and `config/*.local.*` (asked once per repo),
  never linked. They stay on this machine: names in results, never contents.
  [How](docs/urls.md#7-servers-that-just-start).
- **Show a teammate the running thing.** "Show marie the auth page" gives marie,
  and only marie, your running dev server as `http://auth.paul.localhost` on
  her machine, through crosstalk's encrypted channel: no public URL, no port
  forwarding, for eight hours unless you say otherwise; "stop showing it" cuts
  her off at once. [How](docs/urls.md#8-sharing-a-running-server).
- **Attach the thing, not a description of it.** "Send marie the diff": she sees
  a label and a size, and fetches it only if she needs it.
- **No commands to learn.** Say it to any agent: "marie gave me words: cherry
  horn…", "mute jo for an hour", "let marie ask me questions", "what's
  running?", "is crosstalk OK?". Four slash commands remain, each for something
  words in the conversation should not or cannot do: `/crosstalk:join` (the
  four words, kept out of the model), `/crosstalk:doctor` (when crosstalk itself
  is what is broken), `/crosstalk:install` (another agent, or your PATH) and
  `/crosstalk:secure` (your key into the macOS keychain).
- **Something broken is noticed for you.** Once a day, at the start of a
  session, crosstalk checks itself and says so only when something is wrong,
  with the fix.
- **"Open auth in my editor"**, **"what happened?"** (a digest, also one line
  above the prompt at a pause, at most every two hours), **"what did the team
  ship this week?"**, and pull requests that describe themselves from the
  thread's notes and evidence (a sealed thread keeps its notes out of the PR).
- **`@auth keep v1`**, **`@main`**, **`@restore`** at the prompt: optional
  shortcuts, never needed. `@<thread>` answers what that thread is waiting on.
- **Bots** are members that declare themselves agents (`--agent`). They post to
  threads, and nothing more: they never start or resume an agent on anyone's
  machine, never answer a question, and are never above notify.
- **Your disk back.** When Claude Code's finished copies and old sessions pass
  5 GB, one question: "free 14 GB from 6 finished threads?" Nothing is deleted
  without a yes.
- **A library tells its users.** When a thread changes a library's public
  surface, the threads of every repo on your machine that depends on it get a
  heads-up with the diff.
- **Leaving locks the door.** Someone who leaves a thread, or is taken out,
  gets nothing written after: the thread's key is replaced for whoever is left.
- **Numbers you can check.** "How is crosstalk doing?" shows, from this machine
  only, time from first edit to merge, your minutes per merged thread, questions
  answered by rules, and tokens to the first edit with and without a thread
  brief. Nothing is sent anywhere.

<br>

---

<br>

## What is here today

| | |
|---|---|
| Messages between people's agents, end to end encrypted | **here** |
| Trust through repository access, no words | **here** |
| Four words for people outside your repos | **here** |
| Threads, found automatically, synced and kept sealed on a hidden git ref | **here**, first version |
| Notes (decisions, facts, tasks, rules, recap) as one list per thread | **here**; threads written before it open and are rewritten on their next commit |
| Running and History per thread | **here**, first version |
| Messages reach the agent working on the same thing | **here** |
| Cards, pickers, the thread pane and status line in Claude Code | **here** (mod, 2.1.287+) |
| Restore every agent after a restart or crash | **here** |
| Opening and restoring agents in your terminal's tabs | **here** (Terminal.app, iTerm2, kitty, WezTerm, Ghostty, tmux, Windows Terminal) |
| Tidy up: idle sessions and empty tabs closed, similar sessions folded into one | **here**, first version (tabs close in Terminal.app and tmux) |
| Main session, answers become rules, agents warning each other | **here**, first version |
| Shipping: reviewer agents, evidence, flags, production reopening threads | **here**: Unleash first, plus LaunchDarkly, PostHog, GrowthBook and Statsig; previews, dark launches, metrics-driven ramps and kills |

What has not been checked in real use yet, part by part, is listed at the end
of [The next generation](docs/design/next-generation.md#not-yet-checked-in-real-use).

<br>

---

<br>

## How it works

The machinery behind the three nouns, for when you want to know. Each line
links to where it is written down in full.

- **Agents are Claude Code sessions.** crosstalk opens, restores, backgrounds
  and closes them in your terminal's tabs, and matches each to its threads by
  the repo, branch and files it touches. [Terminal](docs/terminal.md),
  [restore](docs/restore.md), [attention](docs/attention.md).
- **Copies of the code are git worktrees**, one per new agent, removed once
  merged. Each gets its own ports, and dev servers run in a background tmux
  that outlives the agent. [Services](docs/services.md).
- **Names instead of ports** come from a small local proxy, `auth.localhost`
  (`:1355` where port 80 needs privileges), which follows a server when its port
  moves, websockets and HMR included. [URLs](docs/urls.md).
- **Running is a view**, not a store: it reads the services, the URL records,
  the shares and the screenshots crosstalk already keeps
  (`src/threads/running.ts`). History is the thread's links section and its
  ended notes (`src/threads/history.ts`).
- **Threads are files on `refs/crosstalk/threads`**, one per thread, merged
  item by item (a Lamport clock, last writer wins per item, tombstones), sealed
  section by section to their people and pushed with your own git credentials.
  It gets a commit only when a status, feature, question, decision or rule
  changes. [The next generation](docs/design/next-generation.md#threads).
- **The relay** is a Cloudflare Worker that routes sealed messages and holds no
  key that opens them; you can host your own. [Worker](worker/),
  [a permanent one](deploy/), [transports](docs/transports.md).
- **Keys.** Each machine has its own identity, signed with your GitHub SSH key;
  four words run a password-authenticated key exchange.
  [Security](docs/security.md).
- **Flags** live with a provider (Unleash first) or in `.crosstalk/flags`;
  **reviewer agents** run on a different model for risky work.
  [Shipping](docs/shipping.md).
- **The main session** takes the questions that cut across threads.
  [Attention](docs/attention.md).
- **The mod** is what draws the cards, pickers, pane and status line, inside
  Claude Code's own UI, and keeps a message out of the model until you hand it
  over (`mod/`). Without it, crosstalk falls back to plain hooks.
- **Eight MCP tools**, each with an action: `thread`, `say`, `work`, `look`,
  `ship`, `people`, `answer`, `doctor`. [Tools](docs/tools.md).
- **Rooms** are how the protocol groups people joined with words; you never
  meet one. [Architecture](docs/architecture.md).

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

Without the mod, crosstalk still never injects a peer's words. It injects a
notice carrying their name and nothing they wrote, and the content comes back
through a tool call, where it arrives as data rather than as a vouched-for
request.

Notes work the same way. They are labelled as claims by named people, never as
instructions, and acting on one still needs you.

Joining with four words runs a password-authenticated key exchange, so the words
never leave your machine in any form, not even a hash. Guessing them costs a
live protocol run against a slot that works once, rather than an offline grind
against something the relay can see. Both fingerprints are still worth reading
aloud.

Permission relay across people is not implemented and never will be.

[Full security notes](docs/security.md).

<br>

---

<br>

## Docs

- [The next generation](docs/design/next-generation.md), the design this README describes, and what is still open
- [Tools](docs/tools.md), the eight an agent gets, each with its actions
- [Shipping](docs/shipping.md), features from ready to fully on
- [URLs](docs/urls.md), Running and History: every server, preview, PR, link and screenshot a thread has
- [Services](docs/services.md), dev servers that outlive agents, on each copy's own ports
- [Terminal](docs/terminal.md), tabs, status and what each terminal can do
- [Restore after a restart](docs/restore.md)
- [Attention](docs/attention.md), the main session, staffing and fresh starts
- [Security](docs/security.md), the threat model and what the relay can see
- [Clients](docs/clients.md), which agents are supported and how each is reached
- [Architecture](docs/architecture.md), how the pieces fit and what happens when a machine sleeps
- [Transports](docs/transports.md), what was tried for getting between two networks
- [Design notes on interruption](docs/design/attention.md)
- [Terminal as agent workspace](reports/Terminal%20as%20agent%20workspace.md), research into how far the terminal and Claude Code can be shaped
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

bun run test               # every suite below, in order
bash test/e2e.sh           # every feature, every client dialect, the MCP server
bash test/resilience.sh    # a sleeping relay host, catch-up, two daemons at once
bash test/mod.sh           # the mod: claude plugin validate, its types, claude plugin test
bun test test/snapshots/mod.test.ts   # what the mod draws, as text frames
bash test/docker/nat.sh    # two peers behind separate NATs  (needs Docker)
bash test/tunnel.sh        # --host, and join --public  (needs cloudflared)
```

What each one actually covers:

| | Assertions | Against |
|---|---|---|
| `e2e.sh` | 103 | two identities over the shared relay, and the hook dialect of all eight clients |
| `resilience.sh` | 13 | an unreachable relay, a restarted one, a frozen socket, catching up after an absence, two daemons on one state directory |
| `docker/nat.sh` | 12 | two peers on isolated networks, neither able to accept a connection |
| `tunnel.sh` | 2, or 11 | a LAN relay always; the nine behind a public tunnel only when Cloudflare issues one |
| `uistate.test.ts`, `ui.sh` | 23, 36 | what the mod shows: each card, route question and restore offer settled once and kept settled across restarts, exactly one restore surface, the classic notice back when the mod stops |
| `snapshots/mod.test.ts` | 12 frames | message cards at 60 and 120 columns, the pane with every section in light and dark, the question band, the status line; `UPDATE_SNAPSHOTS=1` writes them anew |
| `canary/drive.sh` | by hand | the shipped mod in a real Claude Code in tmux: what reaches the model, the transcript, history and a resumed session (`canary/drive-nomod.sh`: the same with mods off) |

`e2e.sh` runs against the relay you have configured, which by default is the
shared one, so it is a network test as much as a unit test. The snapshots are
of the trees the mod returns, laid out by a small renderer in `test/snapshots/`
with stand-in theme colours, not of Claude Code's own paint, which its test kit
does not expose.

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
one machine and join them together. That is how all of this was tested.
Issues and pull requests welcome.

<br>

---

<br>

## Licence

MIT.
