#!/usr/bin/env bash
# A peer's notice reaches the session exactly once, whichever way it can.
#
#   bash test/channels.sh
#
# Claude Code drops a channel notification silently unless the session was
# started with this server named in --channels or the development flag, and
# says nothing to the server either way. crosstalk used to subscribe for channel
# push regardless, the daemon counted the write as delivered, and a session
# without channels (and without the mod) never saw the message at all.
#
# ana's session "work" has a stand-in inbox socket that records what is written
# to it, and its MCP server is the real src/server.ts, started by
# test/channel-host.ts, which plays the Claude Code process: its command line
# is what the server reads to decide. ben sends.
#
#   channels off           -> the inbox notice, and no channel event
#   channels on            -> one channel event, and nothing in the inbox
#   flag given, but -p     -> the inbox notice (Claude Code ignores the flag)
#   an old server that subscribes without saying channels are on -> the inbox
#   channels on, mod live  -> the card only: neither inbox nor channel

export CROSSTALK_NO_GATHER=1
set -u
cd "$(dirname "$0")/.."
ROOT=$(pwd)
PORT=${PORT:-8896}
TMP=$(mktemp -d)
A="$TMP/a"; B="$TMP/b"; R="$TMP/repos"
FAILED=0
PASSES=0
export CROSSTALK_MOD_FRESH_MS=4000
# Whatever this machine's managed settings say is not what is under test.
export CROSSTALK_MANAGED_SETTINGS="$TMP/no-managed-settings.json"
unset CLAUDE_PLUGIN_ROOT CROSSTALK_CHANNELS

