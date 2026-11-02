---
description: Join someone outside your repos with four words, or get words to read to them
argument-hint: "[the number and four words you were read]   or   link <six words>"
allowed-tools: Bash(${CLAUDE_PLUGIN_ROOT}/bin/crosstalk:*)
---

!`"${CLAUDE_PLUGIN_ROOT}/bin/crosstalk" cli join $ARGUMENTS`

People who share a repository with you need no words: crosstalk trusts them
through the keys they publish. The four words are for anyone else, read aloud
once, anywhere except through crosstalk.

- With nothing after it: show the words exactly as printed, once, for the user
  to read aloud. Never repeat them afterwards, in a reply, a summary, a commit
  or a tool call.
- With the words: they join. Show the fingerprint lines as printed; both people
  read theirs aloud.
- `link <six words>`: on a second machine of the user's own, makes it the same
  person rather than a second one.

Saying it works too ("marie gave me words: …"); this command is for when the
words should not go into the conversation at all.
