#!/usr/bin/env bash
# Two people behind separate NATs, meeting at a relay neither of them runs.
#
# This is the case the whole transport design turns on, and it is the one a
# single machine cannot produce: two peers who can dial out and cannot be
# dialled. Docker gives it directly. Each peer sits on its own bridge network,
# which is a NAT with no port forwarding, and the two bridges cannot route to
# each other. The relay sits on a third network that both can reach outbound.
#
#   peer-a ──▶ ┐                          ┌ ◀── peer-b
#   (net-a)    ├──▶ relay (net-relay) ◀───┤    (net-b)
#              ┘                          ┘
#   no inbound                              no inbound
#
# A pass means neither side ever accepted a connection and they talked anyway.
set -euo pipefail

cd "$(dirname "$0")/../.."
IMAGE=crosstalk-nat
PORT=8787
PASS=0; FAIL=0
ok()  { echo "  PASS  $1"; PASS=$((PASS+1)); }
bad() { echo "  FAIL  $1"; FAIL=$((FAIL+1)); }

cleanup() {
  docker rm -f ct-relay ct-a ct-b >/dev/null 2>&1 || true
  docker network rm ct-net-a ct-net-b ct-net-relay >/dev/null 2>&1 || true
}
trap cleanup EXIT
cleanup

echo "==> building"
bun scripts/build.ts >/dev/null
docker build -q -t "$IMAGE" -f test/docker/Dockerfile . >/dev/null

echo "==> three networks: one per peer, one for the relay"
docker network create ct-net-a >/dev/null
docker network create ct-net-b >/dev/null
docker network create ct-net-relay >/dev/null

# The relay is the only host on more than one network. Neither peer network can
# reach the other, which is what makes this a NAT test rather than a LAN test.
docker run -d --name ct-relay --network ct-net-relay "$IMAGE" \
  ./bin/crosstalk relay-server --host 0.0.0.0 --port "$PORT" >/dev/null
docker network connect ct-net-a ct-relay
docker network connect ct-net-b ct-relay

docker run -d --name ct-a --network ct-net-a "$IMAGE" sleep 900 >/dev/null
docker run -d --name ct-b --network ct-net-b "$IMAGE" sleep 900 >/dev/null

for _ in $(seq 1 30); do
  docker exec ct-a curl -sf -m 1 "http://ct-relay:$PORT/health" >/dev/null 2>&1 && break
  sleep 1
done
docker exec ct-a curl -sf -m 2 "http://ct-relay:$PORT/health" >/dev/null \
  && ok "peer a reaches the relay outbound" || { bad "peer a reaches the relay outbound"; docker logs ct-relay; exit 1; }
docker exec ct-b curl -sf -m 2 "http://ct-relay:$PORT/health" >/dev/null \
  && ok "peer b reaches the relay outbound" || { bad "peer b reaches the relay outbound"; exit 1; }

# The property under test: the two peer networks are isolated from each other,
# so nothing either peer does can be a direct connection.
if docker exec ct-a curl -sf -m 2 "http://ct-b:$PORT/health" >/dev/null 2>&1; then
  bad "the two peers cannot reach each other directly"
else
  ok "the two peers cannot reach each other directly"
fi

RELAY="ws://ct-relay:$PORT"

echo "==> a starts a room"
docker exec -d ct-a sh -c "./bin/crosstalk cli room new --label ana --relay $RELAY >/data/room.log 2>&1"
for _ in $(seq 1 60); do
  # The invite carries " at <host>:<port>" whenever the relay is not the default
  # one, and `room join` takes the whole line.
  INVITE=$(docker exec ct-a sh -c "sed -n 's/^    \([0-9]\{3,6\}-[a-z].*\)\$/\1/p' /data/room.log 2>/dev/null | head -1" | tr -d '\r')
  [ -n "$INVITE" ] && break
  sleep 0.5
done
[ -n "$INVITE" ] && ok "an invite was printed ($INVITE)" || { bad "an invite was printed"; docker exec ct-a cat /data/room.log; exit 1; }

