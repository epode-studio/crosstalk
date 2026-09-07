---
description: Move your crosstalk private key into the macOS keychain
allowed-tools: Bash(${CLAUDE_PLUGIN_ROOT}/bin/crosstalk:*)
---

!`"${CLAUDE_PLUGIN_ROOT}/bin/crosstalk" cli secure`

By default the private key sits in `~/.claude/crosstalk/identity.json` at mode
0600, the way an SSH key without a passphrase does. This moves it into the
keychain and leaves only the public half on disk, so a process that reads your
files cannot walk away with your identity.

macOS only. The key cannot be recovered afterwards except from the keychain, so
if it is deleted there you have to pair again.
