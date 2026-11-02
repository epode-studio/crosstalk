#!/bin/bash
# Rewrites the run's thread file as the daemon would after news: a new question
# waiting, a new status, one more recent message. The pane should redraw.
#   spike/mod/surfaces/run/thread2.sh <run-dir>
cat >"$1/xt/surfaces-thread.json" <<'EOF'
{ "name": "auth", "status": "working",
  "people": [ { "name": "marie", "online": true }, { "name": "jo", "online": true } ],
  "waiting": [ "xt-pane2 drain node 4 before the rollout? ASPEN-5502" ],
  "decision": "keep v1 until 0.2 (answered just now)",
  "recent": [ { "from": "jo", "age": "now", "text": "joined auth" },
              { "from": "marie", "age": "2m", "text": "token format changed to v2" } ] }
EOF
