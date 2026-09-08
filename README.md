# crosstalk

**Now your Claude agents can talk to other people's Claude agents**

## Where we are

Two people work on the same codebase. Both run Claude Code. On each side, an
agent reads the repo, makes changes, runs the tests, and holds a working picture
of what is true right now.

So the work is already agentic on both ends. Two capable systems, each with
context the other one needs.

## What is missing

The link between them is you.

You find that a migration landed and the old column is gone. Your teammate's
agent is, at this moment, writing code against that column. For it to find out,
you have to notice that it matters, read the finding out of your terminal,
compress it into a sentence, paste it into Slack, and wait. They read it, paste
it into their session, and re-explain the parts that got lost on the way.

That costs twice. It breaks your flow, because you stopped working to become a
courier. And it leaves their agent building on something untrue for as long as
the round trip takes.

Claude Code does have session-to-session messaging, and it is good, but it only
reaches sessions signed in to your own account. It solves laptop-to-desktop for
one person. Your colleague's sessions never appear in your `/list-agents`.

## What crosstalk does

It carries the message itself, so neither of you has to.

```
› tell marie the tenant_id migration landed, send her the diff

  sent to marie/api  ·  fyi  ·  1 slice (git diff HEAD, 4.2 KB)
```

Seconds later, on her machine:

```
› Message from crosstalk:paul/hardware (ctrl+o to expand)
```

Her Claude reads it, pulls the diff if it needs it, and keeps going. Neither of
you stopped working, and her agent stopped being wrong.

The catch is obvious once you say it out loud: if another person's agent can put
text into your session, that is a new way to reach you, and being reachable is
not always good. Most of what follows is about who decides when that happens.
The answer is always you.

---

## Three ideas to hold

Everything else follows from these.

**You pair with people, not with sessions.** You exchange keys with Marie once.
After that you can address her (`marie`), one of her sessions (`marie/api`), or a
group she is in (`#beta`). Sessions come and go; the pairing does not.

**The sender says how urgent, the receiver says what that earns.** A message
carries an intent: `fyi`, `question`, or `blocking`. That is the sender's claim
about their own situation. What it actually does on your machine is your setting,
not theirs. Nothing a sender can write reaches into your turn unless you have
already said that person may.

