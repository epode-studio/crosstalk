#!/bin/bash
# Greps each surface's canary in what the run left on disk.
#   spike/mod/run/leaks.sh <run-dir>
# transcript: any line of the session JSONL before the model was asked anything.
# sent:       the api-request-blob rows of that JSONL, which hold what was sent.
# history:    ~/.claude/history.jsonl (prompt history, the Up arrow).
# resumed:    the JSONL after --resume and the second question, less the
#             model's own answers (which quote whatever it saw).
RUN=$1
B="$RUN/transcript-before-probe.jsonl" R="$RUN/transcript-after-resume.jsonl"
printf '%-12s %-11s %-10s %-6s %-8s %-8s\n' surface canary transcript sent history resume-sent
while read -r surface canary; do
  t=$(grep -c "$canary" "$B")
  s=$(jq -c 'select(.type=="api-request-blob")' "$B" | grep -c "$canary")
  h=$(grep -c "$canary" "$RUN/history-final.jsonl" 2>/dev/null || true)
  r=$(jq -c 'select(.type=="api-request-blob")' "$R" | grep -v 'NONE' | grep -c "$canary")
  printf '%-12s %-11s %-10s %-6s %-8s %-8s\n' "$surface" "$canary" "$t" "$s" "$h" "$r"
done <<'EOF'
status      AMBER-1017
band        BISON-2048
toast       CORAL-3301
@auth       DELTA-4410
/command    ELM-5582
band-button JADE-9936
block       GINGER-5531
block-why   CEDAR-2290
peer        HAZEL-7714
ui.log      PLUM-6142
control     IRIS-8825
EOF
