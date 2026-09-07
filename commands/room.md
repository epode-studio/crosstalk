---
description: Make or inspect a room, a local alias for several peers at once
argument-hint: "[name] [peer peer ...]"
allowed-tools: Bash(${CLAUDE_PLUGIN_ROOT}/bin/crosstalk:*)
---

!`"${CLAUDE_PLUGIN_ROOT}/bin/crosstalk" cli room $ARGUMENTS`

A room is a list of peers you already paired with, kept on this machine. Sending
to `#beta` fans the message out over those pairwise channels, each one encrypted
separately. Nobody can add you to a room, and every member stays individually
mutable and gateable.

Your room and their room are separate lists. If they reply to `#beta`, it reaches
whoever is in theirs.