pass() { echo "  PASS  $1"; PASSES=$((PASSES+1)); }
fail() { echo "  FAIL  $1"; FAILED=1; }
check() { if [ "$1" = "$2" ]; then pass "$3"; else fail "$3 (wanted '$2', got '$1')"; fi; }
has() { case "$1" in *"$2"*) pass "$3" ;; *) fail "$3"; echo "        got: $1" | head -c 600; echo ;; esac; }
hasnt() { case "$1" in *"$2"*) fail "$3"; echo "        got: $1" | head -c 600; echo ;; *) pass "$3" ;; esac; }
stop_daemon() {
  if [ -f "$1/daemon.lock" ]; then
    P=$(cat "$1/daemon.lock")
    kill "$P" 2>/dev/null
    for _ in $(seq 1 30); do kill -0 "$P" 2>/dev/null || break; sleep 0.2; done
  fi
  rm -f "$1/daemon.sock" "$1/daemon.lock"
}
start_daemon() {
  CROSSTALK_HOME="$1" nohup bun src/daemon.ts >>"$2" 2>&1 &
  for _ in $(seq 1 40); do [ -S "$1/daemon.sock" ] && break; sleep 0.25; done
}
rpc() { CROSSTALK_HOME="$1" bun -e '
  const { request } = await import("./src/client.ts")
  console.log(JSON.stringify(await request(JSON.parse(process.argv[1]))))
' "$2" 2>&1; }
RELAY_PID=""; INBOX_PID=""; HOST_PID=""; OLD_PID=""
stop_host() {
  [ -n "$HOST_PID" ] && { kill "$HOST_PID" 2>/dev/null; wait "$HOST_PID" 2>/dev/null; }
  HOST_PID=""
}
cleanup() {
  stop_host
  [ -n "$OLD_PID" ] && kill "$OLD_PID" 2>/dev/null
  stop_daemon "$A"; stop_daemon "$B"
  [ -n "$RELAY_PID" ] && kill "$RELAY_PID" 2>/dev/null
  [ -n "$INBOX_PID" ] && kill "$INBOX_PID" 2>/dev/null
  rm -rf "$TMP"
}
trap cleanup EXIT

mkdir -p "$TMP/relay" "$A" "$B" "$R"
echo "state in $TMP"

repo() { mkdir -p "$1" && git -C "$1" init -q -b main && git -C "$1" remote add origin "$2" && git -C "$1" -c user.email=t@t -c user.name=t commit -q --allow-empty -m init; }
repo "$R/ana-api" "git@github.com:acme/api.git"
repo "$R/ben-api" "https://github.com/acme/api"

(cd "$TMP/relay" && exec bun "$ROOT/relay/relay.ts" --host 127.0.0.1 --port "$PORT" >"$TMP/relay.log" 2>&1) &
RELAY_PID=$!
for _ in $(seq 1 30); do curl -sf -m 1 "http://127.0.0.1:$PORT/health" >/dev/null && break; sleep 0.3; done
CROSSTALK_HOME="$A" bun src/cli.ts room new --label ana --relay "ws://127.0.0.1:$PORT" >"$TMP/pa.log" 2>&1 &
for _ in $(seq 1 40); do
  INVITE=$(sed -n 's/^    \([0-9]\{3,6\}-[a-z][a-z-]*.*\)$/\1/p' "$TMP/pa.log" | head -1)
  [ -n "$INVITE" ] && break
  sleep 0.5
done
[ -z "$INVITE" ] && { echo "no invite"; cat "$TMP/pa.log"; exit 1; }
CROSSTALK_HOME="$B" bun src/cli.ts room join $INVITE --label ben --relay "ws://127.0.0.1:$PORT" >"$TMP/pb.log" 2>&1
for _ in $(seq 1 30); do grep -q "Now in a room with" "$TMP/pa.log" && break; sleep 0.5; done
stop_daemon "$A"; stop_daemon "$B"
start_daemon "$A" "$TMP/da.log"; start_daemon "$B" "$TMP/db.log"
sleep 2

SOCK="$TMP/inbox.sock"; INBOX="$TMP/inbox.txt"; : >"$INBOX"
bun -e '
  const fs = require("fs"), net = require("net")
  net.createServer((c) => c.on("data", (d) => fs.appendFileSync(process.argv[2], d))).listen(process.argv[1])
' "$SOCK" "$INBOX" &
INBOX_PID=$!
for _ in $(seq 1 20); do [ -S "$SOCK" ] && break; sleep 0.2; done
rpc "$A" "{\"op\":\"register\",\"sessionId\":\"work\",\"pid\":1,\"name\":\"work\",\"cwd\":\"$R/ana-api\",\"socket\":\"$SOCK\"}" >/dev/null
rpc "$B" "{\"op\":\"register\",\"sessionId\":\"ben-api\",\"pid\":1,\"name\":\"ben-api\",\"cwd\":\"$R/ben-api\",\"socket\":\"\"}" >/dev/null

send() { rpc "$B" "{\"op\":\"send\",\"sessionId\":\"ben-api\",\"cwd\":\"$R/ben-api\",\"to\":\"ana\",\"text\":\"$1\",\"intent\":\"question\"}" >/dev/null; }
readall() { rpc "$A" '{"op":"read","sessionId":"work"}' >/dev/null; }
OUT="$TMP/host"
# Start the stand-in Claude Code with these flags, and wait until its server
# has decided (and, when on, the daemon has its subscription).
host() {
  stop_host
  rm -rf "$OUT"
  bun test/channel-host.ts "$A" work "$OUT" "$@" &
  HOST_PID=$!
  for _ in $(seq 1 60); do grep -q "channel push" "$OUT/server.log" 2>/dev/null && break; sleep 0.25; done
  sleep 0.5
}
events() { grep -c 'waiting from ben' "$OUT/channel.txt" 2>/dev/null || true; }
notices() { grep -o 'Read it with crosstalk_read' "$INBOX" | wc -l | tr -d ' '; }

echo
echo "channels off: the inbox notice"
host --debug
has "$(cat "$OUT/server.log")" "channel push off" "the server decides channels are off"
: >"$INBOX"
send "no channels WREN-1101"
sleep 3
check "$(notices)" "1" "the inbox gets one notice"
hasnt "$(cat "$INBOX")" 'WREN-1101' "with none of ben's words"
check "$(events)" "0" "and no channel event, which Claude Code would have dropped"
readall

echo
echo "channels on: one channel event, nothing in the inbox"
host --dangerously-load-development-channels server:crosstalk
has "$(cat "$OUT/server.log")" "channel push on" "the server decides channels are on"
: >"$INBOX"
send "with channels HERON-2202"
sleep 3
check "$(events)" "1" "one channel event"
hasnt "$(cat "$OUT/channel.txt")" 'HERON-2202' "with none of ben's words"
check "$(wc -c <"$INBOX" | tr -d ' ')" "0" "and nothing injected into the inbox"
readall

echo
echo "the development flag in a -p run: ignored by Claude Code, so the inbox"
host --dangerously-load-development-channels server:crosstalk -p hello
has "$(cat "$OUT/server.log")" "channel push off" "the server decides channels are off"
: >"$INBOX"
send "print mode IBIS-3303"
sleep 3
check "$(notices)" "1" "the inbox gets the notice"
check "$(events)" "0" "and no channel event"
readall
stop_host

echo
echo "a server from before the check, subscribing regardless: not believed"
bun -e '
  const net = require("net")
  const s = net.createConnection(process.argv[1], () => s.write(JSON.stringify({ op: "subscribe", sessionId: "work" }) + "\n"))
  s.on("data", (d) => process.stdout.write(d))
  setInterval(() => {}, 1e6)
' "$A/daemon.sock" >"$TMP/old.txt" &
OLD_PID=$!
sleep 1
: >"$INBOX"
send "old server KITE-4404"
sleep 3
check "$(notices)" "1" "the inbox gets the notice"
hasnt "$(cat "$TMP/old.txt")" 'arrival' "and nothing is pushed to the old subscriber"
kill "$OLD_PID" 2>/dev/null; OLD_PID=""
readall

echo
echo "channels on and the mod live: the card only"
host --dangerously-load-development-channels server:crosstalk
rpc "$A" '{"op":"ui","sessionId":"work","mod":true}' >/dev/null
: >"$INBOX"
send "with the mod EGRET-5505"
sleep 3
check "$(events)" "0" "no channel event"
check "$(wc -c <"$INBOX" | tr -d ' ')" "0" "nothing in the inbox"
has "$(CROSSTALK_HOME="$A" bin/crosstalk ui list --session work)" 'EGRET-5505' "the mod has it as a card"
stop_host

echo
[ $FAILED -eq 0 ] && echo "channels: all $PASSES passed" || { echo "channels: failures"; tail -30 "$TMP/da.log"; }
exit $FAILED
