#!/bin/bash
# The pane at other widths and layouts: does the unasked open at session start
# place it, does `o` on a card (an asked open) place it, does it redraw when the
# thread file changes. No model is asked; drive.sh covers what leaks.
#   spike/mod/surfaces/run/widths.sh <run-dir> <tmux-session>
# Writes <run-dir>/<columns>-<layout>/ with screens and the mod's log.
set -uo pipefail
BASE=$1 T=$2
HERE=$(cd "$(dirname "$0")" && pwd)
for spec in 100:default 130:default 200:main 100:main; do
  COLS=${spec%%:*} LAYOUT=${spec#*:}
  FLICKER=""; [ "$LAYOUT" = main ] && FLICKER=0
  RUN="$BASE/$COLS-$LAYOUT"
  "$HERE/setup.sh" "$RUN" "$T" "$COLS" "$FLICKER" >/dev/null
  cap() { tmux capture-pane -p -t "$T" >"$RUN/screen-$1.txt"; tmux capture-pane -e -p -t "$T" >"$RUN/screen-$1.ansi"; }
  sleep 12; cap 1-start
  tmux send-keys -t "$T" C-x; tmux send-keys -t "$T" Tab; sleep 0.6; tmux send-keys -t "$T" o; sleep 2; cap 2-opened
  tmux send-keys -t "$T" Escape; sleep 0.5
  "$HERE/thread2.sh" "$RUN"; sleep 2; cap 3-updated
  tmux kill-session -t "$T"
  echo "== $COLS $LAYOUT"; grep -E '"open"|"panes"|"pane"' "$RUN/xt/surfaces-log.jsonl"
done
