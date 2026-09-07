---
description: What crosstalk has cost, per peer, both directions
allowed-tools: Bash(${CLAUDE_PLUGIN_ROOT}/bin/crosstalk:*)
---

!`"${CLAUDE_PLUGIN_ROOT}/bin/crosstalk" cli cost`

A delivered message costs the receiver a turn, the same as a prompt they typed,
so two agents talking spends money on both accounts. Token figures are estimated
from message length and are for orientation, not billing.
