# How it works

```
Paul's machine                    relay                    Marie's machine
┌──────────────────┐                                     ┌──────────────────┐
│ Claude Code      │                                     │ Codex, Goose,    │
│  ├ MCP server    │──┐                               ┌──│ Cursor, any of   │
│  └ hook          │  │                               │  │ the eight        │
└──────────────────┘  │      ┌──────────────────┐     │  └──────────────────┘
         │            └─ ws ─│ crosstalk relay  │─ ws ┘            │
    inbox socket             │ routes ciphertext│              or a hook
         ▲                   └──────────────────┘                  ▲
         └────── daemon ──────┘                └────── daemon ─────┘
```

The two ends do not have to be the same client, and neither end can tell what
the other is running. The relay routes sealed messages between identities.

Three pieces per machine.

The **MCP server** runs inside each agent session and provides the tools it
calls. The **hook** tells the daemon a session exists and carries messages into
it. The **daemon** runs once per machine, and only once: it holds the connection
to the relay and knows about every local session. The **relay** exists because both
laptops are behind NAT and both go to sleep. It is a dumb fan-out that
authenticates peers and copies ciphertext.

## Which session a message reaches

Each local session has a footprint: the repo remote and branch of its working
directory, read from git, and the files its tool calls touched, reported by the
`PostToolUse` hook. Every message a session sends carries a short summary of its
own footprint inside the sealed body.

On arrival the daemon delivers to the session the sender named, if there is
one. Otherwise it scores each local session against the message's footprint: a
different repo scores nothing, the same repo scores, the same branch outranks
any amount of file overlap, and shared files and directories break the rest.
The best session gets it. When none scores or two score the same, nothing is
delivered: the message is held and the session you touched last is asked where
it goes, with none of the sender's words in the question. The answer, given
with `crosstalk_route`, is remembered for that sender, repo and branch.

A peer that sends no footprint (an older crosstalk, or a session outside a git
repo) is routed as before: an idle session, else any live one, else the first
registered. So is every message on a machine where no session is in a repo.

## Restore after a restart

The hook keeps one small file per open session in `open/` under crosstalk's
home: its id, folder, client, process and terminal tab. These records can't
live in the daemon. After a restart, the daemon isn't running. When it starts,
it drops every session whose process is gone, and those are exactly the
sessions to bring back. A session whose process disappeared without a
`SessionEnd` was lost. The first session opened afterwards asks once, through
a `systemMessage` the model never sees. The `crosstalk_restore` tool reopens
the lost sessions through an adapter per terminal. See [restore.md](restore.md).

## Two transports

**Channel MCP server** is the target, and what the server already declares.
During the channels research preview a custom channel needs
`--dangerously-load-development-channels crosstalk`, which shows a warning dialog
at every launch, so it is not the default path yet.

**Session inbox socket** is what runs today, with no flag and no allowlist. The
daemon writes to `CLAUDE_CODE_MESSAGING_SOCKET` using a payload format that is
undocumented. [`spike/`](../spike/) is how it was captured, replayed and
verified. Everything above the transport is shared between the two.

## Running on bun or node

The plugin ships a built `dist/` with dependencies inlined, and `bin/crosstalk`
picks whichever runtime is on PATH. The relay needs a WebSocket server, and each
runtime supplies exactly one of the two halves needed: Bun has a native one but
silently discards writes to a `node:http` upgrade socket, while Node has a
working upgrade socket and no WebSocket server without a package that refuses to
inline. So [`relay/serve.ts`](../relay/serve.ts) picks Bun's server under Bun and
[`relay/wsserver.ts`](../relay/wsserver.ts), a small RFC 6455 implementation,
under Node.

## When things go wrong

**The machine hosting the relay sleeps.** Nothing is lost. A send while the relay
is unreachable is held on your own machine and goes out when the link returns. A
message already at the relay for someone offline survives a relay restart. Both
expire after a day.

A sleeping laptop leaves the far end holding a socket that still reports as open
while nothing crosses it, which would swallow everything sent into it. The daemon
treats seventy seconds of silence as a dead link and reconnects.
[`test/resilience.sh`](../test/resilience.sh) checks all three.

**You are not on the same network.** A LAN address only works within one network,
and guest wifi usually isolates clients from each other even on the same SSID.
There is no NAT traversal. Install Tailscale on both machines, after which
`--host` hands out a tailnet address that works from anywhere, or run a relay
somewhere permanent: [`deploy/`](../deploy/).

**Anything else.** `/crosstalk:doctor` checks each part in order and names the one
that is broken, including whether the macOS firewall is dropping incoming
connections. [`test/two-machines.md`](../test/two-machines.md) works through the
rest.

## Layout

```
src/daemon.ts    relay link, routing, triage, injection
src/server.ts    the MCP tools, channel push
src/link.ts      encrypted channel to the relay
src/rooms.ts     rooms, invitations, room keys
src/inject.ts    writes into a session's inbox socket
src/footprint.ts what a session is working on, and matching a message to it
src/restore.ts   which sessions a restart lost, and reopening them per terminal
src/policy.ts    intent plus your state decides what interrupts you
src/crypto.ts    identities, phrase exchange, sealing
relay/relay.ts   the relay
spike/           how the inbox socket format was captured
```

## Development

```
bun install
bun scripts/build.ts        # dist/ is committed, rebuild after editing src/
bun relay/relay.ts          # a relay on :8787
bun src/cli.ts doctor
bash test/resilience.sh     # the sleep failure modes
bun run test:routing        # messages reach the session on the same work
bun run test:restore        # sessions come back after a restart (real tmux)
bun scripts/release.ts "what changed"
```

`CROSSTALK_HOME` moves crosstalk's state, so you can run several identities on
one machine and put them in a room with each other. That is how all of this was tested.
