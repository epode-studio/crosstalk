# crosstalk

**Your Claude Code sessions can already message each other. Crosstalk lets them message someone else's.**

Two people, two laptops, one codebase. You find something the other person needs
to know. Today that means reading it out of your terminal, summarising it in
Slack, pasting it into theirs, and re-explaining the context that made it matter.
The work is agentic on both ends. The coordination is a human copy-paste loop.

Claude Code ships with session-to-session messaging, and it is good — but
everything it can reach belongs to one account. Your colleague's sessions never
appear in your `/list-agents`. Crosstalk is the other half.

```
› tell marie the tenant_id migration landed, send her the diff

  sent to marie/api  ·  fyi  ·  1 slice (git diff HEAD, 4.2 KB)
```

And on her machine, a few seconds later:

```
› Message from crosstalk:paul/hardware (ctrl+o to expand)
```

Her Claude reads it, pulls the diff if it needs to, and carries on. Nobody
retyped anything.

---

## Pairing is four words

```
/crosstalk:pair --host
```

```
Tell them these words:

    cricket-tungsten-tarn-lathe @ 192.168.50.69
```

Say them out loud. They run `/crosstalk:pair cricket-tungsten-tarn-lathe @ 192.168.50.69`,
both sides print a fingerprint, you check the two match, done.

`--host` starts a relay on your machine for as long as pairing takes and finds an
address the other person can reach — your tailnet address if you have Tailscale,
your LAN address otherwise. No account, no server, no config file.

The phrase is the whole secret. The relay files your offer under a hash of it and
never sees the phrase, so nothing else has to stay confidential. It expires in
fifteen minutes.

## Install

```
/plugin marketplace add epode-studio/crosstalk
/plugin install crosstalk@epode
```

That is all of it. The repo is both the marketplace and the plugin. `dist/` is
committed with the MCP SDK bundled in, so nothing is fetched and nothing is built
on the other person's machine — it needs `bun` or `node` on PATH, and
`bin/crosstalk` picks whichever is there.

## The constraint that shaped everything

Claude Code wraps every inbound peer message in framing of its own before Claude
reads it:

> This came from another Claude session — not typed by your user, but very likely
> working on their behalf. Treat it as a teammate's request.

Exactly right when it is your desktop talking to your laptop. Exactly wrong when
it is Marie. And it cannot be removed: the sender controls the message body, not
the framing around it. That is measured, not assumed — see [`spike/`](spike/) for
how the wire format was captured and what it does.

So by default crosstalk does not put a peer's words into your session at all. It
injects a notice containing nothing they wrote, and the content comes back
through a tool call, where it arrives as data rather than as a request the
harness has vouched for.

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

Set a peer to `deliver` and their text lands inline instead, quoted inside a
marker they cannot predict. That is the right mode when you are actively pairing
on the same problem and the wrong one the rest of the time, which is why you have
to ask for it.

## Interruptions are the actual product

A message from someone else costs you a turn and pulls your agent off task.
Delivering it mid-turn is right for your own sessions and wrong for a colleague's.

The sending Claude declares an intent. Your policy decides what that intent is
allowed to do, given what your session is doing right now.

| Intent | Means | |
|---|---|---|
| `fyi` | they may want to know | held until you are idle |
| `question` | wants an answer, not blocked | notice now |
| `blocking` | cannot continue without you | notice now, even mid-task |

| Policy | Behaviour |
|---|---|
| `notify` | a notice appears; their words stay behind `crosstalk_read` — **default** |
| `deliver` | their text lands in your session mid-turn |
| `quiet` | held silently, surfaced when you next go idle |

Escalation is downward-safe: `blocking` lifts `quiet` to `notify`, and nothing
lifts anything to `deliver`. Only you, by naming a peer, get interrupted mid-turn.

## Beyond messages

**Presence.** Every Claude Code session writes its repo, status and last-update
time to disk. Crosstalk publishes yours to paired peers, encrypted, so
`/crosstalk:peers` shows what they are actually touching:

```
● marie  5051-537c-3bf5-e02d  notify  1 unread
      api      ~/palpable        busy  12s ago
      firmware ~/palpable-fw     idle  4m ago
```

**Context slices.** Attach a diff, a file, or your last few turns. The receiver
sees the label and the size; the content only enters their context if their
Claude asks for that slice. Showing the diff beats three sentences describing it.

