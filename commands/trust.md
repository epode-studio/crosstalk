---
description: How much a person or a room is allowed to interrupt you
argument-hint: "[name] [mute|notify|ask|handoff|deliver] [--in room]"
allowed-tools: Bash(${CLAUDE_PLUGIN_ROOT}/bin/crosstalk:*)
---

!`"${CLAUDE_PLUGIN_ROOT}/bin/crosstalk" cli trust $ARGUMENTS`

One dial per source, where each step includes the ones below it:

| | |
|---|---|
| `mute` | nothing reaches you |
| `notify` | a line on your screen; their words stay behind a tool call |
| `ask` | also a question that costs you a turn |
| `handoff` | also a work item with state and files |
| `deliver` | also their words inside your turn |

A room carries a level for everyone in it, and a person can be pinned above or
below their room, because what usually varies is what a room is for rather than
who is in it.

Two things cap it no matter what you set: someone in a shared room you have never
paired with cannot get past a notice, and neither can a member that is not a
person.
