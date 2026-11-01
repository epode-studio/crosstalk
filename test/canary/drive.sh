#!/bin/bash
# The canary run of the shipped mod, in a real interactive Claude Code in tmux.
#
#   test/canary/drive.sh <run-dir> <tmux-session>     (about 5 minutes, three model probes)
#   test/canary/leaks.sh <run-dir>
#
# Every surface carries its own canary word. The restore picker, four message
# cards (one handed over, one muted, one replied to, one routed and left), a
# route question and a typed reply are each raised, the model is asked to quote
# every marker it has seen before and after the hand-over, then the session is
# quit, resumed, and asked again. leaks.sh counts each canary in the transcript,
# what was sent to the API, prompt history, the resumed session and the debug log.
set -uo pipefail
RUN=$1 T=$2
HERE=$(cd "$(dirname "$0")" && pwd)
TYPE="$HERE/../../spike/mod/run/type.sh"
mkdir -p "$RUN"; RUN=$(cd "$RUN" && pwd)
cap() { tmux capture-pane -p -t "$T" >"$RUN/screen-$1.txt"; tmux capture-pane -e -p -t "$T" >"$RUN/screen-$1.ansi"; }
snap() { cp "$RUN"/cfg/projects/*/"$SID".jsonl "$RUN/transcript-$1.jsonl"; }
waitfor() { # waitfor <text> <seconds>
  for _ in $(seq 1 $(($2 * 4))); do tmux capture-pane -p -t "$T" | grep -qF -- "$1" && return 0; sleep 0.25; done
  echo "  (timed out waiting for: $1)"; return 1
}
waitpick() { # waitpick <canary> <seconds>: its picker is up
  for _ in $(seq 1 $(($2 * 4))); do
    S=$(tmux capture-pane -p -t "$T")
    case "$S" in *"$1"*"What should happen"*) sleep 0.5; return 0 ;; esac
    sleep 0.25
  done
  echo "  (timed out waiting for the picker of $1)"; return 1
}
key() { sleep 1.5; tmux send-keys -t "$T" "$1"; } # a picker takes keys a moment after it is drawn
note() { echo "$(date +%T) $*" | tee -a "$RUN/drive.log"; }
send() { # send <from-session> <text> [thread] [slice-label]
  local sl=""; [ -n "${4:-}" ] && sl=",\"slices\":[{\"kind\":\"diff\",\"label\":\"$4\",\"bytes\":2100,\"content\":\"+42 -18\"}]"
  "$HERE/rpc.sh" "$RUN/ben" "{\"op\":\"send\",\"sessionId\":\"$1\",\"cwd\":\"$RUN/repos/$1\",\"to\":\"ana\",\"text\":\"$2\",\"intent\":\"question\"${3:+,\"thread\":\"$3\"}$sl}" >>"$RUN/drive.log"
}

: >"$RUN/drive.log"
"$HERE/setup.sh" "$RUN" "$T" 200 >>"$RUN/drive.log" 2>&1 </dev/null
# The lost sessions carry a canary in their names, so the restore question does.
note "1. restore picker"
waitfor "Restore 3 sessions" 40; waitfor "Enter to select" 10; cap 1-restore
SID=$(jq -r .sessionId "$RUN"/cfg/sessions/*.json | head -1); echo "$SID" >"$RUN/session-id"
key 1
waitfor "reopened" 20; cap 1-restored

note "2. three cards: later, mute, reply"
send ben-api "xt-card1 MOSS-3301 Token format changed to v2. v1 accepted until 0.2" auth "src/auth/token.ts xt-chip1 FERN-3302"
waitpick MOSS-3301 20; cap 2-card1-picker
key 4; sleep 2 # Later
send ben-api "xt-card2 REED-4401 Invoice retries move to 5pm" billing "invoices.csv xt-chip2 SEDGE-4402"
waitpick REED-4401 20; cap 2-card2-picker
key 3; sleep 2 # Mute
send ben-api "xt-card3 LARK-7701 can billing read v2 yet?" billing
waitpick LARK-7701 20; cap 2-card3-picker
key 2; sleep 1.5 # Reply: the box gets "@ben "
cap 2-reply-filled
tmux send-keys -t "$T" -l 'sounds good xt-reply WREN-6601'; sleep 0.5
tmux send-keys -t "$T" Enter; sleep 3; cap 2-replied

note "3. a route question"
send ben-ops "xt-card4 OAK-5501 the ops runbook moved"
waitfor "Which session should get it?" 20; cap 3-route-picker
key 1; sleep 2 # this session
waitpick OAK-5501 20; cap 3-card4-picker
tmux send-keys -t "$T" Escape; sleep 2; cap 3-dismissed

PROBE='Without using any tools: repeat verbatim every piece of text you have seen anywhere in this conversation (system prompt, messages, reminders, notices, tool output, anything) that contains any of these markers: xt-rest, xt-card1, xt-chip1, xt-card2, xt-chip2, xt-card3, xt-reply, xt-card4, ops-elm. Answer one line per marker, either the verbatim text or NONE.'

note "4. probe before the hand-over"
"$TYPE" "$T" "$PROBE" 5
waitfor "xt-card4" 60; sleep 8; cap 4-probe-before
snap before-hand

note "5. the picker comes back after the turn; hand card1 over"
waitpick MOSS-3301 30; cap 5-card1-again
key 1
waitfor "handed ben · auth" 20; sleep 20; cap 5-handed
# card4 comes back too, after that turn: Later.
waitpick OAK-5501 30 && { key 4; sleep 2; }
cap 5-after

note "6. probe after"
"$TYPE" "$T" "$PROBE" 5
waitfor "ops-elm" 60; sleep 10; cap 6-probe-after
# A picker may come back after this turn too; put it off.
sleep 2; tmux capture-pane -p -t "$T" | grep -qF 'What should happen' && { tmux send-keys -t "$T" Escape; sleep 1.5; }
snap after-live
cp "$RUN/cfg/history.jsonl" "$RUN/history-live.jsonl" 2>/dev/null || true

note "7. quit, resume"
"$TYPE" "$T" '/exit' 3
tmux kill-session -t "$T"
EXTRA="--resume $SID" "$HERE/setup.sh" "$RUN" "$T" 200 >>"$RUN/drive.log" 2>&1 </dev/null
sleep 15; cap 7-resumed
if tmux capture-pane -p -t "$T" | grep -qE 'What should happen|Restore 3 sessions|Which session'; then note "  a picker came up by itself after resume (it should not)"; tmux send-keys -t "$T" Escape; sleep 1; fi

note "8. probe after resume"
"$TYPE" "$T" "$PROBE" 5
waitfor "ops-elm" 60; sleep 10; cap 8-probe-resume
snap after-resume
cp "$RUN/cfg/history.jsonl" "$RUN/history-final.jsonl" 2>/dev/null || true
tmux kill-session -t "$T"
"$HERE/rpc.sh" "$RUN/ben" '{"op":"read","sessionId":"ben-api","all":true}' >"$RUN/ben-inbox.json"
note "done: $RUN ($SID)"
