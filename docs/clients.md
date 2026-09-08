# Which agents can be in a room

Crosstalk is not tied to one CLI. The relay routes sealed messages between
identities and has no idea what is running on either end, so a Claude Code
session, a Codex session and an Antigravity session can all be in the same room
and talk to each other.

What differs between them is only how a message gets into a running session.

## Delivery works

All eight can be reached without the agent having to think to go and look.
Seven can be interrupted mid-turn; Goose is heard between turns instead.

| Client | Where hooks live | How text gets in |
|---|---|---|
| **Claude Code** | plugin | inbox socket, so a notice can arrive at any moment |
| **Codex** | `~/.codex/hooks.json` | `hookSpecificOutput.additionalContext` |
| **Cursor (`cursor-agent`)** | `~/.cursor/hooks.json` | flat `additional_context`, max 10k |
| **Antigravity (`agy`)** | `~/.gemini/config/hooks.json` | `injectSteps` on `PreInvocation` |
| **Qwen Code** | `~/.qwen/settings.json` | `hookSpecificOutput.additionalContext` |
| **Kimi Code** | `~/.kimi-code/config.toml` | `message`, wrapped in `<hook_result>` |
| **Hermes** | `~/.hermes/config.yaml` | `context` on `pre_llm_call` |
| **Goose** | `~/.agents/plugins/crosstalk/` | a `Stop` hook that refuses to end the turn |

One binary serves all eight. `bin/crosstalk hook` reads the payload on stdin,
works out which client sent it, and answers in that client's own format.

Each gets its own field and nothing else. Writing several at once to cover every
client looks free and is not: Codex parses each event against its own schema
with `deny_unknown_fields`, so a single key it does not expect throws away the
whole object and the message silently never arrives.

Kimi Code is the one client that cannot be recognised from what it sends, since
its payload is identical to Claude Code's. Its config names it instead, with
`--client kimi`.

### The rule that matters most

Asking the daemon for a notice consumes it, so an event that cannot deliver must
not ask: it would take the notice and drop it. Which events those are differs
per client, and not in the way the names suggest.

| Client | Events that can carry text |
|---|---|
| Claude Code, Codex, Qwen | `SessionStart` `UserPromptSubmit` `PreToolUse` `PostToolUse` |
| Cursor | `sessionStart` `beforeSubmitPrompt` `preToolUse` `postToolUse` `postToolUseFailure` |
| Antigravity | `PreInvocation` |
| Hermes | `pre_llm_call` |
| Kimi Code | `UserPromptSubmit` |
| Goose | `Stop` |

Three of them cannot deliver on their own session-start event. Kimi renders a
hook result for `UserPromptSubmit` and no other event. Hermes reads an answer
only on `pre_llm_call`. Goose reads one only as a refusal to stop. In Codex the
reverse holds: `Stop` has no `hookSpecificOutput` field at all, so a notice
returned there does not get ignored, it invalidates the whole object.

So the working set of facts and tasks is asked for **by session, not by event**.
The daemon hands it over once, to whichever event gets there first, and every
session-start hook does nothing but say the session exists.

### Claude Code

```
/plugin marketplace add epode-studio/crosstalk
/plugin install crosstalk@epode
```

### Codex

```
crosstalk install codex
```

Then start `codex`, run **`/hooks`**, and trust the crosstalk entries. This step
is not optional and it is not obvious: **Codex will not run a hook it has not
been told to trust, and it says nothing when it skips one.** Everything looks
installed and no message ever arrives.

`crosstalk doctor` checks for it:

```
x  codex hooks   SessionStart, Stop not trusted yet, so codex will skip them.
                 Run codex, then /hooks, and trust the crosstalk entries.
```

Trust is recorded in `~/.codex/config.toml`, keyed by file, event and the
handler's position in that file:

```toml
[hooks.state."/Users/you/.codex/hooks.json:session_start:1:0"]
trusted_hash = "sha256:..."
```

Because the key carries that position, adding a hook *ahead* of an existing one
revokes the existing one's trust. `crosstalk install codex` always appends.

### Antigravity, Qwen, Kimi, Hermes, Goose, Cursor

None of these read the plugin format, so there is a command per client:

