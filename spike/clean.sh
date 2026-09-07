#!/usr/bin/env bash
# Remove registry entries and sockets left behind by a hard-killed listen.ts.
set -euo pipefail
SESSIONS="$HOME/.claude/sessions"
for f in "$SESSIONS"/*.json; do
  [ -e "$f" ] || continue
  name=$(/usr/bin/python3 -c 'import json,sys; print(json.load(open(sys.argv[1])).get("name",""))' "$f" 2>/dev/null || echo "")
  case "$name" in crosstalk-probe*) ;; *) continue ;; esac
  pid=$(basename "$f" .json)
  if kill -0 "$pid" 2>/dev/null; then
    echo "skip $f (pid $pid still alive)"
    continue
  fi
  rm -f "$f" "$SESSIONS/$pid".*.key "/tmp/cc-socks/$pid.sock"
  echo "removed stale probe $pid"
done
