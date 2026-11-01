#!/bin/bash
# Prepares one canary run of the shipped plugin and starts it in tmux.
#
#   test/canary/setup.sh <run-dir> <tmux-session> [columns]
#
# The run dir gets:
#   cfg/    CLAUDE_CONFIG_DIR for the session under test
#   ana/    CROSSTALK_HOME of the person at the keyboard (in a room with ben)
#   ben/    CROSSTALK_HOME of the peer, whose daemon sends the messages
#   work/   the session's cwd, a git repo on github.com/acme/api
#   stub/   a `claude` that only records how it was started, first on PATH, so
#           a restore picked in the run opens nothing real
# Three sessions "lost to a restart" are seeded for the restore offer.
#
# EXTRA="--resume <id>" restarts the session in the same run without reseeding.
# SETTINGS='<json>' writes the session's settings.json (drive-nomod.sh turns mods off with it).
set -euo pipefail
RUN=$1 NAME=$2 COLS=${3:-200}
HERE=$(cd "$(dirname "$0")" && pwd)
ROOT=$(cd "$HERE/../.." && pwd)
PORT=${PORT:-8899}
mkdir -p "$RUN"
RUN=$(cd "$RUN" && pwd)

stop_daemon() {
  if [ -f "$1/daemon.lock" ]; then
    P=$(cat "$1/daemon.lock")
    kill "$P" 2>/dev/null || true
    for _ in $(seq 1 30); do kill -0 "$P" 2>/dev/null || break; sleep 0.2; done
  fi
  rm -f "$1/daemon.sock" "$1/daemon.lock"
}

if [ -z "${EXTRA:-}" ]; then
  stop_daemon "$RUN/ana" 2>/dev/null || true
  stop_daemon "$RUN/ben" 2>/dev/null || true
  [ -f "$RUN/relay.pid" ] && kill "$(cat "$RUN/relay.pid")" 2>/dev/null || true
  rm -rf "$RUN"/{cfg,ana,ben,work,stub,repos,relay}
  mkdir -p "$RUN"/{cfg,ana,ben,work,stub,repos,relay}

  cat >"$RUN/cfg/.claude.json" <<EOF
{ "hasCompletedOnboarding": true, "theme": "dark", "bypassPermissionsModeAccepted": true,
  "projects": { "$RUN/work": { "hasTrustDialogAccepted": true, "hasCompletedProjectOnboarding": true } } }
EOF
  if [ -n "${SETTINGS:-}" ]; then printf '%s' "$SETTINGS" >"$RUN/cfg/settings.json"; fi

  repo() { git -C "$1" init -q -b main && git -C "$1" remote add origin "$2" && git -C "$1" -c user.email=t@t -c user.name=t commit -q --allow-empty -m init; }
  repo "$RUN/work" "git@github.com:acme/api.git"
  mkdir -p "$RUN/repos/ben-api" "$RUN/repos/ben-ops"
  repo "$RUN/repos/ben-api" "https://github.com/acme/api"
  repo "$RUN/repos/ben-ops" "git@github.com:acme/ops-elm5502.git"   # its repo is the route question's canary

  cat >"$RUN/stub/claude" <<EOF
#!/bin/sh
printf '%s|%s\n' "\$(pwd)" "\$*" >>"$RUN/restored.txt"
exec sleep 600
EOF
  chmod +x "$RUN/stub/claude"

  # A local relay, and ana and ben in a room on it.
  (cd "$RUN/relay" && exec bun "$ROOT/relay/relay.ts" --host 127.0.0.1 --port "$PORT" >"$RUN/relay.log" 2>&1) &
  echo $! >"$RUN/relay.pid"
  for _ in $(seq 1 30); do curl -sf -m 1 "http://127.0.0.1:$PORT/health" >/dev/null && break; sleep 0.3; done
  (cd "$ROOT" && CROSSTALK_HOME="$RUN/ana" bun src/cli.ts room new --label ana --relay "ws://127.0.0.1:$PORT" >"$RUN/pa.log" 2>&1) &
  INVITE=""
  for _ in $(seq 1 40); do
    INVITE=$(sed -n 's/^    \([0-9]\{3,6\}-[a-z][a-z-]*.*\)$/\1/p' "$RUN/pa.log" | head -1)
    [ -n "$INVITE" ] && break
    sleep 0.5
  done
  [ -z "$INVITE" ] && { echo "no invite"; cat "$RUN/pa.log"; exit 1; }
  (cd "$ROOT" && CROSSTALK_HOME="$RUN/ben" bun src/cli.ts room join $INVITE --label ben --relay "ws://127.0.0.1:$PORT" >"$RUN/pb.log" 2>&1)
  for _ in $(seq 1 30); do grep -q "Now in a room with" "$RUN/pa.log" && break; sleep 0.5; done
  stop_daemon "$RUN/ana"; stop_daemon "$RUN/ben"
  (cd "$ROOT" && CROSSTALK_HOME="$RUN/ben" nohup bun src/daemon.ts >"$RUN/db.log" 2>&1 &)
  for _ in $(seq 1 40); do [ -S "$RUN/ben/daemon.sock" ] && break; sleep 0.25; done
  for s in ben-api ben-ops; do
    "$HERE/rpc.sh" "$RUN/ben" "{\"op\":\"register\",\"sessionId\":\"$s\",\"pid\":1,\"name\":\"$s\",\"cwd\":\"$RUN/repos/$s\",\"socket\":\"\"}" >/dev/null
  done

  # Three sessions lost to a "restart" five minutes ago.
  NOW_MS=$(bun -e 'console.log(Date.now())')
  echo $((NOW_MS - 5 * 60 * 1000)) >"$RUN/boot"
  mkdir -p "$RUN/ana/open" "$RUN/lost"
  i=0
  # The first one's name is the restore question's canary.
  for n in firmware docs web; do
    i=$((i+1)); mkdir -p "$RUN/lost/$n"
    nm=$n; [ $n = firmware ] && nm="xt-rest QUAIL-1101"
    cat >"$RUN/ana/open/lost-$n.json" <<EOF
{ "sessionId": "lost-$n", "cwd": "$RUN/lost/$n", "client": "claude", "name": "$nm", "pid": 999990, "startedAt": $((NOW_MS - 7200000 + i)), "seenAt": $((NOW_MS - 900000)), "terminal": {}, "interactive": true }
EOF
  done
fi

BOOT=$(cat "$RUN/boot")
tmux kill-session -t "$NAME" 2>/dev/null || true
tmux new-session -d -s "$NAME" -x "$COLS" -y 50 \
  "source $ROOT/spike/mod/run/env.sh; cd $RUN/work; export PATH=$RUN/stub:\$PATH CLAUDE_CONFIG_DIR=$RUN/cfg CROSSTALK_HOME=$RUN/ana CROSSTALK_BOOT_TIME=$BOOT CROSSTALK_NO_WAITER=1 CROSSTALK_NO_OPEN=1 ${ENVX:-}; $(command -v claude) --plugin-dir ${PLUGIN:-$ROOT} --debug ${EXTRA:-}; sleep 600"
echo "started $NAME in $RUN ($COLS columns)"
