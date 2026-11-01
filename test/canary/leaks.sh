#!/bin/bash
# Counts each canary in what a canary run left on disk.
#   test/canary/leaks.sh <run-dir>
# stored:   rows of the final live transcript other than api-request-blob rows
#           and the model's own replies (which quote whatever it saw).
# sent<↵:   user-role api-request-blob rows (what went to the API from the user
#           side) before card1 was handed over: after the first probe.
# sent:     the same, at the end of the live session.
# history:  <config>/history.jsonl at the end.
# resume:   user-role api-request-blob rows first sent after --resume.
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
restore-picker  QUAIL-1101
card1-handed    MOSS-3301
chip1-handed    FERN-3302
card2-muted     REED-4401
chip2-muted     SEDGE-4402
card3-replied   LARK-7701
reply-typed     WREN-6601
route-question  elm5502
card4-routed    OAK-5501
EOF
rm -f "$NEW"
echo "-- the model's answers (probe 1 before the hand-over, probe 2 after, probe 3 after --resume)"
jq -r 'select(.type=="assistant") | .message.content[]? | select(.type=="text") | .text' "$R" | grep -E 'xt-|ops-elm|NONE'
echo "-- what ben received"
jq -r '.messages[]?.text' "$RUN/ben-inbox.json" 2>/dev/null
echo "-- reopened by the restore picker"
cat "$RUN/restored.txt" 2>/dev/null
