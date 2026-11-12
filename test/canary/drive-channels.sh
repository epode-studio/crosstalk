#!/bin/bash
# A peer's notice in a real Claude Code, with channels on and with them off.
#
#   test/canary/drive-channels.sh <run-dir> <tmux-session> [on|off]
#
# Runs the plugin with no mod (as drive-nomod.sh does), so the only question is
# which transport carries the notice. "on" starts Claude Code with
# --dangerously-load-development-channels plugin:crosstalk@inline and accepts its
# warning; "off" starts it plainly. ben then sends a message, and the transcript
# must name it exactly once: as a <channel source="plugin:crosstalk:crosstalk">
# event when on, as the classic inbox notice when off. Neither may carry ben's
# words, which stay behind crosstalk_people action "read".
set -uo pipefail
RUN=$1 T=$2 MODE=${3:-off}
HERE=$(cd "$(dirname "$0")" && pwd)
ROOT=$(cd "$HERE/../.." && pwd)
mkdir -p "$RUN"; RUN=$(cd "$RUN" && pwd)
cap() { tmux capture-pane -p -t "$T" >"$RUN/screen-$1.txt"; }
waitfor() { for _ in $(seq 1 $(($2 * 4))); do tmux capture-pane -p -t "$T" | grep -qF -- "$1" && return 0; sleep 0.25; done; echo "  (timed out waiting for: $1)"; return 1; }
note() { echo "$(date +%T) $*" | tee -a "$RUN/drive.log"; }
: >"$RUN/drive.log"

rm -rf "$RUN/plugin"; mkdir -p "$RUN/plugin"
(cd "$ROOT" && tar --exclude=.git --exclude=./test --exclude=./spike --exclude=./research_notes -cf - .) | tar -C "$RUN/plugin" -xf -
bun -e 'const f = process.argv[1]; const j = JSON.parse(await Bun.file(f).text()); delete j.modules; await Bun.write(f, JSON.stringify(j, null, 2))' "$RUN/plugin/hooks/hooks.json"
FLAGS=""
[ "$MODE" = on ] && FLAGS="--dangerously-load-development-channels plugin:crosstalk@inline"
FLAGS="$FLAGS" PLUGIN="$RUN/plugin" PORT=8902 "$HERE/setup.sh" "$RUN" "$T" 200 >>"$RUN/drive.log" 2>&1 </dev/null

note "1. start ($MODE)"
if [ "$MODE" = on ]; then
  waitfor "I am using this for local development" 30 && tmux send-keys -t "$T" Enter
fi
waitfor "restore them" 40; sleep 5; cap 1-start
grep -h "channel push\|Channel notifications" "$RUN"/cfg/debug/*.txt | tee -a "$RUN/drive.log"

note "2. a peer message"
"$HERE/rpc.sh" "$RUN/ben" "{\"op\":\"send\",\"sessionId\":\"ben-api\",\"cwd\":\"$RUN/repos/ben-api\",\"to\":\"ana\",\"text\":\"channels HAWK-7707 retry budget halved\",\"intent\":\"question\"}" >>"$RUN/drive.log"
sleep 40; cap 2-notice
grep -h "inbound\|held for\|subscriber" "$RUN/ana/daemon.log" | tail -3 >>"$RUN/drive.log"
F=$(ls "$RUN"/cfg/projects/*/*.jsonl | head -1)
# The notice as it entered the conversation: a user row, not the model's own words.
ROWS=$(jq -c 'select(.type=="user")' "$F" | grep -F 'waiting from ben')
note "  user rows naming the waiting message: $(printf '%s' "$ROWS" | grep -c . )"
note "  of which channel events: $(printf '%s' "$ROWS" | grep -c '<channel source=')"
note "  of which inbox notices: $(printf '%s' "$ROWS" | grep -c '<crosstalk pending=')"
# Ben's words may reach the model only as crosstalk_read's output, so nothing
# carrying them goes to the API before the first call to it.
READ_AT=$(grep -n '"type":"tool_use"[^}]*"name":"mcp__plugin_crosstalk_crosstalk__crosstalk_people"' "$F" | head -1 | cut -d: -f1)
note "  crosstalk_people action "read" called: $([ -n "$READ_AT" ] && echo "yes, at row $READ_AT" || echo no)"
note "  HAWK-7707 sent to the API before that: $(head -n $(( ${READ_AT:-999999} - 1 )) "$F" | grep -c HAWK-7707)"
tmux kill-session -t "$T"
note "done"
