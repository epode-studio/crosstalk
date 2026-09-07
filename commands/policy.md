---
description: Show or set how a peer's messages are allowed to interrupt you
argument-hint: "[peer] [notify|deliver|quiet] [--allow-ask]"
allowed-tools: Bash(${CLAUDE_PLUGIN_ROOT}/bin/crosstalk:*)
---

!`"${CLAUDE_PLUGIN_ROOT}/bin/crosstalk" cli policy $ARGUMENTS`

Explain the three modes if the user seems unsure:

- **notify** (default), a notice appears, and the peer's own words stay behind
  the `crosstalk_read` tool. Nothing they wrote enters the session under Claude
  Code's framing, which describes any inbound peer message as coming from the
  user's own teammate. For a different person that framing is wrong.
- **deliver**, their text lands in the session mid-turn. Right when you are
  actively pairing on the same problem, wrong the rest of the time.
- **quiet**, held silently and surfaced when the session next goes idle.

`--allow-ask` lets that peer's Claude use `crosstalk_ask` against your sessions,
which starts a turn here and spends your tokens. Off by default.
