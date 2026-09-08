# Which agents can be in a room

Crosstalk is not tied to one CLI. The relay routes sealed messages between
identities and has no idea what is running on either end, so a Claude Code
session, a Codex session and an Antigravity session can all be in the same room
and talk to each other.

What differs between them is only how a message gets into a running session.

## Delivery works

These five can be interrupted: a message arrives during a turn, without the
agent having to think to go and look.

| Client | Where hooks live | How text gets in |
|---|---|---|
| **Claude Code** | plugin | inbox socket, so a notice can arrive at any moment |
| **Codex** | plugin | `hookSpecificOutput.additionalContext` |
| **Antigravity (`agy`)** | `~/.gemini/config/hooks.json` | `injectSteps` on `PreInvocation` |
| **Qwen Code** | `~/.qwen/settings.json` | `hookSpecificOutput.additionalContext` |
| **Kimi Code** | `~/.kimi-code/config.toml` | `message`, which Kimi wraps in `<hook_result>` |

One binary serves all five. `bin/crosstalk hook` reads the payload on stdin,
works out which client sent it, and answers in that client's own format, writing
every injection field at once because a client that does not know a field
ignores it.

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

### Antigravity, Qwen Code, Kimi Code

None of these read the plugin format, so there is a command per client:

```
crosstalk install agy
crosstalk install qwen
crosstalk install kimi
```

Each writes its client's hook config, leaves anything already in that file
alone, and can be run twice without doubling up.

## Presence only

**Goose** has the same hook shape and the same event names, and its payload
carries `session_id` and `working_dir`, so a session can register and show up in
`crosstalk peers`. Its hooks cannot add text to the model's context: stdout is
read for a decision on `PreToolUse` and `Stop` and nothing else. So a Goose
session can be seen and sent to, but it reads its messages through the tools
when its agent looks, rather than being interrupted.

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

**Antigravity** is tested live on this machine. A session registers, a posted
message reaches it mid-turn as an injected step, and `crosstalk_read` returns the
content through the MCP server. `test/e2e.sh` covers the payload shape.

**Codex** is not tested against a live install, because Codex could not reach the
network from the sandbox this was built in. What is verified is that the shipped
binary implements the contract crosstalk writes to: `hooks.json`,
`hook_event_name`, `SessionStart`, `UserPromptSubmit`, `PostToolUse`, `Stop`,
`hookSpecificOutput`, `additionalContext`, all present in
`@openai/codex-darwin-arm64` 0.151.0.

**Kimi Code** is not tested live either, because this machine is not logged in
and Kimi exits before running a hook. What is verified is the hook engine in the
shipped bundle: the config is a TOML `[[hooks]]` array with `event`, `command`,
`matcher` and `timeout`; the payload is snake_case with `hook_event_name`,
`session_id` and `cwd`; and `renderHookResult` wraps a returned `message` in a
`<hook_result hook_event="…">` tag that goes to the model.

**Qwen Code** is from its documentation only. It is not installed here. The
contract it documents is Claude Code's, field for field, so the existing hook
binary should serve it unchanged, and `crosstalk install qwen` writes the config
Qwen documents.

**Goose** is from its documentation only.

If any of them misbehaves, `bin/crosstalk hook` reads a payload on stdin and
prints its answer, so it is a one-line thing to check.
