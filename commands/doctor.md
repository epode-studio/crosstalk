---
description: Check the crosstalk setup and say what is wrong
allowed-tools: Bash(${CLAUDE_PLUGIN_ROOT}/bin/crosstalk:*)
---

!`"${CLAUDE_PLUGIN_ROOT}/bin/crosstalk" cli doctor`

Show the output as-is, then help with whatever is marked ✗. The common ones:

- **relay unreachable**, if the peer hosts it, their machine must be awake and
  reachable from here.
- **no identity**, nothing is set up yet; run `/crosstalk:room new`.
- **inbox socket missing**, this session cannot receive anything. A session
  started in bare mode never binds one.
