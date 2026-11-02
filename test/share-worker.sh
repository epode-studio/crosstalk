#!/usr/bin/env bash
# Sharing a running server through the hosted relay's code, end to end, with
# its daily stream allowance made small (worker/README.md, "Stream frames").
#
#   WRANGLER=/path/to/wrangler bash test/share-worker.sh
#
# The Worker runs under a local `wrangler dev` (workerd; nothing deployed,
# nothing reached over the network), and two daemons treat it as the hosted
# relay (CROSSTALK_RELAY_KIND=worker). ana shares a server with ben:
#
#   live      the Worker's ready says streams; ben's curl gets ana's page over
#             stream frames, and neither mailbox stored any of it
#   paused    a 2 MB response is far over ana's day (30 frames here): the
#             Worker refuses with stream_paused; ana is told and ben gets a
#             plain message from her, both "paused until tomorrow ... --host
#             or worker/", once
#   stopped   ana's daemon sends no more share frames, and none as stored sends
#   messages  ordinary messages between them still go
#
# Skipped (exit 0, says so) when wrangler is not installed.

set -u
export CROSSTALK_NO_GATHER=1 CROSSTALK_NO_RESTORE=1 CROSSTALK_NO_REPOTRUST=1 CROSSTALK_NO_NOTIFY=1 CROSSTALK_NO_DOCTOR=1 CROSSTALK_NO_OPEN=1
export CROSSTALK_THREAD_SYNC_MS=600000 CROSSTALK_THREADS_NO_PUSH=1 CROSSTALK_CLEANUP_EVERY_MS=0 CROSSTALK_NO_EXTRAS_TICK=1
export CROSSTALK_PORT_START=${CROSSTALK_PORT_START:-48700}
export CROSSTALK_URL_TICK_MS=300 CROSSTALK_URL_SYNC_MS=300 CROSSTALK_SHARE_TICK_MS=300
export CROSSTALK_RELAY_KIND=worker
cd "$(dirname "$0")/.."
ROOT=$(pwd)

WR=${WRANGLER:-}
[ -z "$WR" ] && [ -x worker/node_modules/.bin/wrangler ] && WR="$ROOT/worker/node_modules/.bin/wrangler"
[ -z "$WR" ] && WR=$(command -v wrangler 2>/dev/null || true)
if [ -z "$WR" ]; then
  echo "SKIPPED: wrangler is not installed (set WRANGLER=/path/to/wrangler); the Worker share test did not run"
  exit 0
fi

