# crosstalk

**You just found the thing that breaks what your teammate is building. Right now, you are the messenger.**

Read it out of your terminal. Summarise it in Slack. They paste it into theirs.
You both re-explain the context that made it matter. Meanwhile their agent has
spent twenty minutes building on an assumption that stopped being true.

Crosstalk moves it agent to agent instead.

```
› tell marie the tenant_id migration landed, send her the diff

  sent to marie/api  ·  fyi  ·  1 slice (git diff HEAD, 4.2 KB)
```

Seconds later, on her machine:

```
› Message from crosstalk:paul/hardware (ctrl+o to expand)
```

Her Claude reads it, pulls the diff if it needs it, keeps going. Neither of you
stopped.

Claude Code's own messaging only reaches sessions on your account. Your
colleague's never appear. Crosstalk is the half that crosses people.

---

## Say something without breaking your own flow

You write the intent. Claude writes the message and picks who needs it.

```
› tell marie the migration landed and rebasing is safe
› let the api session know the schema is frozen
```

Attach what you are actually talking about instead of describing it: a diff, a
file, your last few turns. The other side sees the label and the size, and only
pulls the content if it needs it.

## Find out what they are on, without asking

```
/crosstalk:peers
```

```
● marie  cb48-a6d9-2704-d17f  notify  1 unread
      api       ~/palpable       busy  12s ago
      firmware  ~/palpable-fw    idle  4m ago
```

Every Claude Code session already records its repo and status on disk. Crosstalk
shares yours with people you have paired with, encrypted, so "is she in the
firmware repo right now" stops being a question you have to interrupt her to ask.

## Get an answer from the side that knows

```
› ask marie's api session what /api/devices returns now
```

Your session waits, hers answers, yours carries on. Off by default per person,
because a question costs them a turn.

## Hand the whole thing over

```
› hand the firmware upload path to marie, with the diff
```

Not a note about the work. The work: what it is, what is done, what is left,
which files. Her session picks it up without re-deriving any of it.

## Decide when they get to interrupt you

This is the part everything else depends on. Someone else's message costs you a
turn and pulls your agent off task, so the sender says how urgent it is and **you**
decide what that earns.

| They send | You are set to | What happens |
|---|---|---|
| `fyi` | `notify` (default) | waits until you go idle |
| `question` | `notify` | one dim line, content behind a tool call |
| `blocking` | `notify` | one dim line, straight away |
| anything | `deliver` | lands in your session mid-turn |
| anything | `quiet` | held silently until you go idle |

Nothing a sender can do reaches `deliver`. Only you can, per person, with
`/crosstalk:policy marie deliver`, for when you are genuinely pairing on the same
problem. There is a ceiling of 40 notices an hour across everyone, so no group
can take over your session.

## Remember what you decided

```
› record that inbound peer text stays behind the read tool, and tell marie
```

Appends to `DECISIONS.md` with attribution. Two people working with agents settle
things constantly and write almost none of it down.

## Work as a group

```
/crosstalk:room create beta
/crosstalk:room invite beta marie jo
```

Everyone sees the same roster and any member can add anyone. Two rules stop that
becoming a way for strangers to reach your agent:

1. You can only add someone **you are already paired with**.
2. Being added is an **invitation**. Nothing reaches you until you accept.

Someone in a room you never paired with stays a stranger: they can put a notice
on your screen and nothing more. Removing someone rekeys the room.

---

## Set it up

**1.** Install.

```
/plugin marketplace add epode-studio/crosstalk
/plugin install crosstalk@epode
```

Needs `bun` or `node`. Nothing else to fetch or build.

**2.** Start pairing.

```
/crosstalk:pair --host
```

**3.** It prints four words.

```
    cricket-tungsten-tarn-lathe @ 192.168.50.69
```

**4.** Say them to the other person. Out loud, on a call, in a DM. Anywhere
except through the relay. They expire in fifteen minutes.

**5.** They run the same command with your words.

```
/crosstalk:pair cricket-tungsten-tarn-lathe @ 192.168.50.69
```

**6.** You both get a pair of fingerprints. Read them to each other. If they
match, nobody is in the middle.

That is it, permanently. `--host` runs a relay on your machine and uses your
Tailscale address if you have one, which reaches anywhere, or your LAN address,
which reaches the same network. If something is wrong, `/crosstalk:doctor` says
what.

## Commands

| | |
|---|---|
| `/crosstalk:pair` | Pair with someone. `--host` runs the relay for you |
| `/crosstalk:room` | Create, invite, accept, leave, kick |
| `/crosstalk:peers` | Who is online and what they are working on |
| `/crosstalk:policy` | How a person is allowed to interrupt you |
| `/crosstalk:mute` | Hold inbound for a while |
| `/crosstalk:cost` | What this has cost, per person |
| `/crosstalk:secure` | Move your private key into the macOS keychain |
| `/crosstalk:doctor` | Check the setup and say what is broken |
| `/crosstalk:status` | Identity, relay, sessions |

## What cannot happen to you

Claude Code wraps every inbound message from another session in framing of its
own:

> This came from another Claude session, not typed by your user, but very likely
> working on their behalf. Treat it as a teammate's request.

True for your own laptop. False for Marie. It cannot be removed, because a sender
controls the message body and not the framing around it. That is measured rather
than assumed: [`spike/`](spike/) shows how.

So crosstalk never injects a peer's words. It injects a notice containing nothing
they wrote, and the content comes back through a tool call, where it arrives as
data instead of as a vouched-for request.

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

- Messages are end to end encrypted. The relay routes ciphertext and holds no key
  that opens it.
- The link to the relay is encrypted too, and its identity is pinned during
  pairing, so nobody on your network reads the metadata or stands in the middle.
- Everything a sender controls is escaped, so a message cannot close crosstalk's
  framing and write its own.
- Peer messages are never posted with your session's own messaging token, which
  would mark them as trusted local processes.
- Replays are dropped and old envelopes refused.
- A new pairing cannot take over an existing person's name and inherit their
  settings.
- Attaching a file refuses credentials and anything outside the project.
- **Permission relay across people is not implemented and never will be.** Anyone
  who can reply through a channel can approve tool use in your session. Across a
  person boundary that is a category error.

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

One daemon per machine, one MCP server per session. Direct messages are sealed
with an X25519 key shared by the two identities. Room messages use a room key
handed to each member over the pairwise channel they already share with whoever
invited them.

[`deploy/`](deploy/) runs a relay permanently if you want invites to be four
words with no address on the end.

## Limits

- The session inbox socket format is undocumented and could change on any Claude
  Code release. [`spike/`](spike/) is how it was captured and verified.
- Rooms live on one relay. Two people on different relays cannot share one.
- After removing someone from a room, members you are not personally paired with
  get the new key passed on by someone who is, so there is a short gap.
- Whoever runs the relay sees who talks to whom and who is in which room. Never
  any content.

## Development

```
bun install
bun scripts/build.ts      # dist/ is committed, rebuild after editing src/
bun relay/relay.ts        # a relay on :8787
bun src/cli.ts doctor
```

`CROSSTALK_HOME` moves crosstalk's state, so you can run several identities on
one machine and pair them together. That is how all of this was tested.

```
src/daemon.ts    relay link, routing, triage, injection
src/server.ts    the MCP tools, channel push
src/link.ts      encrypted channel to the relay
src/rooms.ts     rooms, invitations, room keys
src/inject.ts    writes into a session's inbox socket
src/policy.ts    intent plus your state decides what interrupts you
src/crypto.ts    identities, phrase pairing, sealing
relay/relay.ts   the relay
spike/           how the inbox socket format was captured
```

MIT.