```
crosstalk install agy
crosstalk install qwen
crosstalk install kimi
crosstalk install hermes
crosstalk install goose
crosstalk install cursor
```

Each writes its client's hook config, leaves anything already in that file
alone, and can be run twice without doubling up.

Hermes asks before it will run a hook it has not seen. After installing, start it
once and answer yes twice, or run it with `--accept-hooks`. `hermes hooks list`
shows what is approved.

Cursor throws away any injected text over 10,000 characters rather than
shortening it, so crosstalk trims to fit and marks where it cut.

## Tools only

Any client that speaks MCP gets the tools: it can send, read its inbox, see who
is online and what they are working on, hand work over and record decisions.
What it cannot do is be interrupted.

That covers opencode, Zed, Cline, Continue, Amp, crush and anything else with an
MCP client. Point it at:

```
command: /path/to/crosstalk/bin/crosstalk
args:    ["server"]
```

**None of them has been tested.** Not one is installed on the machine this was
built on, and a client's documentation has already been wrong twice here, so
saying "it speaks MCP, therefore it works" would be the same mistake.

What is tested is the server they would all be talking to. `test/mcp.ts` speaks
JSON-RPC to it over stdio and checks that it initializes, advertises tools,
lists all seventeen with an input schema each, answers a call with content, and
refuses a tool it does not have. That runs as part of `test/e2e.sh`.

So the untested part is narrow and nameable: how a given client launches a stdio
server and passes it an environment. Two things already found there are worth
knowing before adding one.

- The repo's `.mcp.json` is written for Claude Code and uses
  `${CLAUDE_PLUGIN_ROOT}`, which nothing else expands. Qwen read that file and
  reported only that the server had failed to start. Register the server through
  the client's own command instead, which is what `crosstalk install` does.
- A server started by one client inherits the environment of whatever launched
  it, including another client's session id. The daemon settles that by working
  directory rather than trusting the id.

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

All eight were watched working end to end. Where a client had no credentials on
this machine it was pointed at a local stand-in model that records the request
body, so what reached the model was read off the wire rather than inferred from
a client's own output.

Claude Code was tested across two physical machines. Codex 0.153.4, Cursor
2026.08.11, Antigravity, Qwen Code 0.23.0, Kimi Code 0.36.0, Hermes 0.16.0 and
Goose 1.49.0 were each tested on this one. Qwen, Kimi and Goose had no
credentials here, so those three ran against the stand-in model.

What each one looked like on the wire:

- **Qwen** wraps it as `<qwen:session-start-context hidden="true">`, and
  HTML-escapes the contents, so the tags arrive as `&lt;crosstalk-facts&gt;`.
- **Goose** sends it as a `user` message reading `Stop hook \`crosstalk\` blocked
  ending this turn:` followed by the notice, tags intact.
- **Kimi** sends it as `<hook_result hook_event="UserPromptSubmit">`.
- **Cursor** and **Hermes** append it to the user message directly.
- **Codex** treats it as hidden context: the model uses it but will not quote it
  back, so it answered by summarising what it had rather than reciting it.

**Codex** took the longest and none of it showed up as an error. Three separate
reasons it could not work had to be found by reading
`codex-rs/hooks/src/schema.rs` and its own `hooks/list`, not by running it:
`deny_unknown_fields` on every output struct, `Stop` having no
`hookSpecificOutput` field at all, and the trust gate. Until the hook was
trusted through `/hooks` it was loaded, listed and skipped in silence. Every
user meets that last one, which is why `crosstalk install codex` says so and
`crosstalk doctor` checks for it.

Nothing on this page comes from a client's documentation alone. On two of them
the documentation was wrong: Goose's says hooks cannot inject context, and
Qwen's implies `additionalContext` behaves the same everywhere. That is the
reason every client under **Tools only** is marked untested rather than assumed
to work.

## One daemon per machine

Two daemons sharing a state directory each hold the message queue in memory and
each write the whole of it back, so whichever writes last erases the other's
work. A message then reaches nobody, and nothing anywhere reports an error.

Starting a daemon now asks the socket whether anything answers, rather than
trusting a pid file, and a daemon that is shutting down removes the socket only
if the lock still names it. Before that, startup unlinked the socket before
checking it, which meant the check could never see a live one.

`crosstalk doctor` and `test/resilience.sh` both cover it.
