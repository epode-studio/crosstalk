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
echo "putting two identities in a room"
CROSSTALK_HOME="$TMP/a" bun src/cli.ts room new --label aa --relay "ws://127.0.0.1:$PORT" >"$TMP/pa.log" 2>&1 &
for _ in $(seq 1 40); do
  # The invite is a public slot, then the secret words, then an optional address.
  INVITE=$(sed -n 's/^    \([0-9]\{3,6\}-[a-z][a-z-]*.*\)$/\1/p' "$TMP/pa.log" | head -1)
  [ -n "$INVITE" ] && break
  sleep 0.5
done
[ -z "$INVITE" ] && { echo "no invite"; cat "$TMP/pa.log"; exit 1; }
CROSSTALK_HOME="$TMP/b" bun src/cli.ts room join $INVITE --label bb --relay "ws://127.0.0.1:$PORT" >"$TMP/pb.log" 2>&1
for _ in $(seq 1 30); do grep -q "Now in a room with" "$TMP/pa.log" && break; sleep 0.5; done
if grep -q "in a room with" "$TMP/pa.log" && grep -q "in a room with" "$TMP/pb.log"; then pass "in a room"; else fail "joining did not complete"; exit 1; fi

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

# --- 2b. a fact written while a peer was away --------------------------------
#
# The relay buffers for a day and then drops. Past that the only thing that
# reconciles is the sync request on reconnect, and it lived on one relay path
# and not the other, so on the hosted worker a machine that was off never
# caught up. Take b right down, write a fact on a, bring b back.
echo
echo "2b. a fact written while a peer was away"
stop_daemon "$TMP/b"; sleep 2
CROSSTALK_HOME="$TMP/a" bun src/cli.ts facts add "the pg driver needs the 3.x branch" >/dev/null 2>&1
sleep 2
# Empty b's buffer at the relay, so nothing can arrive by replay and the only
# route left is the resync.
rm -f "$TMP/relay/crosstalk-rooms-buffer.json"
RP=$(relay_pid); kill "$RP" 2>/dev/null; sleep 1.5
start_relay
CROSSTALK_HOME="$TMP/b" nohup bun src/daemon.ts >"$TMP/db2.log" 2>&1 &
for _ in $(seq 1 20); do
  CROSSTALK_HOME="$TMP/b" bun src/cli.ts facts 2>/dev/null | grep -q '3.x branch' && break
  sleep 1
done
if CROSSTALK_HOME="$TMP/b" bun src/cli.ts facts 2>/dev/null | grep -q '3.x branch'; then
  pass "b caught up on reconnect"
else
  fail "b never caught up"
  CROSSTALK_HOME="$TMP/b" bun src/cli.ts facts 2>&1 | head -5
fi

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

# --- 4. two daemons on one state directory -------------------------------------
#
# Two daemons sharing a state directory each hold the message queue in memory
# and each write the whole of it back, so whichever writes last erases the
# other's work. A message then goes to nobody. The check is whether the socket
# answers, so a second daemon has to stand down and a socket left behind by a
# daemon that was killed outright has to be cleared.
echo
echo "4. a second daemon on the same state directory"
D="$TMP/solo"
mkdir -p "$D"
cp "$TMP/a/identity.json" "$D/" 2>/dev/null || cp "$TMP"/a/*.json "$D/" 2>/dev/null
CROSSTALK_HOME="$D" nohup bun src/daemon.ts >"$D/first.log" 2>&1 &
disown 2>/dev/null || true   # this one gets kill -9'd below; keep the shell quiet about it
for _ in $(seq 1 20); do [ -S "$D/daemon.sock" ] && break; sleep 0.5; done
[ -S "$D/daemon.sock" ] && pass "first daemon is listening" || fail "first daemon never came up"

CROSSTALK_HOME="$D" bun src/daemon.ts >"$D/second.log" 2>&1
grep -q 'already running' "$D/second.log" \
  && pass "second daemon stood down" \
  || fail "second daemon came up alongside the first"
[ -S "$D/daemon.sock" ] && pass "the live socket survived it" || fail "the live socket was removed"

# kill -9 skips the cleanup, so the socket file outlives the process.
FIRST=$(cat "$D/daemon.lock" 2>/dev/null)
[ -n "$FIRST" ] && kill -9 "$FIRST" 2>/dev/null
sleep 1
CROSSTALK_HOME="$D" nohup bun src/daemon.ts >"$D/third.log" 2>&1 &
for _ in $(seq 1 20); do grep -q 'daemon up' "$D/third.log" && break; sleep 0.5; done
grep -q 'daemon up' "$D/third.log" \
  && pass "a stale socket does not block the next one" \
  || fail "stale socket blocked startup"
[ -f "$D/daemon.lock" ] && kill "$(cat "$D/daemon.lock")" 2>/dev/null

echo
[ "$FAILED" = "0" ] && echo "all good" || echo "something above failed"
exit $FAILED
