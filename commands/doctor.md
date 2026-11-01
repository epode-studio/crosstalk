---
description: Check the crosstalk setup and say what is wrong
allowed-tools: Bash(${CLAUDE_PLUGIN_ROOT}/bin/crosstalk:*)
---

!`"${CLAUDE_PLUGIN_ROOT}/bin/crosstalk" cli doctor`

Show the output as-is, then help with whatever is marked ✗. The common ones:

- **relay unreachable**, if the peer hosts it, their machine must be awake and
  reachable from here.
- **no identity**, nothing is set up yet; run `/crosstalk:room new`.
- **restore**, sessions were lost to a restart or a crashed terminal. Offer to
  bring them back, and call `crosstalk_restore` with `confirm: true` if the
  user wants that.
- **accessibility / automation** (macOS), without these, restored sessions
  open as one window each, not as tabs. Show the steps printed next to them.
  `open "x-apple.systempreferences:…"` opens the right pane.
- **inbox socket missing**, this session cannot receive anything. A session
  started in bare mode never binds one.
