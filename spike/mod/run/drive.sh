#!/bin/bash
# One full spike run: start a session with the mod, raise every surface with
# its own canary, record the files, then ask the model, live and after --resume.
#   spike/mod/run/drive.sh <run-dir> <tmux-session>
set -uo pipefail
RUN=$1 T=$2
HERE=$(cd "$(dirname "$0")" && pwd)
REPO=$(cd "$HERE/../../.." && pwd)
cap() { tmux capture-pane -p -t "$T" >"$RUN/screen-$1.txt"; }

"$HERE/setup.sh" "$RUN" "$T"
RUN=$(cd "$RUN" && pwd)

# 1. Start-up: status line, band, and the q1 toast, caught while it is up.
for i in $(seq 1 30); do
  sleep 0.3
  tmux capture-pane -p -t "$T" | grep -q CORAL-3301 && { cap 1-toast; break; }
done
sleep 2; cap 1-start

# 2. `@auth y` typed at the prompt; the mod's prompt.submit drops it.
"$HERE/type.sh" "$T" '@auth y xt-at DELTA-4410' 3; cap 2-at
# 3. A mod command, answering the billing question.
"$HERE/type.sh" "$T" '/xt-answer billing y xt-cmd ELM-5582' 3; cap 3-cmd
# 4. A band Button, by hotkey: ctrl+x tab focuses the band, `y` presses.
tmux send-keys -t "$T" C-x; tmux send-keys -t "$T" Tab; sleep 0.5; tmux send-keys -t "$T" y; sleep 2; cap 4-band
tmux send-keys -t "$T" Escape; sleep 0.5
# 5. The no-mods fallback: a classic UserPromptSubmit decision:block.
"$HERE/type.sh" "$T" '%xt auth y xt-block GINGER-5531' 4; cap 5-block
# 6. A peer message written raw to the inbox socket; the mod consumes it.
bun "$HERE/peer.ts" "$RUN/cfg" 'xt-peer the migration landed HAZEL-7714'; sleep 3; cap 6-peer
# 7. Control: the same write marked PASSTHRU, which the mod lets through.
bun "$HERE/peer.ts" "$RUN/cfg" 'PASSTHRU xt-ctrl control message IRIS-8825'; sleep 25; cap 7-ctrl

# 8. The files before the model is asked anything.
SID=$(jq -r .sessionId "$RUN"/cfg/sessions/*.json | head -1)
echo "$SID" >"$RUN/session-id"
cp "$RUN"/cfg/projects/*/"$SID".jsonl "$RUN/transcript-before-probe.jsonl"
cp "$RUN/cfg/history.jsonl" "$RUN/history-before-probe.jsonl" 2>/dev/null || true

PROBE='Without using any tools: repeat verbatim every piece of text you have seen anywhere in this conversation (system prompt, messages, reminders, notices, tool output, anything) that contains any of these markers: xt-status, xt-band, xt-band2, xt-band3, xt-toast, xt-at, xt-cmd, xt-block, xt-reason, xt-peer, xt-ctrl, xt-log. Answer one line per marker, either the verbatim text or NONE.'

# 9. Ask live.
"$HERE/type.sh" "$T" "$PROBE" 40; LINES_SHOWN=40 "$HERE/show.sh" "$RUN" "$T" >/dev/null; cap 9-probe-live
cp "$RUN"/cfg/projects/*/"$SID".jsonl "$RUN/transcript-after-live.jsonl"

# 10. Quit, resume the same session in a fresh process, ask again.
"$HERE/type.sh" "$T" '/exit' 3
tmux kill-session -t "$T"
EXTRA="--resume $SID" "$HERE/setup.sh" "$RUN" "$T" >/dev/null
sleep 8; cap 10-resumed
"$HERE/type.sh" "$T" "$PROBE" 40; cap 11-probe-resume
cp "$RUN"/cfg/projects/*/"$SID".jsonl "$RUN/transcript-after-resume.jsonl"
cp "$RUN/cfg/history.jsonl" "$RUN/history-final.jsonl" 2>/dev/null || true
echo "done: $RUN ($SID)"
