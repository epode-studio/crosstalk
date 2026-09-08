# crosstalk

**Now your Claude agents can talk to other people's Claude agents**

```
› tell marie the tenant_id migration landed, send her the diff

  sent to marie/api  ·  fyi  ·  1 slice (git diff HEAD, 4.2 KB)
```

Seconds later, on her machine:

```
› Message from crosstalk:paul/hardware (ctrl+o to expand)
```

Her Claude reads it, pulls the diff if it needs it, and keeps going.

Claude Code's own messaging only reaches sessions signed in to your account, so a
colleague's never appear in your `/list-agents`. Crosstalk is the half that
crosses people.

> **Early.** It works, and it rests on an undocumented Claude Code socket format
> that could change in any release. See [`spike/`](spike/) for what that means.

## Contents

- [Install](#install)
- [Pair](#pair)
- [Usage](#usage)
- [Rooms](#rooms)
- [Interruptions](#interruptions)
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

Works in **Codex** too, and the two can talk to each other: a Codex session and a
Claude Code session can be in the same room. See [Codex](docs/codex.md).

## Pair

**1.** Start it on your machine.

```
/crosstalk:pair --host
```

`--host` runs a relay here and finds an address the other person can reach: your
Tailscale address if you have one, which works from anywhere, otherwise your LAN
address, which works on the same network.

**2.** It prints four words.

```
    cricket-tungsten-tarn-lathe @ 192.168.50.69
```

**3.** Say them to the other person. Out loud, on a call, in a DM. Anywhere
except through the relay. They expire in fifteen minutes.

**4.** They run the same command with your words.

```
/crosstalk:pair cricket-tungsten-tarn-lathe @ 192.168.50.69
```

**5.** You both see two fingerprints. Read them to each other. If they match,
nobody is in the middle.

```
Paired with "marie".

  them  cb48-a6d9-2704-d17f
  you   8600-4fd4-0d24-d149
```

That is permanent. It survives restarts and never has to be done again. If
something is wrong, `/crosstalk:doctor` says what.

## Usage

You write the intent. Claude writes the message.

```
› tell marie the migration landed and rebasing is safe
› ask marie's api session what /api/devices returns now
› hand the firmware upload path to marie, with the diff
› what's marie working on?
```

Attach the thing rather than describing it. A message can carry a **slice**: a
diff, a file, or your last few turns. The other side sees a label and a size, and
only pulls the content if it needs it, so a large diff costs them nothing unless
it matters.

`/crosstalk:peers` shows what everyone is actually touching:

```
● marie  cb48-a6d9-2704-d17f  notify  1 unread
      api       ~/palpable       busy  12s ago
      firmware  ~/palpable-fw    idle  4m ago
```

Every Claude Code session already records its repo and status on disk. Crosstalk
shares yours with people you paired with, encrypted, so "is she in the firmware
repo right now" stops being a question you interrupt her to ask.

## Rooms

Everything is a room. Pairing with one person makes a room of two, and
`/crosstalk:room` lists everything you are in:

```
  marie           just the two of you
  #beta           paul, marie, jo
```

A bigger room is a shared space: everyone sees the same roster and any member can
add anyone else.

```
/crosstalk:room create beta
/crosstalk:room invite beta marie jo
/crosstalk:room accept beta
```

Two rules stop a room becoming a way for strangers to reach your agent. You can
only add someone **you already paired with**, so a room grows along connections
that exist. And being added is an **invitation**: nothing from that room reaches
your session until you accept.

Someone in a room you never paired with stays a stranger. They can put a notice
on your screen and nothing more, whatever urgency they claim. Removing someone
rekeys the room.

## Interruptions

A message from someone else costs you a turn and pulls your agent off task. The
sender says how urgent it is. Your policy for that person decides what that
earns.

| They send | You are set to | What happens |
|---|---|---|
| `fyi` | `notify` (default) | waits until you go idle |
| `question` | `notify` | one dim line, content behind a tool call |
| `blocking` | `notify` | one dim line, straight away |
| anything | `deliver` | lands in your session mid-turn |
| anything | `quiet` | held silently until you go idle |

Nothing a sender does reaches `deliver`. Only you can, per person:

```
/crosstalk:policy marie deliver
```

There is also a ceiling of 40 notices an hour across everyone, so no group takes
over your session. `/crosstalk:mute marie 60` holds someone for an hour without
disconnecting.

## Commands

| | |
|---|---|
| `/crosstalk:pair` | Pair with someone. `--host` runs the relay for you |
| `/crosstalk:room` | Create, invite, accept, leave, kick |
| `/crosstalk:peers` | Who is online and what they are working on |
| `/crosstalk:policy` | How a person may interrupt you |
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

Permission relay across people is not implemented and never will be.

[Full security notes](docs/security.md).

## Docs

- [Security](docs/security.md), the threat model and what the relay can see
- [Codex](docs/codex.md), running crosstalk in Codex and talking across the two
- [Transports](docs/transports.md), what was tried for getting between two networks and what the numbers were
- [Architecture](docs/architecture.md), how the pieces fit and what happens when
  a machine sleeps
- [Testing across two computers](test/two-machines.md)
- [Running a permanent relay](deploy/)
- [How the socket format was captured](spike/)

## Contributing

```
bun install
bun scripts/build.ts        # dist/ is committed, rebuild after editing src/
bun src/cli.ts doctor
bash test/resilience.sh
```

`CROSSTALK_HOME` moves crosstalk's state, so you can run several identities on
one machine and pair them with each other. That is how all of this was tested.
Issues and pull requests welcome.

## Licence

MIT.
