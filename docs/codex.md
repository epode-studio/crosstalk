# Codex

Crosstalk works in OpenAI's Codex CLI as well as Claude Code, and the two can be
in the same room. A message from a Codex session reaches a Claude Code session
and back again, because the relay routes sealed messages between identities and
has no idea which client is on either end.

## Install

Codex reads Claude Code's plugin format and installs from the same marketplaces,
so nothing special is needed. Add this to `~/.codex/config.toml`:

```toml
[marketplaces.epode]
source_type = "git"
source = "https://github.com/epode-studio/crosstalk.git"

[plugins."crosstalk@epode"]
enabled = true
```

Then pair the same way:

```
/crosstalk:pair --host
```

## How delivery differs

Claude Code gives every session an inbox socket, so crosstalk can put a notice
into a running session whenever one arrives. Codex has no equivalent, but its
hooks can add text to a turn, and `PostToolUse` fires between tool calls, so a
notice still arrives mid-turn rather than only at the end.

The daemon decides which of the two applies. A session that registers an inbox
socket is pushed to. A session that registers without one is held for, and its
hook collects on the next event. Nothing does both, which is what stops a message
arriving twice.

In practice the difference you can feel is small. `notify`, the default, behaves
the same on both. `deliver`, which puts a peer's words inside your turn, is
Claude Code only, and it is the mode crosstalk discourages anyway.

## What is missing on Codex

**Presence is thinner.** Claude Code publishes a registry of live sessions with
their working directory and whether they are busy, which is what
`/crosstalk:peers` reads. Codex publishes nothing equivalent, so a Codex session
reports the name and directory it gave at registration and its status shows as
`unknown`. Since triage treats unknown as busy, an `fyi` waits for a quiet moment
rather than interrupting, which is the safe way round.

**Idle detection.** Held messages surface when a session goes idle. Without a
status to watch, they surface on the next hook event instead, which is usually
sooner.

## Testing it

```
echo '{"session_id":"t1","cwd":"/tmp","hook_event_name":"SessionStart"}' \
  | ./bin/crosstalk hook
echo '{"session_id":"t1","cwd":"/tmp","hook_event_name":"PostToolUse"}' \
  | ./bin/crosstalk hook
```

The first registers the session in pull mode, the second returns anything waiting
as `hookSpecificOutput.additionalContext`.
