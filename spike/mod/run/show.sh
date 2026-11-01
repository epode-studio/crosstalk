#!/bin/bash
# Prints what the run has recorded: the screen, the transcript rows, prompt history.
#   spike/mod/run/show.sh <run-dir> <tmux-session>
RUN=$1
echo "== screen"; tmux capture-pane -p -t "$2" | grep -v '^\s*$' | tail -${LINES_SHOWN:-14}
echo "== transcript"
for f in "$RUN"/cfg/projects/*/*.jsonl; do
  jq -c '{type, sub: .subtype, meta: .isMeta, c: (.message.content // .content // .operation)}' "$f" | cut -c1-${WIDTH:-400}
done
echo "== history"; cat "$RUN/cfg/history.jsonl" 2>/dev/null | jq -c .display