PORT=${SHARE_WORKER_PORT:-8794}
PA=${SHARE_WORKER_PROXY_A:-48761}
PB=${SHARE_WORKER_PROXY_B:-48762}
TMP=$(mktemp -d)
A="$TMP/a"; B="$TMP/b"
export HOME="$TMP/user"
export TMUX_TMPDIR="$TMP/tmux"
export GIT_AUTHOR_NAME=t GIT_AUTHOR_EMAIL=t@t GIT_COMMITTER_NAME=t GIT_COMMITTER_EMAIL=t@t
unset TMUX TMUX_PANE TERM_PROGRAM CLAUDE_CODE_MESSAGING_SOCKET CLAUDE_CODE_SESSION_ID CROSSTALK_BG_AGENT CLAUDECODE
mkdir -p "$HOME/.claude/sessions" "$A" "$B" "$TMUX_TMPDIR" "$TMP/wr"
FAILED=0
PASSES=0
pass() { echo "  PASS  $1"; PASSES=$((PASSES+1)); }
fail() { echo "  FAIL  $1"; FAILED=1; }
check() { if [ "$1" = "$2" ]; then pass "$3"; else fail "$3 (wanted '$2', got '$1')"; fi; }
has() { case "$1" in *"$2"*) pass "$3" ;; *) fail "$3"; echo "        got: $1" | head -c 1500; echo ;; esac; }
hasnt() { case "$1" in *"$2"*) fail "$3"; echo "        got: $1" | head -c 1500; echo ;; *) pass "$3" ;; esac; }
stop_daemon() {
  if [ -f "$1/daemon.lock" ]; then
    P=$(cat "$1/daemon.lock")
    kill "$P" 2>/dev/null
    for _ in $(seq 1 30); do kill -0 "$P" 2>/dev/null || break; sleep 0.2; done
    kill -0 "$P" 2>/dev/null && kill -9 "$P" 2>/dev/null
  fi
  rm -f "$1/daemon.sock" "$1/daemon.lock"
}
start_daemon() { CROSSTALK_HOME="$1" CROSSTALK_PROXY_PORT="$2" nohup bun src/daemon.ts >>"$3" 2>&1 & }
rpc() { CROSSTALK_HOME="$1" bun -e '
  const { request } = await import("./src/client.ts")
  console.log(JSON.stringify(await request(JSON.parse(process.argv[1]), 60000)))
' "$2" 2>&1; }
field() { echo "$1" | bun -e 'const r = JSON.parse(await Bun.stdin.text()); const v = (0, eval)("(r) => " + process.argv[1])(r); console.log(typeof v === "string" ? v : JSON.stringify(v ?? null))' "$2"; }
mcp() { bun "$ROOT/test/mcp-call.ts" "$1" "$2" "$3" "$4" "$5" 2>&1; }
via() { curl -s --max-time "${4:-10}" --resolve "$2:$1:127.0.0.1" "http://$2:$1${3:-/}" 2>/dev/null; }
waitfor() {
  local n=$1; shift
  for _ in $(seq 1 $((n * 5))); do v=$("$@" 2>/dev/null); [ -n "$v" ] && { echo "$v"; return; }; sleep 0.2; done
  echo ""
}
WR_PID=""
cleanup() {
  stop_daemon "$A"; stop_daemon "$B"
  [ -n "$WR_PID" ] && { kill "$WR_PID" 2>/dev/null; sleep 0.5; kill -9 "$WR_PID" 2>/dev/null; }
  tmux -L crosstalk kill-server 2>/dev/null
  pkill -f "$TMP/" 2>/dev/null
  rm -rf "$TMP"
}
trap cleanup EXIT
echo "state in $TMP"

cat >"$TMP/srv.ts" <<'EOF'
const port = Number(process.env.PORT)
const big = new Uint8Array(2 * 1024 * 1024).map((_, i) => (i * 13) % 251)
Bun.serve({
  port,
  hostname: "127.0.0.1",
  fetch(req) {
    const u = new URL(req.url)
    if (u.pathname === "/big") return new Response(big)
    return new Response(`up on ${port} viewer=${req.headers.get("x-crosstalk-viewer")}`)
  },
})
EOF

REPO="$TMP/code/app"
mkdir -p "$REPO"
git -C "$REPO" init -q -b main
echo hi >"$REPO/README.md"
git -C "$REPO" add . && git -C "$REPO" commit -qm init
WT="$REPO/.claude/worktrees/auth"
git -C "$REPO" worktree add -q -b crosstalk/auth "$WT"

(cd worker && exec "$WR" dev --local --ip 127.0.0.1 --port "$PORT" --persist-to "$TMP/wr" --show-interactive-dev-session=false \
  --var TEST_HOOKS:1 --var STREAM_DAY_FRAMES:30 >"$TMP/wrangler.log" 2>&1) &
WR_PID=$!
for _ in $(seq 1 120); do curl -sf -m 1 "http://127.0.0.1:$PORT/health" >/dev/null && break; sleep 0.5; done
has "$(curl -s -m 2 "http://127.0.0.1:$PORT/health")" '"worker":true' "the Worker runs locally under wrangler dev"

pairup() {
  CROSSTALK_HOME="$1" CROSSTALK_PROXY_PORT=0 bun src/cli.ts room new --label "$2" --relay "ws://127.0.0.1:$PORT" >"$5.new" 2>&1 &
  local INVITE=""
  for _ in $(seq 1 40); do
    INVITE=$(sed -n 's/^    \([0-9]\{3,6\}-[a-z][a-z-]*.*\)$/\1/p' "$5.new" | head -1)
    [ -n "$INVITE" ] && break
    sleep 0.5
  done
  [ -z "$INVITE" ] && { echo "no invite"; cat "$5.new"; exit 1; }
  CROSSTALK_HOME="$3" CROSSTALK_PROXY_PORT=0 bun src/cli.ts room join $INVITE --label "$4" --relay "ws://127.0.0.1:$PORT" >"$5.join" 2>&1
  for _ in $(seq 1 30); do grep -q "Now in a room with" "$5.new" && break; sleep 0.5; done
  grep -q "in a room with" "$5.join" || { echo "joining did not complete"; cat "$5.join"; exit 1; }
}
pairup "$A" ana "$B" ben "$TMP/ab"
stop_daemon "$A"; stop_daemon "$B"
start_daemon "$A" "$PA" "$TMP/da.log"
start_daemon "$B" "$PB" "$TMP/db.log"
for _ in $(seq 1 40); do [ -S "$A/daemon.sock" ] && [ -S "$B/daemon.sock" ] && break; sleep 0.25; done
has "$(waitfor 15 grep -o 'relay carries live stream frames (hosted)' "$TMP/da.log")" "live stream frames" "ana's daemon reads streams in the Worker's ready"
has "$(waitfor 15 grep -o 'relay carries live stream frames (hosted)' "$TMP/db.log")" "live stream frames" "and so does ben's"
FPA=$(field "$(cat "$B/peers.json")" 'r.ana.fingerprint')
FPB=$(field "$(cat "$A/peers.json")" 'r.ben.fingerprint')
keys() { curl -s -m 3 "http://127.0.0.1:$PORT/__test/keys?fp=$1"; }

echo
echo "live: ana shares her server with ben, over stream frames"
OUT=$(mcp "$A" sess-a crosstalk_serve "{\"command\":\"bun $TMP/srv.ts\",\"name\":\"web\"}" "$WT")
SP=$(echo "$OUT" | sed -n 's/.*PORT=\([0-9]*\).*/\1/p' | head -1)
has "$(waitfor 15 sh -c "curl -s --max-time 2 http://127.0.0.1:$SP/")" "up on $SP" "ana's server answers on :$SP"
waitfor 10 sh -c "grep -o '\"host\": \"auth\"' '$A/proxy.json'" >/dev/null
OUT=$(mcp "$A" sess-a crosstalk_share '{"name":"auth web","with":["ben"]}' "$WT")
has "$OUT" "with ben" "crosstalk_share shares it with ben"
NAME=$(field "$(cat "$A/shares.json")" 'r.out[0].name')
HOST="$NAME.ana.localhost"
has "$(waitfor 15 sh -c "grep -o '\"host\": \"$NAME.ana\"' '$B/proxy.json'")" "$NAME.ana" "ben's proxy routes $HOST"
PAGE=$(waitfor 15 via "$PB" "$HOST" /)
has "$PAGE" "up on $SP" "ben's curl gets ana's page through the Worker"
has "$PAGE" "viewer=ben" "as ben"
check "$(keys "$FPA")" '{"keys":[]}' "ana's mailbox stored nothing (stream frames are never written)"
check "$(keys "$FPB")" '{"keys":[]}' "nor ben's"

echo
echo "paused: a 2 MB answer is over ana's day on the shared relay"
via "$PB" "$HOST" /big 8 >/dev/null
has "$(waitfor 15 grep -o 'share: paused by the hosted relay' "$TMP/da.log")" "paused by the hosted relay" "the Worker refused ana's frames and her daemon paused sharing"
PAUSED_ANA=$(waitfor 15 sh -c "cat '$A'/*.json 2>/dev/null | grep -o 'sharing through the shared relay is paused until tomorrow[^\"]*' | head -1")
has "$PAUSED_ANA" "paused until tomorrow; run your own relay with \`--host\` or \`worker/\`" "ana is told, in plain words"
PAUSED_BEN=$(waitfor 20 sh -c "cat '$B'/*.json '$B'/*/*.json 2>/dev/null | grep -o \"ana's sharing through the shared relay is paused until tomorrow[^\\\"]*\" | head -1")
has "$PAUSED_BEN" "ana's sharing through the shared relay is paused until tomorrow" "ben gets a plain message from ana saying so"
check "$(grep -c 'share: paused by the hosted relay' "$TMP/da.log")" "1" "once"

echo
echo "stopped: nothing more streams, and nothing falls back to stored sends"
N1=$(grep -c 'relay error' "$TMP/da.log")
hasnt "$(via "$PB" "$HOST" / 4)" "up on" "ben's next request does not get through"
sleep 1
check "$(grep -c 'relay error' "$TMP/da.log")" "$N1" "ana's daemon sent nothing the Worker had to refuse"
KA=$(keys "$FPA"); KB=$(keys "$FPB")
check "$KA" '{"keys":["stream"]}' "ana's mailbox holds only the day's count, written once when it was spent"
check "$KB" '{"keys":[]}' "ben's holds no share frame"

echo
echo "messages: ordinary sends still go"
R=$(mcp "$B" sess-b crosstalk_send '{"to":"ana","text":"still talking after the pause","intent":"fyi"}' "$TMP")
has "$(waitfor 15 sh -c "cat '$A'/*.json '$A'/*/*.json 2>/dev/null | grep -o 'still talking after the pause' | head -1")" "still talking" "ben's message reaches ana"

echo
if [ "$FAILED" = 0 ]; then echo "all $PASSES passed"; else echo "FAILED ($PASSES passed)"; echo "--- ana"; tail -30 "$TMP/da.log"; echo "--- ben"; tail -30 "$TMP/db.log"; fi
exit $FAILED