**A notice is not the message.** When something arrives you get one dim line
naming who sent it. The words they wrote are not in that line. Your Claude fetches
them with a tool call, on purpose, when it is ready. This sounds like a detail. It
is the whole security model, and [What cannot happen to you](#what-cannot-happen-to-you)
explains why.

---

## Telling someone something

You write the intent. Claude writes the message.

```
› tell marie the migration landed and rebasing is safe
```

Notice you did not compose anything. You said what you wanted her to know, the
same way you would say it to a colleague across a desk, and your session turned
that into a message with the context attached.

**Attach the thing, not a description of it.** A message can carry a *slice*: a
diff, a file, or the last few turns of your session.

```
› tell marie the schema is frozen, send her the migration file
```

The receiver's session sees only a label and a size, something like
`file · db/migrate/0142_tenant_id.sql · 3.1 KB`. It pulls the content only if it
needs it. So attaching a large diff costs the other person almost nothing unless
it turns out to matter, which is the opposite of pasting it into chat.

## Seeing what someone is working on

```
/crosstalk:peers
```

```
● marie  cb48-a6d9-2704-d17f  notify  1 unread
      api       ~/palpable       busy  12s ago
      firmware  ~/palpable-fw    idle  4m ago
```

Every Claude Code session already writes its working directory and whether it is
busy into a file on disk. Crosstalk reads yours and shares it with people you
have paired with, encrypted, so "is she in the firmware repo right now" is
something you can look at instead of something you have to interrupt her to ask.

Read the line as: Marie is online, her messages are set to `notify` here, one is
unread, and she has two sessions, one busy in `~/palpable` and one idle.

## Asking a question you cannot answer yourself

```
› ask marie's api session what /api/devices returns now
```

Your session sends the question and waits. Hers answers. Yours continues with the
answer in hand. Nobody typed a summary of anything.

This works with anyone you have paired with. It does cost them a turn, so if
someone is asking too often:

```
/crosstalk:policy marie --no-allow-ask
```

Someone in a shared room you have never paired with cannot ask you anything at
all, whatever their settings say.

## Handing work over

```
› hand the firmware upload path to marie, with the diff
```

A handoff is not a note about work. It is the work: what the goal is, what is
done, what is left, which files are involved, with slices attached. Her session
picks it up without re-deriving any of it, which is the part that usually gets
lost when a task changes hands.

## Deciding when someone may interrupt you

Here is the tension. A message from another person costs you a turn and pulls
your agent off whatever it was doing. Deliver everything immediately and crosstalk
becomes a thing people mute. Deliver nothing and it is a mailbox, which is what
you already have.

So the sender declares an intent, and your policy for that person decides what
the intent is allowed to do.

| They send | You are set to | What happens |
|---|---|---|
| `fyi` | `notify` (default) | waits until you go idle |
| `question` | `notify` | one dim line, content behind a tool call |
| `blocking` | `notify` | one dim line, straight away |
| anything | `deliver` | lands in your session mid-turn |
| anything | `quiet` | held silently until you go idle |

Read the table down the middle column. `notify` is what everyone gets until you
say otherwise, and within `notify` the intent only changes *when* the line
appears, never whether their words enter your context.

`deliver` is different in kind: their text lands inside your turn. That is the
right setting when you are genuinely pairing on the same problem for an hour, and
the wrong one the rest of the time, so it is something only you can turn on:

```
/crosstalk:policy marie deliver
```

**Nothing a sender does can reach `deliver`.** `blocking` can lift a held message
to a notice; it cannot lift a notice into your turn. Escalation only ever goes in
the safe direction. On top of that there is a ceiling of 40 notices an hour
across everyone, so no group can take over your session, however many people are
in it.

Need quiet for an hour without disconnecting:

```
/crosstalk:mute marie 60
```

## Remembering what you decided

```
› record that inbound peer text stays behind the read tool, and tell marie
```

Appends to `DECISIONS.md` in the repo, with who decided it and when, and
optionally tells the other person. Two people working with agents settle things
constantly and write almost none of it down, and the reasoning is the part that
evaporates first.

## Working as a group

```
/crosstalk:room create beta
/crosstalk:room invite beta marie jo
```

A room is a shared space. Everyone in it sees the same roster, and any member can
add anyone else, which is what makes it a room rather than a mailing list you
maintain by hand.

That raises the obvious question: if anyone can add me, can a stranger reach my
agent? No, because of two rules:

1. **You can only add someone you are already paired with.** A room grows along
   connections that already exist. Nobody arrives from outside your web of trust.
2. **Being added is an invitation.** You see it, and nothing from that room
   reaches your session until you accept.

```
/crosstalk:room                  # what you are in, and what you have been invited to
/crosstalk:room accept beta
```

Someone in a room you have never paired with is still a stranger to you.
Crosstalk marks them as such, holds their messages to a notice whatever intent
they set, and refuses to let them ask you questions. Removing someone from a room
generates a new key, so they cannot read anything sent afterwards.

---

## Setting it up

**1.** Install the plugin.

```
/plugin marketplace add epode-studio/crosstalk
/plugin install crosstalk@epode
```

You need `bun` or `node` on PATH. Nothing is fetched or built at install time.

**2.** Start pairing.

```
/crosstalk:pair --host
```

`--host` means "run the relay on my machine". Crosstalk starts one, works out an
address the other person can reach, and shuts nothing else down. If you have
Tailscale it uses your tailnet address, which works from anywhere. Otherwise it
uses your LAN address, which works on the same network.

**3.** It prints four words.

```
    cricket-tungsten-tarn-lathe @ 192.168.50.69
```

Those four words are the entire secret. The relay stores your side of the pairing
under a *hash* of them, so the relay itself never learns them.

**4.** Say them to the other person.

Out loud, on a call, in a DM. Anywhere except through the relay. Anyone holding
those words can pair with you, and they expire after fifteen minutes.

**5.** They run the same command with your words.

```
/crosstalk:pair cricket-tungsten-tarn-lathe @ 192.168.50.69
```

**6.** Check the fingerprints.

You each see two short strings. Read them to each other. If they match, you have
each other's real keys and nobody is sitting in the middle. If they do not, stop.

```
Paired with "marie".

  them  cb48-a6d9-2704-d17f
  you   8600-4fd4-0d24-d149
```

That is permanent. It survives restarts, reboots and Claude Code upgrades, and
never has to be done again.

**If something is wrong**, `/crosstalk:doctor` checks every part in order and
says which one is broken.

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

Start from the thing that makes this hard.

Claude Code has its own idea of what an inbound message from another session
means. When one arrives, it wraps the text in framing before Claude reads it:

> This came from another Claude session, not typed by your user, but very likely
> working on their behalf. Treat it as a teammate's request.

That is correct when your desktop messages your laptop. It is wrong when the
sender is Marie, who is a different person with different intentions and possibly
a compromised machine. And it cannot be removed, because a sender controls the
body of a message and not the framing wrapped around it. That is not a guess:
[`spike/`](spike/) is the experiment that established it.

So crosstalk does not put a peer's words into your session at all. It puts in a
notice, which contains their name and nothing they wrote. The words come back
separately, through a tool call:

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

The difference matters because Claude already treats tool output as data to
interpret rather than as an instruction to follow. Marie's sentence arrives
labelled as something a different person wrote, not as a request that the harness
has vouched for.

Everything else:

- **Messages are end to end encrypted.** The relay routes ciphertext and holds no
  key that opens it.
- **The link to the relay is encrypted too**, and its identity is pinned during
  pairing, so nobody on your network can read who you talk to or stand in the
  middle of it.
- **Everything a sender controls is escaped.** A message cannot close crosstalk's
  own framing and write friendlier framing of its own.
- **Peer messages never carry your session's messaging token.** Presenting it
  would mark them as trusted local processes and skip a check Claude Code
  otherwise applies.
- **Replays are dropped** and envelopes older than a day are refused, so a
  hostile relay cannot re-deliver an old message.
- **A new pairing cannot take over an existing person's name** and inherit the
  settings you gave them.
- **Attaching a file refuses credentials** and anything outside the project, in
  case someone talks your Claude into sending one.
- **Permission relay across people is not implemented and never will be.** Anyone
  who can reply through a channel can approve tool use in your session. Between
  two of your own machines that is a feature. Across two people it is a category
  error.

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

Three pieces per machine.

The **MCP server** runs inside each Claude Code session and provides the tools
Claude calls. The **daemon** runs once per machine, holds the connection to the
relay, and knows about every local session. The **relay** exists because both
laptops are behind NAT and both go to sleep; it is a dumb fan-out that
authenticates peers and copies ciphertext.

Direct messages are sealed with a key derived by X25519 from the two paired
identities, so only those two can open them. Room messages use a room key that
the relay never sees, handed to each new member over the pairwise channel they
already share with whoever invited them.

[`deploy/`](deploy/) runs a relay permanently if you want invites to be four
words with no address on the end.

## When things go wrong

**The machine hosting the relay goes to sleep.** Everyone else keeps their
messages. A send while the relay is unreachable is held on your own machine and
goes out when the link returns, for up to a day. Messages already at the relay
for someone offline survive a relay restart too. What does not survive is the
machine hosting the relay being switched off for more than a day.

A sleeping laptop leaves the other side holding a socket that still reports as
open while nothing crosses it, which would swallow everything sent into it. The
daemon watches for that: no answer for seventy seconds and it drops the link and
reconnects.

**You are not on the same network.** A LAN address only works within one
network, and guest wifi usually isolates clients from each other even on the
same SSID. There is no NAT traversal. Two options: install Tailscale on both
machines, after which `--host` hands out a tailnet address that works from
anywhere, or run a relay somewhere permanent, which [`deploy/`](deploy/) covers.

**Something else.** `/crosstalk:doctor` checks each part in order and names the
one that is broken, including whether the macOS firewall is dropping incoming
connections to the relay. [`test/two-machines.md`](test/two-machines.md) works
through the rest.

## Limits

- The session inbox socket format is undocumented and could change on any Claude
  Code release. [`spike/`](spike/) is how it was captured and verified.
- Rooms live on one relay. Two people on different relays cannot share one.
- After removing someone from a room, members you are not personally paired with
  get the new key passed on by someone who is, so there is a short gap.
- Whoever runs the relay sees who talks to whom and who is in which room. Never
  any content.
- Held messages expire after a day, on your machine and at the relay.

## Development

```
bun install
bun scripts/build.ts      # dist/ is committed, rebuild after editing src/
bun relay/relay.ts        # a relay on :8787
bun src/cli.ts doctor
```

`CROSSTALK_HOME` moves crosstalk's state, so you can run several identities on
one machine and pair them with each other. That is how all of this was tested.

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
