# Which agents can be in a room

Crosstalk is not tied to one CLI. The relay routes sealed messages between
identities and has no idea what is running on either end, so a Claude Code
session, a Codex session and a Gemini CLI session can all be in the same room and
talk to each other.

What differs between them is only how a message gets into a running session.

## Fully supported

| Client | How a message reaches a live session |
|---|---|
| **Claude Code** | Its inbox socket, so a notice can arrive at any moment |
| **Codex** | Hook context on `PostToolUse`, which fires between tool calls |
| **Gemini CLI** | Hook context on `AfterTool`, same idea, same moment |

All three take the same hook output shape, so one binary serves all of them:

```json
{ "hookSpecificOutput": { "hookEventName": "...", "additionalContext": "..." } }
```

### Claude Code

```
/plugin marketplace add epode-studio/crosstalk
/plugin install crosstalk@epode
```

### Codex

Codex reads the same plugin format and installs from the same marketplaces. In
`~/.codex/config.toml`:

```toml
[marketplaces.epode]
source_type = "git"
source = "https://github.com/epode-studio/crosstalk.git"

[plugins."crosstalk@epode"]
enabled = true
```

### Gemini CLI

Clone it once, then in `~/.gemini/settings.json`:

```json
{
  "mcpServers": {
    "crosstalk": { "command": "/path/to/crosstalk/bin/crosstalk", "args": ["server"] }
  },
  "hooks": {
    "SessionStart": [{ "hooks": [{ "type": "command", "command": "/path/to/crosstalk/bin/crosstalk hook" }] }],
    "AfterTool":    [{ "hooks": [{ "type": "command", "command": "/path/to/crosstalk/bin/crosstalk hook" }] }],
    "BeforeAgent":  [{ "hooks": [{ "type": "command", "command": "/path/to/crosstalk/bin/crosstalk hook" }] }]
  }
}
```

## Everything else

Any client that speaks MCP gets the tools: it can send, read its inbox, see who
is online and what they are working on, hand work over and record decisions. What
it cannot do is be interrupted, because there is no hook to deliver through, so
messages wait until its agent thinks to look.

That covers opencode, Goose, Zed, Cline, Continue, Amp, crush and anything else
with an MCP client. Point it at:

```
command: /path/to/crosstalk/bin/crosstalk
args:    ["server"]
```

Adding one of these to the fully supported list is small work: a hook that
registers the session and a hook that returns waiting notices. The daemon, the
crypto, the rooms and the relay do not change.

## How honest this table is

Claude Code is tested end to end across two physical machines: pairing, presence,
messages, rooms, questions and answers.

Codex and Gemini CLI are built against their documented hook contracts and tested
with their payload shapes, not against a live install of either. The mechanism is
the same one Claude Code uses and the output format is identical across all
three, so the risk is in the details of how each one invokes a hook rather than
in the design. If one of them misbehaves, `bin/crosstalk hook` reads a payload on
stdin and prints its answer, so it is a one-line thing to check.