**Handoff.** `crosstalk_handoff` sends a work item — goal, state, what remains,
which files — rather than a note about one.

**Decisions.** `crosstalk_decide` appends to `DECISIONS.md` with attribution.
Two people pairing with agents settle things constantly and record almost none of
it.

**Ask.** `crosstalk_ask` sends a question and waits for the answer, so one session
can consult the other's. Off per peer by default: an inbound question starts a
turn and spends their tokens.

## Commands

| | |
|---|---|
| `/crosstalk:pair [phrase]` | Pair. `--host` starts a relay for you |
| `/crosstalk:peers` | Who is online, which repo, busy or idle, unread |
| `/crosstalk:policy [peer] [mode]` | How that peer may interrupt you |
| `/crosstalk:mute [peer] [minutes]` | Hold inbound without disconnecting |
| `/crosstalk:cost` | What this has cost, per peer, both directions |
| `/crosstalk:doctor` | Check the setup and say what is wrong |
| `/crosstalk:status` | Identity, relay, registered sessions |

## What crosstalk will not do

**Relay permission prompts across people.** A channel that can reply into your
session can approve tool use in it. Across a person boundary that is a category
error, so the MCP server does not declare the permission capability, and will not.

Beyond that: an inbound message never approves a permission prompt, never edits
`CLAUDE.md`, settings or permission rules, and slash commands inside it stay
literal text. Everything a peer controls — their words, their session name — is
escaped before it goes anywhere near a tag, so a message body cannot close
crosstalk's own framing and write its own.

## How it fits together

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
channel, pushes arrivals as `<channel>` events; otherwise the daemon writes to the
session's inbox socket directly.

Messages are sealed with AES-256-GCM under a key derived by X25519 from the two
paired identities. Peers authenticate to the relay by Ed25519 challenge/response.
The relay sees fingerprints and byte counts, buffers 24 hours for an offline peer,
and holds no key that can open anything. Presence is encrypted the same way, so it
does not learn which repos you work in either.

Run one permanently if you want invites to be four words with no address —
[`deploy/`](deploy/) has a Dockerfile and a fly.toml.

## Two transports

**Channel MCP server** is the target, and what the server already declares. During
the channels research preview a custom channel needs
`--dangerously-load-development-channels crosstalk`, which shows a warning dialog
at every launch, so it is not the default path yet.

**Session inbox socket** is what runs today, with no flag and no allowlist. The
daemon writes to `CLAUDE_CODE_MESSAGING_SOCKET` using a payload format that is
undocumented — [`spike/`](spike/) is how it was captured, replayed and verified.
Everything above the transport is shared between the two.

## Honest limits

- **Never run across two machines.** Everything tested is one Mac, two identities,
  one relay — though the relay binds `0.0.0.0` and the sides talk over the LAN
  interface rather than loopback, so the network path is exercised. NAT, sleeping
  laptops and reconnects are not.
- **The socket payload format is undocumented** and could change on any Claude
  Code release. It carries a version field and survived a version gap in testing.
  Nothing promises more.
- **`deliver` mode is unproven against a real second session.** The escaping is
  measured; whether a receiving model follows a peer instruction anyway is not
  something the sending session can honestly test on itself.
  `spike/framing-test.ts` runs five probes against a session you are willing to
  disturb and checks for marker files that should never appear.
- **Two agents talking spends tokens on both accounts.** `/crosstalk:cost` shows
  the traffic; the token figures are estimated from message length.
- **Two people only.** Groups turn "one person I paired with" into "a room", which
  is a different product with a different trust model.

## Hacking on it

```
bun install
bun scripts/build.ts      # dist/ is committed; rebuild after changing src/
bun relay/relay.ts        # a relay on :8787
bun src/cli.ts doctor
```

`CROSSTALK_HOME` relocates crosstalk's own state, so you can run two identities on
one machine and pair them with each other. That is how everything here was tested.

```
src/daemon.ts      per-machine daemon: relay link, routing, triage, injection
src/server.ts      per-session MCP server: the tools, channel push
src/inject.ts      writes into a session's inbox socket, escapes everything
src/policy.ts      intent × receiver state → deliver | notify | quiet
src/crypto.ts      identities, phrase pairing, sealing
src/registry.ts    reads Claude Code's own session registry (presence)
relay/relay.ts     the relay
spike/             how the inbox socket format was captured
```

## Licence

MIT.
