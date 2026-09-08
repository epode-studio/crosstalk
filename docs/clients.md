# Which agents can be in a room

Crosstalk is not tied to one CLI. The relay routes sealed messages between
identities and has no idea what is running on either end, so a Claude Code
session, a Codex session and an Antigravity session can all be in the same room
and talk to each other.

What differs between them is only how a message gets into a running session.

## Delivery works

All seven can be reached without the agent having to think to go and look. Six
of them can be interrupted mid-turn; Goose is heard between turns instead.

| Client | Where hooks live | How text gets in |
|---|---|---|
| **Claude Code** | plugin | inbox socket, so a notice can arrive at any moment |
| **Codex** | plugin | `hookSpecificOutput.additionalContext` |
| **Antigravity (`agy`)** | `~/.gemini/config/hooks.json` | `injectSteps` on `PreInvocation` |
| **Qwen Code** | `~/.qwen/settings.json` | `hookSpecificOutput.additionalContext` |
| **Kimi Code** | `~/.kimi-code/config.toml` | `message`, wrapped in `<hook_result>` |
| **Hermes** | `~/.hermes/config.yaml` | `context` on `pre_llm_call` |
| **Goose** | `~/.agents/plugins/crosstalk/` | a `Stop` hook that refuses to end the turn |

One binary serves all seven. `bin/crosstalk hook` reads the payload on stdin,
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
notice and drop it. Three clients make that concrete. Hermes reads a hook's
answer on `pre_llm_call` and nowhere else. In Codex the `Stop` event has no
`hookSpecificOutput` field at all, so a notice returned there is not ignored, it
invalidates the object it arrived in. And Goose is the exact reverse: `Stop` is
the only event that can put anything in front of its model. So the events that
ask are:

```
Goose            Stop
everything else  SessionStart  UserPromptSubmit  PreToolUse  PostToolUse
                 PreInvocation  pre_llm_call
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
crosstalk install goose
```

Each writes its client's hook config, leaves anything already in that file
alone, and can be run twice without doubling up.

Hermes asks before it will run a hook it has not seen. After installing, start it
once and answer yes twice, or run it with `--accept-hooks`. `hermes hooks list`
shows what is approved.

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

Everything below was either watched working on this machine, or read out of the
source the client actually ships. Nothing here is from a client's documentation
alone, because on two of them the documentation was wrong.

**Claude Code** is tested end to end across two physical machines: pairing,
presence, messages, rooms, questions and answers.

**Antigravity (`agy`)** is tested live. A session registers, a posted message
reaches it mid-turn as an injected step, and `crosstalk_read` returns the content
through the MCP server.

**Hermes 0.16.0** is tested live. A session registers on `on_session_start`, and
the first `pre_llm_call` delivers the facts, the tasks and the pending-message
notice, all three quoted back by the model.

**Codex 0.153.4** runs the hook but has not delivered yet, and the reason is now
known: **a new hook is untrusted and Codex never executes it.** The trust state
in `~/.codex/config.toml` is keyed per handler, down to its index in the file:

```toml
[hooks.state."/Users/you/.codex/hooks.json:session_start:0:0"]
trusted_hash = "sha256:…"
```

Run `/hooks` in the Codex TUI once and trust it. Until then the hook is loaded,
listed, and skipped. Because the key includes the handler's index, inserting a
hook *ahead* of an existing one also invalidates that one's trust, so crosstalk
appends.

Two things that would have broken it anyway are fixed, both found in
`codex-rs/hooks/src/schema.rs`. Every output struct is `deny_unknown_fields`,
and the allowed top-level fields are only `continue`, `stopReason`,
`suppressOutput`, `systemMessage` and `hookSpecificOutput`. And `Stop` has no
`hookSpecificOutput` at all. `test/e2e.sh` checks every event against that list.

**Qwen Code 0.23.0** is half tested and fully read. Live: the hook fires and
registers a session with the right working directory. In source,
`Client.fireSessionStartHook` returns `output.getAdditionalContext()` and
applies it to the session, so `SessionStart` really is a delivery point there
and the shape crosstalk sends is the shape it wants. Not seen end to end because
this machine has no Qwen auth configured.

**Goose 1.49.0** is read, not run: it exits at `No provider configured` before
any hook fires. Its own docs say hooks cannot inject context and that is true as
stated, but it undersells what is possible. In
`crates/goose/src/agents/state_machine/ops_stop_hook.rs`, a `Stop` hook that
answers `{"decision":"block","reason":"…"}` makes Goose build
`Message::user().with_text(reason).with_visibility(false, true)` and push it into
the conversation: hidden from the person, read by the model. So Goose can be
reached, just at the end of a turn rather than during one, and it gets no working
set of facts on start. Note that in `classify_output` an exit-0 object with no
`decision` key counts as the hook having *failed*, which is why crosstalk says
`{"decision":"allow"}` rather than staying quiet.

**Kimi Code 0.36.0** is read, not run: this machine is not logged in and Kimi
exits before running a hook. Its config is a TOML `[[hooks]]` array with `event`,
`command`, `matcher` and `timeout`; the payload is snake_case with
`hook_event_name`, `session_id` and `cwd`; and `renderHookResult` wraps a
returned `message` in a `<hook_result hook_event="…">` tag that goes to the
model.

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
