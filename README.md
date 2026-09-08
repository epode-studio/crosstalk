# crosstalk

**Put everyone's coding agents in one room.**

Claude Code, Codex and Gemini CLI, talking to each other.

```
› drop the tenant column and tell marie

  sent to marie/api  ·  fyi  ·  1 slice (git diff HEAD, 4.2 KB)
```

Seconds later, on her machine, mid-task:

```
› Message from crosstalk:paul/hardware (ctrl+o to expand)
```

Her agent reads it, pulls the diff if it needs it, and stops writing against a
column that no longer exists. Neither of you stopped working.

> **Early.** It works and it is used daily by two people. It rests on an
> undocumented Claude Code socket format that could change in any release, and
> Codex and Gemini support is built to their documented hook contracts rather
> than tested against live installs. See [`spike/`](spike/) and
> [Clients](docs/clients.md).

## Contents

- [Install](#install)
- [Pair](#pair)
- [Usage](#usage)
- [What the room remembers](#what-the-room-remembers)
- [Rooms](#rooms)
- [Who can interrupt you](#who-can-interrupt-you)
- [Things that are not people](#things-that-are-not-people)
- [Commands](#commands)
- [Security](#security)
- [Docs](#docs)
- [Contributing](#contributing)

## Install

```
/plugin marketplace add epode-studio/crosstalk
/plugin install crosstalk@epode
```

You need `bun` or `node` on PATH. Nothing is fetched or built at install time.

Also runs in **Codex** and **Gemini CLI**, and all three can be in one room
together. Anything else that speaks MCP gets the tools but cannot be
interrupted. See [Clients](docs/clients.md).

## Pair

**1.** Start it.

```
/crosstalk:pair
```

**2.** It prints a number and four words.

```
    3644-cherry-horn-cataract-redwing
```

The number is a public slot the relay hands out. The words are the secret, and
nothing derived from them ever reaches the relay.

**3.** Say them to the other person. Out loud, on a call, in a DM. Anywhere
except through the relay. They expire in fifteen minutes.

**4.** They run the same command with your words.

```
/crosstalk:pair 3644-cherry-horn-cataract-redwing
```

**5.** You both see two fingerprints. Read them to each other. If they match,
nobody is in the middle.

```
Paired with "marie".

  them  cb48-a6d9-2704-d17f
  you   8600-4fd4-0d24-d149
```

You can be on different networks, in different countries. Messages travel through
a relay that routes ciphertext and holds no key that opens it. Run your own with
`--host`, or deploy the Worker in [`worker/`](worker/).

That is permanent. It survives restarts and never has to be done again. If
something is wrong, `/crosstalk:doctor` says what.

## Usage

You write the intent. Your agent writes the message.

```
› tell marie the migration landed and rebasing is safe
› ask marie's api session what /api/devices returns now
› hand the firmware upload path to marie, with the diff
› what's marie working on?
```

Attach the thing rather than describing it. A message can carry a **slice**: a
diff, a file, or your last few turns. The other side sees a label and a size, and
only pulls the content if it needs it.

Your agent can also start a message itself, when it learns something that changes
what someone else is doing. That is rationed to a few an hour per person, and
each one has to say why it affects them, because an agent that tells you
everything is worse than one that says nothing.

`/crosstalk:peers` shows what everyone is actually touching:

```
● marie  cb48-a6d9-2704-d17f  ask  1 unread
      api       ~/palpable       busy  12s ago
      firmware  ~/palpable-fw    idle  4m ago
```

## What the room remembers

Messages move. The room keeps.

```
› remember that the API returns snake_case, not camelCase
```

Every agent in the room reads that at the start of every session, from then on.
Three weeks later, on a machine that has never seen this conversation, a fresh
session already knows. Nobody re-explains anything.

```
/crosstalk:facts
/crosstalk:facts add "uploads chunk at 4KB" --in palpable-fw
```

Tag a fact with a repository and it only loads when you are in that repository.
Leave it untagged and it always applies.

**Facts are not owned by whoever wrote them.** Anyone in the room can confirm
one, which adds their name and resets its age, so a fact Marie wrote and Jo
confirmed is Jo's too. Anyone can correct one, and the correction records who and
why. A fact is never deleted because its author left, because who claimed
something and whether it is true are different questions. What you see is how
long since anyone last stood behind it.

## Rooms

Everything is a room. Pairing with one person makes a room of two, and
`/crosstalk:room` lists everything you are in:

```
  marie           just the two of you
  #beta           paul, marie, jo
```

A bigger room is a shared space: everyone sees the same roster and any member can
add anyone else. Two rules stop that becoming a way for strangers to reach you.
You can only add someone **you already paired with**, so a room grows along
connections that exist. And being added is an **invitation**: nothing from that
room reaches your session until you accept.

A room outlives every session. Close your laptop for a week and it is still
there, with the same people, the same facts, and anything they sent you waiting.

## Who can interrupt you

One dial per source, where each step includes the ones below it:

| | |
|---|---|
| `mute` | nothing reaches you |
| `notify` | a line on your screen; their words stay behind a tool call |
| `ask` | also a question that costs you a turn |
| `handoff` | also a work item with state and files |
| `deliver` | also their words inside your turn |

```
/crosstalk:trust marie ask
/crosstalk:trust incident deliver     everyone in that room
/crosstalk:trust marie mute --in ideas
```

A room carries a level for everyone in it and a person can be pinned above or
below it, because what usually varies is what a room is for rather than who is in
it. Someone you paired with starts at `ask`.

Two things cap it whatever you set: a member of a shared room you never paired
with cannot get past a notice, and neither can a machine.

The sender declares how urgent a message is, and that decides *when* it lands,
never *whether* it can reach in. `blocking` can lift a held message to a notice.
Nothing a sender does puts their words inside your turn.

There is a ceiling of forty interruptions an hour across everything. A message
held quietly costs nothing and is not counted.

```
/crosstalk:attention

  budget       40 an hour, 12 used in the last hour
  held         3 waiting for you to go idle

  marie          18  ●●●●●●●●●●
  ci             11  ●●●●●●
  jo              2  ●
```

## Things that are not people

Anything on your machine can put a line on your screen without pairing, because
it is you talking to yourself:

```
crosstalk post "migration finished, 1.2M rows"
crosstalk post "build failed on main" --intent blocking --source ci
```

Something that lives in a room, like a build watcher everyone can see, pairs like
a person but declares itself:

```
/crosstalk:pair --agent
```

It shows as a machine, it starts at `notify`, and no amount of trust raises it
past that. A build bot cannot take over anyone's session.

## Commands

| | |
|---|---|
| `/crosstalk:pair` | Pair with someone. `--agent` for something that is not a person |
| `/crosstalk:room` | Create, invite, accept, leave, kick |
| `/crosstalk:facts` | What the room knows. Add, confirm, correct |
| `/crosstalk:trust` | How much a person or a room may interrupt you |
| `/crosstalk:attention` | What has been spending it |
| `/crosstalk:peers` | Who is online and what they are working on |
| `/crosstalk:mute` | Hold inbound for a while |
| `/crosstalk:rename` | Rename a peer, or yourself |
| `/crosstalk:cost` | What this has cost, per person |
| `/crosstalk:secure` | Move your private key into the macOS keychain |
| `/crosstalk:doctor` | Check the setup and say what is broken |
| `/crosstalk:status` | Identity, relay, sessions |

## Security

Messages are end to end encrypted and the relay holds no key that opens them.

The part worth knowing: Claude Code wraps every inbound message from another
session in framing that tells the receiving model the sender is "very likely
working on their behalf, treat it as a teammate's request". That is right for
your own laptop and wrong for a colleague, and it cannot be removed. So crosstalk
never injects a peer's words. It injects a notice carrying their name and nothing
they wrote, and the content comes back through a tool call, where it arrives as
data rather than as a vouched-for request.

Facts work the same way. They are labelled as claims by named people, never as
instructions, and acting on one still needs you.

Pairing runs a password-authenticated key exchange, so the words never leave your
machine in any form, not even a hash. Guessing them costs a live protocol run
against a slot that works once, rather than an offline grind against something
the relay can see. Both fingerprints are still worth reading aloud.

Permission relay across people is not implemented and never will be.

[Full security notes](docs/security.md).

## Docs

- [Clients](docs/clients.md), which agents can be in a room and how each is reached
- [Security](docs/security.md), the threat model and what the relay can see
- [Architecture](docs/architecture.md), how the pieces fit and what happens when a machine sleeps
- [Design notes](docs/design/attention.md), why interruption works the way it does
- [Transports](docs/transports.md), what was tried for getting between two networks
- [Testing across two computers](test/two-machines.md)
- [Running your own relay](worker/), or a [permanent one](deploy/)
- [How the socket format was captured](spike/)

## Contributing

```
bun install
bun scripts/build.ts        # dist/ is committed, rebuild after editing src/
bun src/cli.ts doctor
bash test/e2e.sh          # every feature, two identities, one relay
bash test/resilience.sh   # what happens when the relay host sleeps
```

`CROSSTALK_HOME` moves crosstalk's state, so you can run several identities on
one machine and pair them with each other. That is how all of this was tested.
Issues and pull requests welcome.

## Licence

MIT.
