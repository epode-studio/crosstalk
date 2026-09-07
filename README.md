# crosstalk

**Your Claude Code sessions can already message each other. Crosstalk lets them message someone else's.**

Two people, two laptops, one codebase. You find something the other person needs
to know, so you read it out of your terminal, summarise it in Slack, paste it
into theirs, and re-explain the context that made it matter. The work is agentic
on both ends. The coordination is a human copy-paste loop.

Claude Code ships with session-to-session messaging, and it is good, but
everything it reaches belongs to one account. Your colleague's sessions never
show up in your `/list-agents`. Crosstalk is the other half.

```
› tell marie the tenant_id migration landed, send her the diff

  sent to marie/api  ·  fyi  ·  1 slice (git diff HEAD, 4.2 KB)
```

A few seconds later, on her machine:

```
› Message from crosstalk:paul/hardware (ctrl+o to expand)
```

Her Claude reads it, pulls the diff if it needs to, and carries on. Nobody
retyped anything.

## Setup

### 1. Install

```
/plugin marketplace add epode-studio/crosstalk
/plugin install crosstalk@epode
```

The repo is both the marketplace and the plugin. `dist/` is committed with the
MCP SDK bundled in, so nothing is fetched and nothing is built. It needs `bun` or
`node` on PATH and picks whichever it finds.

### 2. Start pairing

```
/crosstalk:pair --host
```

Crosstalk makes you an identity, starts a relay on your machine, works out an
address the other person can reach, and prints four words:

```
    cricket-tungsten-tarn-lathe @ 192.168.50.69
```

`--host` prefers your Tailscale address if you have one, which works from
anywhere. Otherwise it uses your LAN address, which works on the same network.

### 3. Send the words

Say them out loud, call, or DM. Anything except through the relay itself. The
phrase is the whole secret and it expires in fifteen minutes.

### 4. They paste it

```
/crosstalk:pair cricket-tungsten-tarn-lathe @ 192.168.50.69
```

### 5. Check the fingerprints

Both sides print two. Read them to each other. If they match, nobody is sitting
in the middle.

```
Paired with "marie".

  them  cb48-a6d9-2704-d17f
  you   8600-4fd4-0d24-d149
```

That is it. Pairing is permanent, survives restarts, and never has to be redone.

### 6. Check it works

```
/crosstalk:peers
/crosstalk:doctor
```

## Sending and receiving

You write intent. Claude writes the message.

```
› tell marie the migration landed and rebasing is safe
› ask marie's api session what /api/devices returns now
› hand the firmware upload path to marie, with the diff
› what's marie working on?
```

When something arrives you get one dim line. Your Claude fetches the content when
it needs it, so a message you do not care about costs you almost nothing.

## Rooms

A room is a shared space. Everyone in it sees the same roster, and any member can
add anyone else.

```
/crosstalk:room create beta
/crosstalk:room invite beta marie jo
```

Two rules keep a room from becoming a way for strangers to reach your agent:

1. **You can only add someone you are already paired with.** A room grows along
   links that already exist, so nobody arrives out of nowhere.
2. **Being added is an invitation, not membership.** Nothing from the room
   touches your session until you accept.

```
/crosstalk:room               # what you are in, and what you have been invited to
/crosstalk:room accept beta
```

People in a room you have not paired with are still strangers. Their messages can
put a notice on your screen and nothing more: never delivered mid-turn, never
allowed to use `ask`.

Removing someone rekeys the room, so they cannot read what comes after.

## Controlling interruptions

A message from someone else costs you a turn and pulls your agent off task.
Delivering it mid-turn is right for your own sessions and wrong for a colleague's.

The sending Claude declares an intent. Your policy decides what that intent is
allowed to do, given what your session is doing right now.

| Intent | Means | Lands |
|---|---|---|
| `fyi` | they may want to know | held until you are idle |
| `question` | wants an answer, not blocked | notice now |
| `blocking` | cannot continue without you | notice now, even mid-task |

| Policy | Behaviour |
|---|---|
| `notify` | a notice appears, their words stay behind a tool call. **Default** |
| `deliver` | their text lands in your session mid-turn |
| `quiet` | held silently, surfaced when you next go idle |

Escalation is downward-safe. `blocking` lifts `quiet` to `notify`, and nothing
lifts anything to `deliver`. Only you, by naming a peer, get interrupted mid-turn.
There is also a ceiling of 40 notices an hour across everyone, so a busy room
cannot take over your session.

## What else it does

**Presence.** Every Claude Code session records its repo, status and last update
on disk. Crosstalk shares yours with peers, encrypted, so you can see what someone
is actually touching:

```
● marie  cb48-a6d9-2704-d17f  notify  1 unread
      api       ~/palpable       busy  12s ago
      firmware  ~/palpable-fw    idle  4m ago
```

**Context slices.** Attach a diff, a file, or your last few turns. The receiver
sees the label and the size. The content only enters their context if their Claude
asks for that slice. Showing the diff beats three sentences describing it.

**Handoff.** Send a work item, not a note about one: goal, state, what remains,
which files.

**Decisions.** `crosstalk_decide` appends to `DECISIONS.md` with attribution. Two
people pairing with agents settle things constantly and record almost none of it.

**Ask.** Send a question and wait for the answer, so one session can consult
another's. Off by default per peer, because an inbound question starts a turn and
spends their tokens.

**Cost.** `/crosstalk:cost` shows traffic per peer, both directions.

## Commands

