---
description: The old name for /crosstalk:room new and /crosstalk:room join
argument-hint: "[four-word phrase] or nothing to start one"
allowed-tools: Bash(${CLAUDE_PLUGIN_ROOT}/bin/crosstalk:*)
---

!`"${CLAUDE_PLUGIN_ROOT}/bin/crosstalk" cli pair $ARGUMENTS`

This is what starting a room of two used to be called. It still works, so an
identity set up before rooms keeps answering to it, but tell the user the
current names: `/crosstalk:room new` to start one, `/crosstalk:room join
<phrase>` to join.

If an invite phrase was printed, show it exactly as printed and tell the user to
send it somewhere they already trust, said out loud, a call, a DM. Not through
the relay. Anyone holding the phrase can join until it expires in 15 minutes.

If they are now in a room, show both fingerprints and tell them to check that
the pair they see matches the pair their peer sees.
