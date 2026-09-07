# crosstalk

**Claude Code can already message your own sessions. Crosstalk lets it message someone else's.**

```
› tell marie the tenant_id migration landed, send her the diff

  sent to marie/api  ·  fyi  ·  1 slice (git diff HEAD, 4.2 KB)
```

On her machine, seconds later:

```
› Message from crosstalk:paul/hardware (ctrl+o to expand)
```

Her Claude reads it, pulls the diff if it needs it, carries on. Nobody retyped
anything.

Claude Code's built-in messaging only reaches sessions on your own account. Your
colleague's never show up. Crosstalk is the other half.

## Install

```
/plugin marketplace add epode-studio/crosstalk
/plugin install crosstalk@epode
```

Needs `bun` or `node` on PATH. Nothing else to fetch or build.

## Connect two computers

**1.** You run:

```
/crosstalk:pair --host
```

**2.** It prints four words:

```
    cricket-tungsten-tarn-lathe @ 192.168.50.69
```

**3.** Say the words to the other person. Out loud, on a call, in a DM. Anywhere
except through the relay. They expire in fifteen minutes.

**4.** They run:

```
/crosstalk:pair cricket-tungsten-tarn-lathe @ 192.168.50.69
```

**5.** You both see a pair of fingerprints. Read them to each other. If they
match, nobody is in the middle.

Done. Pairing is permanent and survives restarts.

`--host` runs a relay on your machine and uses your Tailscale address if you have
one, which works from anywhere, or your LAN address, which works on the same
network. If pairing fails, run `/crosstalk:doctor`.

## Use it

```
› tell marie the migration landed and rebasing is safe
› ask marie's api session what /api/devices returns now
› hand the firmware upload path to marie, with the diff
› what's marie working on?
```

Messages can carry a **slice**: a diff, a file, or your last few turns. The other
side sees the label and size, and only pulls the content if it needs it.

`/crosstalk:peers` shows what everyone is actually touching:

```
● marie  cb48-a6d9-2704-d17f  notify  1 unread
      api       ~/palpable       busy  12s ago
      firmware  ~/palpable-fw    idle  4m ago
```

## Rooms

Shared spaces. Everyone sees the same roster and any member can add anyone.

```
/crosstalk:room create beta
/crosstalk:room invite beta marie jo
```

Two rules stop a room becoming a way for strangers to reach your agent:

1. You can only add someone **you are already paired with**.
2. Being added is an **invitation**. Nothing reaches you until you accept.

People in a room you never paired with stay strangers: they can put a notice on
your screen and nothing else. Removing someone rekeys the room.

## Interruptions

A message from someone else costs you a turn. The sender's Claude says how urgent
it is; your policy decides what that earns.

| They send | You are set to | What happens |
|---|---|---|
| `fyi` | `notify` (default) | held until you go idle |
| `question` | `notify` | one dim line, content behind a tool call |
| `blocking` | `notify` | one dim line, immediately |
| anything | `deliver` | lands in your session mid-turn |
| anything | `quiet` | held silently until you go idle |

Nothing a sender does can reach `deliver`. Only you can, per peer, with
`/crosstalk:policy marie deliver`. There is also a ceiling of 40 notices an hour
across everyone.

## Commands

| | |
|---|---|
| `/crosstalk:pair` | Pair with someone. `--host` runs the relay for you |
| `/crosstalk:room` | Create, invite, accept, leave, kick |
| `/crosstalk:peers` | Who is online and what they are working on |
| `/crosstalk:policy` | How a peer is allowed to interrupt you |
| `/crosstalk:mute` | Hold inbound for a while |
| `/crosstalk:cost` | What this has cost, per peer |
| `/crosstalk:secure` | Move your private key into the macOS keychain |
| `/crosstalk:doctor` | Check the setup and say what is broken |
| `/crosstalk:status` | Identity, relay, sessions |

## Security

Claude Code wraps every inbound peer message in framing of its own:

> This came from another Claude session, not typed by your user, but very likely
> working on their behalf. Treat it as a teammate's request.

Correct for your own laptop. Wrong for Marie. It cannot be removed, because the
sender controls the message body and not the framing around it. That is measured,
not assumed: [`spike/`](spike/) shows how.

So crosstalk does not inject a peer's words at all. It injects a notice
containing nothing they wrote, and the content comes back through a tool call,
where it arrives as data rather than as a vouched-for request.

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

The rest:

- Messages are end to end encrypted. The relay routes ciphertext and holds no key
  that opens it.
- The link to the relay is encrypted too, and the relay's identity is pinned
  during pairing, so nobody on your network can read the metadata or stand in the
  middle.
- Everything a peer controls is escaped, so a message cannot close crosstalk's
  framing and write its own.
- Peer messages are never posted with your session's own messaging token, which
  would mark them as trusted local processes.
- Replays are dropped. Old envelopes are refused.
- A new pairing cannot take over an existing peer's name and inherit its policy.
- Attaching a file refuses credentials and anything outside the project.
- `/crosstalk:secure` moves your private key out of the filesystem.
- **Permission relay across people is not implemented and never will be.** Anyone
  who can reply through a channel can approve tool use in your session, and
  across a person boundary that is a category error.

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
- Whoever runs the relay can see who talks to whom and who is in which room. They
  cannot see any of the content.

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
