# Which agents can be in a room

Crosstalk is not tied to one CLI. The relay routes sealed messages between
identities and has no idea what is running on either end, so a Claude Code
session, a Codex session and an Antigravity session can all be in the same room
and talk to each other.

What differs between them is only how a message gets into a running session.

## Delivery works

These six can be interrupted: a message arrives during a turn, without the agent
having to think to go and look.

| Client | Where hooks live | How text gets in |
|---|---|---|
| **Claude Code** | plugin | inbox socket, so a notice can arrive at any moment |
| **Codex** | plugin | `hookSpecificOutput.additionalContext` |
| **Antigravity (`agy`)** | `~/.gemini/config/hooks.json` | `injectSteps` on `PreInvocation` |
| **Qwen Code** | `~/.qwen/settings.json` | `hookSpecificOutput.additionalContext` |
| **Kimi Code** | `~/.kimi-code/config.toml` | `message`, which Kimi wraps in `<hook_result>` |
| **Hermes** | `~/.hermes/config.yaml` | `context` on `pre_llm_call` |

One binary serves all six. `bin/crosstalk hook` reads the payload on stdin,
works out which client sent it, and answers in that client's own format.

Each gets its own field and nothing else. Writing several at once to cover every
client looks free and is not: Codex parses each event against its own schema
with `deny_unknown_fields`, so a single key it does not expect throws away the
whole object and the message silently never arrives.

Kimi Code is the one client that cannot be recognised from what it sends, since
its payload is identical to Claude Code's. Its config names it instead, with
`--client kimi`.

Then one rule that matters more than it looks. Asking the daemon for a notice
consumes it, so an event that cannot deliver must not ask: it would take the
notice and drop it. Two clients make that concrete. Hermes reads a hook's answer
on `pre_llm_call` and nowhere else. And in Codex the `Stop` event has no
`hookSpecificOutput` field at all, so a notice returned there is not ignored, it
invalidates the object it arrived in. So only these events ever ask:

```
SessionStart  UserPromptSubmit  PreToolUse  PostToolUse  PreInvocation  pre_llm_call
```

### Claude Code and Codex

Both read the same plugin format from the same marketplaces.

```
/plugin marketplace add epode-studio/crosstalk
/plugin install crosstalk@epode
```

For Codex, in `~/.codex/config.toml`:

```toml
[marketplaces.epode]
source_type = "git"
source = "https://github.com/epode-studio/crosstalk.git"

[plugins."crosstalk@epode"]
enabled = true
```

### Antigravity, Qwen Code, Kimi Code, Hermes

None of these read the plugin format, so there is a command per client:

```
crosstalk install agy
crosstalk install qwen
crosstalk install kimi
crosstalk install hermes
```

Each writes its client's hook config, leaves anything already in that file
alone, and can be run twice without doubling up.

Hermes asks before it will run a hook it has not seen. After installing, start it
once and answer yes twice, or run it with `--accept-hooks`. `hermes hooks list`
shows what is approved.

## Presence only

**Goose** has the same hook shape and the same event names, and its payload
carries `session_id` and `working_dir`, so a session can register and show up in
`crosstalk peers`. Its hooks cannot add text to the model's context: stdout is
read for a decision on `PreToolUse` and `Stop` and nothing else. So a Goose
session can be seen and sent to, but it reads its messages through the tools
when its agent looks, rather than being interrupted. There is no installer for
it yet.

## Tools only

Any client that speaks MCP gets the tools: it can send, read its inbox, see who
is online and what they are working on, hand work over and record decisions.
What it cannot do is be interrupted.

That covers opencode, Zed, Cline, Continue, Amp, crush, cursor-agent and
anything else with an MCP client. Point it at:

```
command: /path/to/crosstalk/bin/crosstalk
args:    ["server"]
```

## What agy needed that the others did not

Antigravity is the one client that agrees with nobody, and the differences are
worth writing down because none of them are guessable.

Its own reference is on disk at
`~/.gemini/antigravity-cli/builtin/skills/agy-customizations/docs/hooks.md`.

- **Config lives in `~/.gemini/config/`**, the global customization root, or in
  `<project>/.agents/`. A file at `~/.gemini/hooks.json` loads and reports
  itself in the log, then never fires.
