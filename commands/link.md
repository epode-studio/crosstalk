---
description: Make another of your own machines the same identity, not a second person
argument-hint: "[six words, on the second machine]"
allowed-tools: Bash(${CLAUDE_PLUGIN_ROOT}/bin/crosstalk:*)
---

!`"${CLAUDE_PLUGIN_ROOT}/bin/crosstalk" cli link $ARGUMENTS`

Starting a room exchanges keys between two people. Linking copies one identity onto
another of your machines, so both answer to the same fingerprint, you appear once
in every room rather than twice, and a message reaches whichever machine you are
sitting at.

Run it with no arguments on the machine that already has your identity, then run
it with the six words on the other one.

Those six words carry your whole identity, not an introduction. Keep them between
your own two machines and nowhere else.
