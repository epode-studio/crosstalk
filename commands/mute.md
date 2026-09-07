---
description: Hold inbound crosstalk messages for a while without disconnecting
argument-hint: "[peer] [minutes]"
allowed-tools: Bash(${CLAUDE_PLUGIN_ROOT}/bin/crosstalk:*)
---

!`"${CLAUDE_PLUGIN_ROOT}/bin/crosstalk" cli mute $ARGUMENTS`

Muting holds messages rather than dropping them. They surface when the mute
expires or when the session next goes idle. Pass 0 minutes to unmute.
