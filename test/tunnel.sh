#!/usr/bin/env bash
# The --public path: a relay on this machine, reachable from anywhere.
#
# `room new --public` puts a Cloudflare quick tunnel in front of a local relay
# and hands out a wss://<random>.trycloudflare.com address in the invite. That
# is the answer for two people who are not on the same network and do not want
# to deploy anything, and until now nothing exercised it.
#
# The tunnel is anonymous, ephemeral and torn down at the end. What crosses it
# is rendezvous traffic: sealed offers and ciphertext, never a phrase or a key.
#
# Needs cloudflared and a working internet connection. Skips without either.
set -uo pipefail

cd "$(dirname "$0")/.."
PASS=0; FAIL=0
ok()  { echo "  PASS  $1"; PASS=$((PASS+1)); }
bad() { echo "  FAIL  $1"; FAIL=$((FAIL+1)); }

command -v cloudflared >/dev/null 2>&1 || { echo "cloudflared not installed; skipping"; exit 0; }
curl -sf -m 5 https://api.cloudflare.com/client/v4/ips >/dev/null 2>&1 \
  || { echo "no route to Cloudflare; skipping"; exit 0; }

A=$(mktemp -d)/a
B=$(mktemp -d)/b
mkdir -p "$A" "$B"

cleanup() {
  for h in "$A" "$B"; do
    [ -f "$h/tunnel.pid" ] && kill "$(cat "$h/tunnel.pid")" 2>/dev/null
    [ -f "$h/relay.pid" ]  && kill "$(cat "$h/relay.pid")"  2>/dev/null
    [ -f "$h/daemon.lock" ] && kill "$(cat "$h/daemon.lock")" 2>/dev/null
  done
  pkill -f "src/cli.ts room new" 2>/dev/null
  rm -rf "$A" "$B"
}
trap cleanup EXIT

a() { CROSSTALK_HOME="$A" bun src/cli.ts "$@" 2>&1; }
b() { CROSSTALK_HOME="$B" bun src/cli.ts "$@" 2>&1; }
rpc() { CROSSTALK_HOME="$1" bun -e '
  const { request } = await import("./src/client.ts")
  console.log(JSON.stringify(await request(JSON.parse(process.argv[1]))))
' "$2" 2>&1; }

# --- --host, which is what --public falls back to -----------------------------
#
# This is the advice the tunnel's own failure message gives, so it has to work
# whether or not Cloudflare is handing out quick tunnels today. It runs first
# for that reason: the rest of this file skips when they are throttled.
echo "the --host relay"

C=$(mktemp -d)/c
D=$(mktemp -d)/d
mkdir -p "$C" "$D"
CROSSTALK_HOME="$C" bun src/cli.ts room new --host --label cara >"$C/room.log" 2>&1 &
until [ -n "$(sed -n 's/^    \([0-9]\{3,6\}-[a-z].*\)$/\1/p' "$C/room.log" 2>/dev/null | head -1)" ]; do sleep 1; done
HINV=$(sed -n 's/^    \([0-9]\{3,6\}-[a-z].*\)$/\1/p' "$C/room.log" | head -1)
case "$HINV" in
  *" at "*) ok "the invite carries the LAN address ($HINV)" ;;
  *) bad "the invite carries the LAN address ($HINV)" ;;
esac
HJOIN=$(CROSSTALK_HOME="$D" bun src/cli.ts room join $HINV --label dev 2>&1)
case "$HJOIN" in
  *'Now in a room with "cara"'*) ok "and somebody joins over it" ;;
  *) bad "and somebody joins over it"; echo "$HJOIN" | head -3 ;;
esac
for h in "$C" "$D"; do
  [ -f "$h/relay.pid" ] && kill "$(cat "$h/relay.pid")" 2>/dev/null
  [ -f "$h/daemon.lock" ] && kill "$(cat "$h/daemon.lock")" 2>/dev/null
done
pkill -f "cli.ts room new --host" 2>/dev/null
rm -rf "$C" "$D"
sleep 1

echo
echo "the --public tunnel"

