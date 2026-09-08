---
description: Work agreed in a room, and who has claimed what
argument-hint: "[add <text> --for <person> | claim <id> | done <id> <note>]"
allowed-tools: Bash(${CLAUDE_PLUGIN_ROOT}/bin/crosstalk:*)
---

!`"${CLAUDE_PLUGIN_ROOT}/bin/crosstalk" cli tasks $ARGUMENTS`

Facts are what a room knows. Tasks are what it has agreed to do. Both outlive
every session and both sync to everyone in the room.

Claiming is the part that matters. Take a task before working on it, and a claim
on something somebody else already has will fail rather than race, which is what
stops two agents doing the same thing.
