#!/bin/bash
# Clears the prompt box, types a line into the tmux session and presses Enter, then waits.
#   spike/mod/run/type.sh <tmux-session> <text> [wait-seconds]
tmux send-keys -t "$1" C-u   # a blocked prompt is handed back to the box
sleep 0.2
tmux send-keys -t "$1" -l "$2"
sleep 0.5
tmux send-keys -t "$1" Enter
sleep "${3:-3}"