# `room new --public` starts the relay, opens the tunnel, and waits for a joiner,
# so it has to run in the background and be read from its log. It prints
# "relay reachable at" only once it has proved the tunnel carries traffic.
CROSSTALK_HOME="$A" bun src/cli.ts room new --public --label ana >"$A/room.log" 2>&1 &
until grep -qE 'relay reachable at|did not come up|Tell them this' "$A/room.log" 2>/dev/null; do sleep 1; done
sleep 2

URL=$(grep -o 'https://[a-z0-9-]*\.trycloudflare\.com' "$A/tunnel.log" 2>/dev/null | head -1)

# Cloudflare hands out a hostname before it publishes DNS for it, and rate
# limits quick tunnels hard enough that several in a few minutes never resolve
# at all. That is their throttle, not a crosstalk failure. Tell them apart by
# the local relay: if it is answering and the public URL is not, the tunnel is
# the only thing missing.
if ! grep -q 'relay reachable at' "$A/room.log" 2>/dev/null; then
  if curl -sf -m 3 "http://127.0.0.1:8787/health" >/dev/null 2>&1; then
    if [ -n "$URL" ]; then
      echo "  SKIP  the relay is up locally but Cloudflare never routed $URL"
    else
      echo "  SKIP  the relay is up locally but Cloudflare issued no tunnel at all"
    fi
    echo "        Quick tunnels are rate limited. Try again in a few minutes."
    exit 0
  fi
  bad "the tunnel came up"
  tail -8 "$A/room.log"
  exit 1
fi
ok "a tunnel came up ($URL)"

curl -sf -m 15 "$URL/health" >/dev/null && ok "the relay answers over the public URL" \
  || bad "the relay answers over the public URL"
case $(curl -s -m 15 "$URL/invite/probe0?part=a") in
  *"not ready"*) ok "and serves /invite/ through it" ;;
  *) bad "and serves /invite/ through it" ;;
esac

for _ in $(seq 1 60); do
  INVITE=$(sed -n 's/^    \([0-9]\{3,6\}-[a-z].*\)$/\1/p' "$A/room.log" 2>/dev/null | head -1)
  [ -n "$INVITE" ] && break
  sleep 0.5
done
[ -n "$INVITE" ] && ok "the invite carries the public address" || { bad "the invite carries the public address"; cat "$A/room.log"; exit 1; }
case "$INVITE" in
  *trycloudflare.com*) ok "and it is the tunnel, not a LAN address" ;;
  *) bad "and it is the tunnel, not a LAN address ($INVITE)" ;;
esac

JOIN=$(b room join $INVITE --label ben)
case "$JOIN" in
  *'Now in a room with "ana"'*) ok "b joined over the public URL" ;;
  *) bad "b joined over the public URL"; echo "$JOIN" ;;
esac
for _ in $(seq 1 60); do grep -q 'Now in a room with' "$A/room.log" && break; sleep 0.5; done
grep -q 'Now in a room with "ben"' "$A/room.log" && ok "a saw the join" || bad "a saw the join"

rpc "$A" '{"op":"register","sessionId":"sa","pid":1,"name":"ana-web","cwd":"/tmp/web","socket":""}' >/dev/null
rpc "$B" '{"op":"register","sessionId":"sb","pid":2,"name":"ben-api","cwd":"/tmp/api","socket":""}' >/dev/null
sleep 3
SENT=$(rpc "$B" '{"op":"send","sessionId":"sb","to":"ana","text":"through the tunnel","intent":"fyi"}')
case "$SENT" in *'"ok":true'*) ok "b sent a message" ;; *) bad "b sent a message"; echo "    $SENT" ;; esac
sleep 4
READ=$(rpc "$A" '{"op":"read","sessionId":"sa","all":true}')
case "$READ" in
  *"through the tunnel"*) ok "a received it over the tunnel" ;;
  *) bad "a received it over the tunnel"; echo "    $READ" ;;
esac

# The tunnel is the whole exposure, so closing it has to actually close it.
a relay stop >/dev/null
sleep 3
if curl -sf -m 8 "$URL/health" >/dev/null 2>&1; then
  bad "relay stop closes the tunnel"
else
  ok "relay stop closes the tunnel"
fi

echo
echo "─────────────────────────────"
echo "  $PASS passed, $FAIL failed"
[ "$FAIL" -eq 0 ] || exit 1