echo "==> b joins it from the other side of the relay"
JOIN=$(docker exec ct-b ./bin/crosstalk cli room join "$INVITE" --label ben --relay "$RELAY" 2>&1)
case "$JOIN" in
  *'Now in a room with "ana"'*) ok "b is in a room with a" ;;
  *) bad "b is in a room with a"; echo "$JOIN" ;;
esac
for _ in $(seq 1 40); do docker exec ct-a grep -q "Now in a room with" /data/room.log 2>/dev/null && break; sleep 0.5; done
docker exec ct-a grep -q 'Now in a room with "ben"' /data/room.log 2>/dev/null \
  && ok "a is in a room with b" || { bad "a is in a room with b"; docker exec ct-a cat /data/room.log; }

echo "==> daemons link, and a message crosses"
docker exec -d ct-a ./bin/crosstalk daemon
docker exec -d ct-b ./bin/crosstalk daemon
for _ in $(seq 1 30); do
  docker exec ct-a grep -q 'relay ready' /data/daemon.log 2>/dev/null &&
  docker exec ct-b grep -q 'relay ready' /data/daemon.log 2>/dev/null && break
  sleep 1
done
docker exec ct-a grep -q 'relay ready' /data/daemon.log 2>/dev/null \
  && ok "a's daemon linked" || bad "a's daemon linked"
docker exec ct-b grep -q 'relay ready' /data/daemon.log 2>/dev/null \
  && ok "b's daemon linked" || bad "b's daemon linked"

# There is no `send` verb; a session sends through the daemon's control socket,
# which is the same path the MCP tool takes.
rpc() { docker exec "$1" bun -e '
  const { request } = await import("/app/src/client.ts")
  console.log(JSON.stringify(await request(JSON.parse(process.argv[1]))))
' "$2" 2>&1; }

# A message is filed against the session it arrives for, so both sides need one
# registered or it parks waiting for a session that never appears.
rpc ct-a '{"op":"register","sessionId":"sa","pid":1,"name":"ana-web","cwd":"/tmp/web","socket":""}' >/dev/null
rpc ct-b '{"op":"register","sessionId":"sb","pid":2,"name":"ben-api","cwd":"/tmp/api","socket":""}' >/dev/null
sleep 2

SENT=$(rpc ct-b '{"op":"send","sessionId":"sb","to":"ana","text":"across two NATs","intent":"fyi"}')
case "$SENT" in
  *'"ok":true'*) ok "b sent a message" ;;
  *) bad "b sent a message"; echo "    $SENT" ;;
esac
sleep 4
READ=$(rpc ct-a '{"op":"read","sessionId":"sa","all":true}')
case "$READ" in
  *"across two NATs"*) ok "a received it, over two NATs and a relay" ;;
  *) bad "a received it, over two NATs and a relay"
     echo "    $READ"
     echo "--- a ---"; docker exec ct-a tail -8 /data/daemon.log
     echo "--- b ---"; docker exec ct-b tail -8 /data/daemon.log ;;
esac

# Neither peer should ever have opened a listening TCP port. If one did, the
# design has quietly grown a requirement that a real NAT would break.
# Loopback does not count: Docker runs its embedded DNS resolver on 127.0.0.11,
# and nothing outside the container can reach 127.x anyway. What would matter is
# a listener on a routable address, which a real NAT would never deliver to.
for c in ct-a ct-b; do
  PORTS=$(docker exec "$c" sh -c "netstat -ltn 2>/dev/null | grep LISTEN | grep -v ' 127\.'" | tr -d '\r' || true)
  if [ -z "$PORTS" ]; then
    ok "$c never listened on a routable TCP port"
  else
    bad "$c opened a routable listening port"
    echo "$PORTS" | sed 's/^/        /'
  fi
done

echo
echo "─────────────────────────────"
echo "  $PASS passed, $FAIL failed"
[ "$FAIL" -eq 0 ] && echo "  two NATs, one rendezvous, nothing inbound" || exit 1
