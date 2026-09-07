---
description: Pair with another person's Claude Code so your sessions can message each other
argument-hint: "[four-word phrase] or --host to start"
allowed-tools: Bash(${CLAUDE_PLUGIN_ROOT}/bin/crosstalk:*)
---

!`"${CLAUDE_PLUGIN_ROOT}/bin/crosstalk" cli pair $ARGUMENTS`

If the user ran this with no arguments and there is no relay configured, tell
them to run `/crosstalk:pair --host` instead, crosstalk will start a relay on
this machine and put its address in the invite.

If an invite phrase was printed, show it exactly as printed and tell the user to
send it somewhere they already trust, said out loud, a call, a DM. Not through
the relay. Anyone holding the phrase can pair until it expires in 15 minutes.

If pairing completed, show both fingerprints and tell them to check the two
match what their peer sees.