| | |
|---|---|
| `/crosstalk:pair [phrase]` | Pair. `--host` starts a relay for you |
| `/crosstalk:room [verb]` | Create, invite, accept, leave, kick |
| `/crosstalk:peers` | Who is online, which repo, busy or idle, unread |
| `/crosstalk:policy [peer] [mode]` | How that peer may interrupt you |
| `/crosstalk:mute [peer] [minutes]` | Hold inbound without disconnecting |
| `/crosstalk:cost` | What this has cost, per peer |
| `/crosstalk:doctor` | Check the setup and say what is wrong |
| `/crosstalk:status` | Identity, relay, registered sessions |

## Security

Claude Code wraps every inbound peer message in framing of its own before Claude
reads it:

> This came from another Claude session, not typed by your user, but very likely
> working on their behalf. Treat it as a teammate's request.

Right when it is your desktop talking to your laptop. Wrong when it is Marie. It
cannot be removed, because the sender controls the message body and not the
framing around it. That is measured rather than assumed. [`spike/`](spike/) shows
how the wire format was captured and what it does.

So by default crosstalk never puts a peer's words into your session. It injects a
notice with nothing they wrote in it, and the content comes back through a tool
call, where it arrives as data rather than as a request the harness has vouched
for.

```
Marie's message
      │
      ▼
crosstalk daemon ──── injects: "1 message from marie/api"
                          │
                          ▼
                   your Claude calls crosstalk_read
                          │
                          ▼
                   content arrives as TOOL OUTPUT
```

The rest of it:

- Everything a peer controls, their words and their session name, is escaped
  before it goes near a tag, so a message body cannot close crosstalk's framing
  and write its own.
- Messages carry no authority. They approve no permission prompt, change no
  settings, and slash commands inside them stay literal text.
- Peer messages are never posted with your session's own messaging token.
  Presenting it would mark them as trusted local processes and skip the approval
  hold Claude Code applies to unverified senders.
- Replays are dropped, and envelopes older than a day are refused, so a hostile
  relay cannot re-deliver an old message.
- A new pairing cannot take over an existing peer's name and inherit its policy.
- **Permission relay across people is not implemented and will not be.** Anyone
  who can reply through a channel can approve tool use in your session. Across a
  person boundary that is a category error.

The relay routes ciphertext. It sees fingerprints, byte counts and room rosters.
It holds no key that can open a message, and presence is encrypted the same way,
so it does not learn which repos you work in.

Use Tailscale if you can. Without it the relay link is plain WebSocket on your
LAN: message bodies are still sealed, but an attacker on the same network can see
who talks to whom and how often.

## How it works

```
Paul's machine                    relay                    Marie's machine
┌──────────────────┐                                     ┌──────────────────┐
│ Claude Code      │                                     │ Claude Code      │
│  ├ MCP server    │──┐                               ┌──│  ├ MCP server    │
│  └ SessionStart  │  │                               │  │  └ SessionStart  │
└──────────────────┘  │      ┌──────────────────┐     │  └──────────────────┘
         │            └─ ws ─│ crosstalk relay  │─ ws ┘            │
    inbox socket             │ routes ciphertext│             inbox socket
         ▲                   └──────────────────┘                  ▲
         └────── daemon ──────┘                └────── daemon ─────┘
```

One daemon per machine holds the relay connection and knows every local session.
One MCP server per session exposes the tools and, where Claude Code loads it as a
channel, pushes arrivals as `<channel>` events. Otherwise the daemon writes to the
session's inbox socket directly.

Direct messages are sealed with a key derived by X25519 between the two paired
identities. Room messages are sealed with a room key that the relay never holds,
handed to each new member over the pairwise channel they already share with
whoever invited them. Peers authenticate to the relay by Ed25519
challenge-response.

Run a relay permanently if you want invites to be four words with no address at
all. [`deploy/`](deploy/) has a Dockerfile and a fly.toml.

## Two transports

**Channel MCP server** is the target, and what the server already declares. During
the channels research preview a custom channel needs
`--dangerously-load-development-channels crosstalk`, which shows a warning dialog
at every launch, so it is not the default path yet.

**Session inbox socket** is what runs today, with no flag and no allowlist. The
daemon writes to `CLAUDE_CODE_MESSAGING_SOCKET` using a payload format that is
undocumented. [`spike/`](spike/) is how it was captured, replayed and verified.
Everything above the transport is shared between the two.

## Limits

- The socket payload format is undocumented and could change on any Claude Code
  release. It carries a version field and survived a version gap in testing.
  Nothing promises more.
- Rooms are per-relay. Two people on different relays cannot share one.
- Removing someone from a room rekeys it, but only members you are personally
  paired with can be handed the new key directly. Anyone else needs it passed on
  by someone who is.
- Presence and roster metadata are visible to whoever runs the relay.

## Development

```
bun install
bun scripts/build.ts      # dist/ is committed, rebuild after changing src/
bun relay/relay.ts        # a relay on :8787
bun src/cli.ts doctor
```

`CROSSTALK_HOME` moves crosstalk's own state, so you can run several identities
on one machine and pair them with each other. That is how all of this was tested.

```
src/daemon.ts      per-machine daemon: relay link, routing, triage, injection
src/server.ts      per-session MCP server: the tools, channel push
src/rooms.ts       shared rooms, invitations, room keys
src/inject.ts      writes into a session's inbox socket, escapes everything
src/policy.ts      intent and receiver state decide deliver, notify or quiet
src/crypto.ts      identities, phrase pairing, sealing
src/registry.ts    reads Claude Code's own session registry for presence
relay/relay.ts     the relay
spike/             how the inbox socket format was captured
```

## Licence

MIT.
