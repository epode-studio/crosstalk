---
description: Who you are paired with, whether they are online, and what their sessions are working on
allowed-tools: Bash(${CLAUDE_PLUGIN_ROOT}/bin/crosstalk:*)
---

!`"${CLAUDE_PLUGIN_ROOT}/bin/crosstalk" cli peers`

Show this to the user as-is. Do not summarise it away, the repo and busy/idle
state per session is the point.