- **The top level is a map of hook names**, and each name holds handlers per
  event, the reverse of everywhere else.
- **There is no SessionStart.** The five events are `PreInvocation`,
  `PostInvocation`, `PreToolUse`, `PostToolUse` and `Stop`. A session announces
  itself on its first `PreInvocation`, which is numbered from zero.
- **The payload names no event**, so `hooks.json` passes it as an argument.
- **The payload is camelCase protojson**: `conversationId`, `workspacePaths`,
  `transcriptPath`, `invocationNum`. That first field is what tells the hook
  which client it is talking to.
- **Output is steps, not context**: `{"injectSteps":[{"ephemeralMessage":"…"}]}`.
- **A hook runs in the directory holding `hooks.json`**, not the project, so the
  working directory is useless for telling which project a session is in.
  `workspacePaths` carries the real one, and is empty under `agy -p` unless you
  pass `--add-dir`.
- **MCP servers are told nothing.** No conversation id reaches them, and one
  started from a Claude Code shell inherits that shell's `CLAUDE_CODE_SESSION_ID`
  and would otherwise read the wrong inbox. What agy does get right is that an
  MCP server runs in the workspace, so the daemon matches a request to a session
  by directory whenever the directory and the id disagree.

## How honest this page is

**Claude Code** is tested end to end across two physical machines: pairing,
presence, messages, rooms, questions and answers.

**Antigravity 0.x (`agy`)** is tested live. A session registers, a posted message
reaches it mid-turn as an injected step, and `crosstalk_read` returns the content
through the MCP server.

**Hermes 0.16.0** is tested live. A session registers on `on_session_start`, and
the first `pre_llm_call` delivers the facts, the tasks and the pending-message
notice, all three quoted back by the model.

**Qwen Code 0.23.0** is half tested. The hook fires and registers a session with
the right working directory, which proves the config `crosstalk install qwen`
writes is accepted and the payload parses. Injection is unproven: this machine
has no Qwen auth configured, so no model call ever happened.

**Codex 0.153.4** is half tested. Its own output shows `hook: SessionStart` and
`hook: Stop` running, and the daemon registered the session, so hooks fire and
the payload parses. Injection has not been seen working, and testing stopped
when Codex started returning 401 from its own API.

Two reasons it would not have worked are now fixed, both found by reading
`codex-rs/hooks/src/schema.rs` rather than by guessing. Every output struct
there carries `#[serde(deny_unknown_fields)]`, and the only top-level fields it
allows are `continue`, `stopReason`, `suppressOutput`, `systemMessage` and
`hookSpecificOutput`. Crosstalk was sending a sixth, `message`, added for Kimi,
which invalidated every hook answer it ever gave Codex. And `Stop` has no
`hookSpecificOutput` at all, so returning a notice there both lost the notice
and voided the object. `test/e2e.sh` now checks every event's output against
that field list.

Codex also has a hook trust gate: a hook runs only when its hash matches a
`trusted_hash` in state, or the source is managed. That is not ruled out as a
further obstacle.

**Kimi Code 0.36.0** is untested. This machine is not logged in and Kimi exits
before running a hook. What is verified is the hook engine in the shipped
bundle: the config is a TOML `[[hooks]]` array with `event`, `command`,
`matcher` and `timeout`; the payload is snake_case with `hook_event_name`,
`session_id` and `cwd`; and `renderHookResult` wraps a returned `message` in a
`<hook_result hook_event="…">` tag that goes to the model.

**Goose** is from its documentation only. What is installed here is the desktop
app, which ships no CLI on PATH.

If any of them misbehaves, `bin/crosstalk hook` reads a payload on stdin and
prints its answer, so it is a one-line thing to check.

## One daemon per machine

Two daemons sharing a state directory each hold the message queue in memory and
each write the whole of it back, so whichever writes last erases the other's
work. A message then reaches nobody, and nothing anywhere reports an error.

Starting a daemon now asks the socket whether anything answers, rather than
trusting a pid file, and a daemon that is shutting down removes the socket only
if the lock still names it. Before that, startup unlinked the socket before
checking it, which meant the check could never see a live one.

`crosstalk doctor` and `test/resilience.sh` both cover it.
