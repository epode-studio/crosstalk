#!/usr/bin/env bash
# Runs the second person inside a container, on its own network stack, and
# checks a message crosses in both directions.
set -euo pipefail

cd "$(dirname "$0")/../.."
ROOT=$(pwd)
PORT=${PORT:-8791}
HOST_STATE=$(mktemp -d)
RELAY_STATE=$(mktemp -d)
IMAGE=crosstalk-test

cleanup() {
  docker rm -f crosstalk-peer >/dev/null 2>&1 || true
  [ -n "${RELAY_PID:-}" ] && kill "$RELAY_PID" 2>/dev/null || true
  rm -rf "$HOST_STATE" "$RELAY_STATE"
}
trap cleanup EXIT

ADDRESS=${ADDRESS:-$(ipconfig getifaddr en0 2>/dev/null || hostname -I | awk '{print $1}')}
[ -z "$ADDRESS" ] && { echo "could not work out this machine's address; set ADDRESS=..."; exit 1; }
echo "host address:  $ADDRESS:$PORT"

echo "==> building the image"
docker build -q -t "$IMAGE" -f test/docker/Dockerfile . >/dev/null

echo "==> starting a relay on this machine, all interfaces"
( cd "$RELAY_STATE" && bun "$ROOT/relay/relay.ts" --host 0.0.0.0 --port "$PORT" >"$RELAY_STATE/relay.log" 2>&1 ) &
RELAY_PID=$!
for i in $(seq 1 30); do curl -sf -m 1 "http://127.0.0.1:$PORT/health" >/dev/null && break; sleep 0.3; done
curl -sf -m 2 "http://127.0.0.1:$PORT/health" >/dev/null || { echo "relay did not start"; cat "$RELAY_STATE/relay.log"; exit 1; }

echo "==> can the container reach it?"
docker run --rm "$IMAGE" sh -c "wget -qO- -T 3 http://$ADDRESS:$PORT/health" \
  || { echo "FAIL: the container cannot reach the relay on $ADDRESS:$PORT"; exit 1; }
echo

echo "==> host side starts pairing"
CROSSTALK_HOME="$HOST_STATE" bun src/cli.ts pair --label host --relay "ws://$ADDRESS:$PORT" >"$HOST_STATE/pair.log" 2>&1 &
for i in $(seq 1 40); do
  INVITE=$(grep -A2 'Tell them these words' "$HOST_STATE/pair.log" 2>/dev/null | tail -1 | sed 's/^ *//;s/ *$//')
  [ -n "$INVITE" ] && break
  sleep 0.5
done
[ -z "$INVITE" ] && { echo "FAIL: no invite printed"; cat "$HOST_STATE/pair.log"; exit 1; }
echo "invite: $INVITE"

echo "==> container accepts it"
docker run -d --name crosstalk-peer "$IMAGE" sleep 600 >/dev/null
docker exec crosstalk-peer ./bin/crosstalk cli pair $INVITE --label peer --relay "ws://$ADDRESS:$PORT" \
  | grep -E 'Paired|them |you ' || { echo "FAIL: pairing did not complete"; exit 1; }
for i in $(seq 1 20); do grep -q Paired "$HOST_STATE/pair.log" && break; sleep 0.5; done
grep -q Paired "$HOST_STATE/pair.log" || { echo "FAIL: host never saw the reply"; exit 1; }

echo "==> both daemons up"
CROSSTALK_HOME="$HOST_STATE" bun src/daemon.ts >"$HOST_STATE/daemon.log" 2>&1 &
docker exec -d crosstalk-peer ./bin/crosstalk daemon
sleep 4
grep -q 'relay ready' "$HOST_STATE/daemon.log" || { echo "FAIL: host daemon never linked"; tail -5 "$HOST_STATE/daemon.log"; exit 1; }
docker exec crosstalk-peer sh -c 'grep -q "relay ready" /data/daemon.log' \
  || { echo "FAIL: container daemon never linked"; docker exec crosstalk-peer tail -5 /data/daemon.log; exit 1; }
echo "both linked over the encrypted channel"

echo "==> container sends to host"
docker exec crosstalk-peer sh -c 'printf %s "{\"op\":\"send\",\"sessionId\":\"x\",\"to\":\"host\",\"text\":\"Crossed two network stacks.\",\"intent\":\"question\"}" | nc -U /data/daemon.sock -w 2' >/dev/null 2>&1 \
  || docker exec crosstalk-peer ./bin/crosstalk cli status >/dev/null
sleep 2
if grep -q 'inbound' "$HOST_STATE/daemon.log"; then
  echo "PASS: $(grep inbound "$HOST_STATE/daemon.log" | tail -1)"
else
  echo "no inbound line yet; host daemon log:"
  tail -5 "$HOST_STATE/daemon.log"
  exit 1
fi

echo
echo "Two separate network stacks, encrypted link, pairing and delivery all fine."
echo "This says nothing about firewalls, sleeping laptops or NAT. For those, see"
echo "test/two-machines.md."
