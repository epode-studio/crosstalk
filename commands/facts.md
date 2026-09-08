---
description: What the room knows, so nobody explains it twice
argument-hint: "[add <text> --in <repo> | confirm <id> | correct <id> <text>]"
allowed-tools: Bash(${CLAUDE_PLUGIN_ROOT}/bin/crosstalk:*)
---

!`"${CLAUDE_PLUGIN_ROOT}/bin/crosstalk" cli facts $ARGUMENTS`

Every agent in the room reads these at the start of every session. Tag one with a
repository and it only loads there.

Facts are not owned by whoever wrote them. Anyone can confirm one, which adds
their name and resets its age, and anyone can correct one, which records who and
why. A fact is never removed because its author left, since who claimed something
and whether it is true are different questions.
