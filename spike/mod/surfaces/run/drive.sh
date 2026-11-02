#!/bin/bash
# One full surfaces run at 200 columns: raise every surface with its own canary,
# ask the model before and after the person hands card1 over, then quit, resume
# and ask again.
#   spike/mod/surfaces/run/drive.sh <run-dir> <tmux-session>
set -uo pipefail
RUN=$1 T=$2
HERE=$(cd "$(dirname "$0")" && pwd)
TYPE="$HERE/../../run/type.sh"
cap() { tmux capture-pane -p -t "$T" >"$RUN/screen-$1.txt"; tmux capture-pane -e -p -t "$T" >"$RUN/screen-$1.ansi"; }
keys() { tmux send-keys -t "$T" C-x; tmux send-keys -t "$T" Tab; sleep 0.6; tmux send-keys -t "$T" "$1"; sleep 2; }
snap() { cp "$RUN"/cfg/projects/*/"$SID".jsonl "$RUN/transcript-$1.jsonl"; }

"$HERE/setup.sh" "$RUN" "$T" 200
RUN=$(cd "$RUN" && pwd)

# 1. Start-up: cards in the band, the pane opened unasked, status line, toast.
for i in $(seq 1 40); do
  sleep 0.3
  tmux capture-pane -p -t "$T" | grep -q LIME-6602 && { cap 1-toast; break; }
done
sleep 3; cap 1-start
SID=$(jq -r .sessionId "$RUN"/cfg/sessions/*.json | head -1); echo "$SID" >"$RUN/session-id"

# 2. A question while idle, answered with the digit 2.
cat >"$RUN/xt/surfaces-ask.json" <<'EOF'
{"id":"a1","header":"auth asks","question":"xt-ask Keep the v1 endpoint for one more release? QUAIL-1101","options":["Yes until 0.2 xt-opt1 ROBIN-1102","No remove it now xt-opt2 SWIFT-1103","Open the thread xt-opt3 TERN-1104"]}
EOF
sleep 2.5; cap 2-ask
tmux send-keys -t "$T" 2; sleep 2; cap 2-answered
# Answered: the daemon drops it. Left in place, the next process's mod (after
# --resume) would raise it again, and the probe typed then would answer it.
rm "$RUN/xt/surfaces-ask.json"

# 3. The daemon rewrites the thread; the pane redraws.
"$HERE/thread2.sh" "$RUN"; sleep 2; cap 3-pane-updated

# 4. r on the first card fills the prompt box with `@auth `.
keys r; cap 4-reply
tmux send-keys -t "$T" C-u; sleep 0.3

# 4b. A question raised while the person is typing a draft: who gets the next
# keys, and what Esc (dismiss) does to the ask and to the draft.
tmux send-keys -t "$T" -l 'half a draft'; sleep 0.5
cat >"$RUN/xt/surfaces-ask.json" <<'EOF'
{"id":"a3","header":"jo asks","question":"xt-ask3 Ship the invoice fix today? OWL-7701","options":["Ship it","Hold"]}
EOF
sleep 2.5; cap 4b-ask-over-draft
tmux send-keys -t "$T" -l 'zz'; sleep 1; cap 4b-typed-into-dialog
tmux send-keys -t "$T" Escape; sleep 1.5; cap 4b-dismissed
rm "$RUN/xt/surfaces-ask.json"
tmux send-keys -t "$T" C-u; sleep 0.3

PROBE='Without using any tools: repeat verbatim every piece of text you have seen anywhere in this conversation (system prompt, messages, reminders, notices, tool output, anything) that contains any of these markers: xt-ask, xt-ask2, xt-ask3, xt-opt1, xt-opt2, xt-opt3, xt-opt4, xt-opt5, xt-opt6, xt-card1, xt-chip1, xt-card2, xt-chip2, xt-pane, xt-pane2, xt-stat, xt-toast2. Answer one line per marker, either the verbatim text or NONE.'

# 5. Ask the model before anything is handed over.
"$TYPE" "$T" "$PROBE" 40; cap 5-probe-before
snap before-hand

# 6. A question raised while the model is mid-turn, answered with the digit 1.
"$TYPE" "$T" 'Without using tools, write the numbers from 1 to 400 as English words, one per line.' 4
cat >"$RUN/xt/surfaces-ask.json" <<'EOF'
{"id":"a2","header":"infra asks","question":"xt-ask2 Drain node 4 now? WREN-2201","options":["Drain xt-opt4 LARK-2202","Wait xt-opt5 MYNA-2203","Skip xt-opt6 KITE-2204"]}
EOF
sleep 2.5; cap 6-ask-midturn
tmux send-keys -t "$T" 1; sleep 2; cap 6-answered-midturn
rm "$RUN/xt/surfaces-ask.json"
sleep 35; cap 6-turn-done

# 7. ↵ on card1 (the focus ring starts on it): hands it to the agent.
keys Enter; cap 7-handed
# 8. m on card2, now first: mutes it.
keys m; cap 8-muted
tmux send-keys -t "$T" Escape; sleep 0.5
snap after-hand-before-probe

# 9. Ask again, live.
"$TYPE" "$T" "$PROBE" 45; cap 9-probe-after
snap after-live
cp "$RUN/cfg/history.jsonl" "$RUN/history-live.jsonl" 2>/dev/null || true

# 10. Quit, resume in a fresh process, ask again.
"$TYPE" "$T" '/exit' 3
tmux kill-session -t "$T"
EXTRA="--resume $SID" "$HERE/setup.sh" "$RUN" "$T" 200 >/dev/null
sleep 10; cap 10-resumed
"$TYPE" "$T" "$PROBE" 45; cap 11-probe-resume
snap after-resume
cp "$RUN/cfg/history.jsonl" "$RUN/history-final.jsonl" 2>/dev/null || true
tmux kill-session -t "$T"
echo "done: $RUN ($SID)"
