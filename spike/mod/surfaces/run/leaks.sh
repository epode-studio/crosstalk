#!/bin/bash
# Greps each surface's canary in what a surfaces run left on disk.
#   spike/mod/surfaces/run/leaks.sh <run-dir>
# stored:   rows of the final live transcript other than api-request-blob and
#           the model's own replies (which quote whatever it saw).
# sent<↵:   user-role api-request-blob rows (what went to the API as the user
#           side) before card1 was handed over, after probe 1 and the mid-turn ask.
# sent:     the same, at the end of the live session (after the hand and probe 2).
# history:  <config>/history.jsonl at the end.
# resume:   user-role api-request-blob rows written after --resume.
# debug:    lines of the --debug log.
RUN=$1
B="$RUN/transcript-before-hand.jsonl" L="$RUN/transcript-after-live.jsonl" R="$RUN/transcript-after-resume.jsonl"
userblobs() { jq -c 'select(.type=="api-request-blob" and .message.role=="user")' "$1"; }
printf '%-15s %-11s %-7s %-7s %-6s %-8s %-7s %-6s\n' surface canary stored 'sent<↵' sent history resume debug
NEW=$(mktemp); comm -13 <(userblobs "$L" | sort) <(userblobs "$R" | sort) >"$NEW"
while read -r surface canary; do
  st=$(jq -c 'select(.type!="api-request-blob" and .type!="assistant")' "$L" | grep -c "$canary")
  s0=$(userblobs "$B" | grep -c "$canary")
  s1=$(userblobs "$L" | grep -c "$canary")
  h=$(grep -c "$canary" "$RUN/history-final.jsonl" 2>/dev/null || true)
  r=$(grep -c "$canary" "$NEW")
  d=$(cat "$RUN"/cfg/debug/*.txt | grep -c "$canary")
  printf '%-15s %-11s %-7s %-7s %-6s %-8s %-7s %-6s\n' "$surface" "$canary" "$st" "$s0" "$s1" "$h" "$r" "$d"
done <<'EOF'
ask-question    QUAIL-1101
ask-chosen      SWIFT-1103
ask-unchosen    ROBIN-1102
ask2-question   WREN-2201
ask2-chosen     LARK-2202
ask2-unchosen   MYNA-2203
ask3-dismissed  OWL-7701
card1-handed    MOSS-3301
chip1-handed    FERN-3302
card2-muted     REED-4401
chip2-muted     SEDGE-4402
pane            BIRCH-5501
pane-updated    ASPEN-5502
status-ansi     TEAL-6601
toast-ansi      LIME-6602
EOF
rm -f "$NEW"
echo "-- the model's answers (probe 1 before ↵, probe 2 after, probe 3 after --resume)"
jq -r 'select(.type=="assistant") | .message.content[]? | select(.type=="text") | .text' "$R" | grep -E 'xt-|NONE' | grep -v 'one hundred'
