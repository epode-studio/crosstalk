#!/usr/bin/env bash
# What happens when the machine hosting the relay goes to sleep.
#
#   bash test/resilience.sh
#
# Three things used to go wrong, and this checks all three still do not:
#
#   1. A send while the relay is unreachable was lost. It should be held and go
#      out when the link returns.
#   2. The relay's queue for offline peers lived only in memory, so restarting
#      it threw the queue away.
#   3. A sleeping machine leaves the far end holding a socket that still reports
#      as open while nothing crosses it, swallowing everything sent into it.
#
# Two things make this test honest, both of which caught me out while writing
# it. Resolve the relay's pid from the listening socket rather than from $!,
# which in a backgrounded compound is the subshell and not the relay. And never
# check a result with `grep | tail`, whose exit code is tail's and always zero.

set -u
cd "$(dirname "$0")/.."
ROOT=$(pwd)
PORT=${PORT:-8899}
TMP=$(mktemp -d)
FAILED=0

pass() { echo "  PASS  $1"; }
fail() { echo "  FAIL  $1"; FAILED=1; }
stop_daemon() { [ -f "$1/daemon.lock" ] && kill "$(cat "$1/daemon.lock")" 2>/dev/null; rm -f "$1/daemon.sock" "$1/daemon.lock"; }
relay_pid() { lsof -nP -iTCP:$PORT -sTCP:LISTEN -t 2>/dev/null | head -1; }

start_relay() {
  (cd "$TMP/relay" && nohup bun "$ROOT/relay/relay.ts" --host 127.0.0.1 --port "$PORT" >>"$TMP/relay.log" 2>&1 &)
  for _ in $(seq 1 30); do
    curl -sf -m 1 "http://127.0.0.1:$PORT/health" >/dev/null && return 0
    sleep 0.3
  done
  echo "relay would not start"; exit 1
}

cleanup() {
  stop_daemon "$TMP/a"; stop_daemon "$TMP/b"
  local p; p=$(relay_pid); [ -n "$p" ] && { kill -CONT "$p" 2>/dev/null; kill "$p" 2>/dev/null; }
  rm -rf "$TMP"
}
trap cleanup EXIT

mkdir -p "$TMP/relay" "$TMP/a" "$TMP/b"
echo "state in $TMP"
start_relay

echo
echo "pairing two identities"
CROSSTALK_HOME="$TMP/a" bun src/cli.ts pair --label aa --relay "ws://127.0.0.1:$PORT" >"$TMP/pa.log" 2>&1 &
for _ in $(seq 1 40); do
  INVITE=$(grep -A2 'Tell them these words' "$TMP/pa.log" 2>/dev/null | tail -1 | sed 's/^ *//;s/ *$//')
  [ -n "$INVITE" ] && break
  sleep 0.5
done
[ -z "$INVITE" ] && { echo "no invite"; cat "$TMP/pa.log"; exit 1; }
CROSSTALK_HOME="$TMP/b" bun src/cli.ts pair $INVITE --label bb --relay "ws://127.0.0.1:$PORT" >"$TMP/pb.log" 2>&1
for _ in $(seq 1 30); do grep -q Paired "$TMP/pa.log" && break; sleep 0.5; done
if grep -q Paired "$TMP/pa.log" && grep -q Paired "$TMP/pb.log"; then pass "paired"; else fail "pairing did not complete"; exit 1; fi

# --- 1. a send while the relay is down is held, not lost ---------------------
echo
echo "1. relay unreachable while sending"
RP=$(relay_pid); kill "$RP" 2>/dev/null; sleep 1.5
stop_daemon "$TMP/a"
CROSSTALK_HOME="$TMP/a" nohup bun src/daemon.ts >"$TMP/da.log" 2>&1 &
sleep 2.5
for n in 1 2 3; do
  CROSSTALK_HOME="$TMP/a" bun -e '
    const { request } = await import("./src/client.ts")
    await request(JSON.parse(process.argv[1]))
  ' "{\"op\":\"send\",\"sessionId\":\"s\",\"to\":\"bb\",\"text\":\"held $n\",\"intent\":\"fyi\"}" >/dev/null 2>&1
done
HELD=$(bun -e 'try{console.log(JSON.parse(require("fs").readFileSync(process.argv[1],"utf8")).length)}catch{console.log(0)}' "$TMP/a/outbox.json")
[ "$HELD" = "3" ] && pass "3 messages held on disk" || fail "expected 3 held, got $HELD"

start_relay
sleep 5
LEFT=$(bun -e 'try{console.log(JSON.parse(require("fs").readFileSync(process.argv[1],"utf8")).length)}catch{console.log(0)}' "$TMP/a/outbox.json")
if [ "$LEFT" = "0" ] && grep -q 'flushed' "$TMP/da.log"; then pass "flushed on reconnect"; else fail "outbox still holds $LEFT"; fi

# --- 2. the relay's queue survives a restart ---------------------------------
echo
echo "2. relay restarts while a peer is offline"
stop_daemon "$TMP/b"; sleep 2
CROSSTALK_HOME="$TMP/a" bun -e '
  const { request } = await import("./src/client.ts")
  await request({op:"send",sessionId:"s",to:"bb",text:"survives a relay restart",intent:"fyi"})
' >/dev/null 2>&1
sleep 6
SIZE=$(wc -c < "$TMP/relay/crosstalk-rooms-buffer.json" 2>/dev/null || echo 0)
[ "$SIZE" -gt 10 ] && pass "buffer written to disk ($SIZE bytes)" || fail "buffer not persisted ($SIZE bytes)"

RP=$(relay_pid); kill "$RP" 2>/dev/null; sleep 1.5
start_relay
CROSSTALK_HOME="$TMP/b" nohup bun src/daemon.ts >"$TMP/db.log" 2>&1 &
sleep 4
if grep -q drained "$TMP/relay.log"; then pass "drained to the peer after the restart"; else fail "nothing drained"; fi

# --- 3. a link that still looks open but is dead -----------------------------
echo
echo "3. relay frozen, socket still open"
stop_daemon "$TMP/a"
CROSSTALK_HOME="$TMP/a" CROSSTALK_PING_MS=5000 CROSSTALK_SILENCE_MS=15000 \
  nohup bun src/daemon.ts >"$TMP/dfrozen.log" 2>&1 &
sleep 6
RP=$(relay_pid)
kill -STOP "$RP"; sleep 1
STATE=$(ps -o state= -p "$RP" | tr -d ' ')
case "$STATE" in T*) pass "relay is stopped (state $STATE)";; *) fail "relay not stopped, state is $STATE"; kill -CONT "$RP";; esac
for _ in $(seq 1 15); do
  grep -q 'no answer from the relay' "$TMP/dfrozen.log" && break
  sleep 2
done
if grep -q 'no answer from the relay' "$TMP/dfrozen.log"; then
  pass "dead link detected: $(grep 'no answer' "$TMP/dfrozen.log" | tail -1 | sed 's/.*Z //')"
else
  fail "dead link never detected in 30s"
fi
kill -CONT "$RP" 2>/dev/null
sleep 8
COUNT=$(grep -c 'relay ready' "$TMP/dfrozen.log")
[ "$COUNT" -ge 2 ] && pass "reconnected after the relay came back" || fail "did not reconnect (ready seen $COUNT times)"

echo
[ "$FAILED" = "0" ] && echo "all good" || echo "something above failed"
exit $FAILED
