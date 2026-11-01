#!/usr/bin/env bash
# What crosstalk's mod shows, through the real daemon and the real CLI.
#
#   bash test/ui.sh
#
# Two identities on a local relay. ana has one Claude Code session, "work",
# whose inbox socket is a stand-in that records whatever is written to it, and
# a second one, "docs", to route to. ben sends. Without the mod, ana's session
# gets the classic notice in its inbox. With the mod polling, the same message
# is a card instead: nothing is written to the inbox, `crosstalk ui` lists it,
# and handing it over, muting it, replying and routing each settle once, and
# stay settled after the daemon restarts. When the mod stops polling, the
# classic notice comes back.
#
# The mod itself, in a real Claude Code, is test/canary/drive.sh.

set -u
export CROSSTALK_NO_GATHER=1  # sessions started before crosstalk: test/gather.sh, with a registry of its own
cd "$(dirname "$0")/.."
ROOT=$(pwd)
PORT=${PORT:-8898}
TMP=$(mktemp -d)
A="$TMP/a"; B="$TMP/b"; R="$TMP/repos"
FAILED=0
PASSES=0
export CROSSTALK_MOD_FRESH_MS=4000

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
ui() { CROSSTALK_HOME="$A" bin/crosstalk ui "$@" --session work; }
field() { bun -e 'const o = JSON.parse(await Bun.stdin.text()); const f = new Function("o", "return " + process.argv[1]); console.log(JSON.stringify(f(o)) ?? "")' "$1"; }
RELAY_PID=""; INBOX_PID=""
cleanup() {
  stop_daemon "$A"; stop_daemon "$B"
  [ -n "$RELAY_PID" ] && kill "$RELAY_PID" 2>/dev/null
  [ -n "$INBOX_PID" ] && kill "$INBOX_PID" 2>/dev/null
  rm -rf "$TMP"
}
trap cleanup EXIT

mkdir -p "$TMP/relay" "$A" "$B" "$R"
echo "state in $TMP"

repo() { mkdir -p "$1" && git -C "$1" init -q -b "$3" && git -C "$1" remote add origin "$2" && git -C "$1" -c user.email=t@t -c user.name=t commit -q --allow-empty -m init; }
repo "$R/ana-api"  "git@github.com:acme/api.git"  main
repo "$R/ana-docs" "git@github.com:acme/docs.git" main
repo "$R/ben-api"  "https://github.com/acme/api"  main
repo "$R/ben-ops"  "git@github.com:acme/ops.git"  main

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

# Claude Code's inbox, stood in for: whatever is written to it lands in a file.
SOCK="$TMP/inbox.sock"; INBOX="$TMP/inbox.txt"; : >"$INBOX"
bun -e '
  const fs = require("fs"), net = require("net")
  net.createServer((c) => c.on("data", (d) => fs.appendFileSync(process.argv[2], d))).listen(process.argv[1])
' "$SOCK" "$INBOX" &
INBOX_PID=$!
for _ in $(seq 1 20); do [ -S "$SOCK" ] && break; sleep 0.2; done
reg() { rpc "$A" "{\"op\":\"register\",\"sessionId\":\"$1\",\"pid\":1,\"name\":\"$1\",\"cwd\":\"$2\",\"socket\":\"$3\"}" >/dev/null; }
reg docs "$R/ana-docs" ""
reg work "$R/ana-api" "$SOCK"
rpc "$B" "{\"op\":\"register\",\"sessionId\":\"ben-api\",\"pid\":1,\"name\":\"ben-api\",\"cwd\":\"$R/ben-api\",\"socket\":\"\"}" >/dev/null
rpc "$B" "{\"op\":\"register\",\"sessionId\":\"ben-ops\",\"pid\":1,\"name\":\"ben-ops\",\"cwd\":\"$R/ben-ops\",\"socket\":\"\"}" >/dev/null
send() { rpc "$B" "{\"op\":\"send\",\"sessionId\":\"$1\",\"cwd\":\"$R/$1\",\"to\":\"ana\",\"text\":\"$2\",\"intent\":\"question\"}"; }
item_id() { ui list | field "o.items.find(i => (i.text ?? i.question ?? '').includes('$1'))?.id ?? ''" | tr -d '"'; }
poll() { rpc "$A" '{"op":"ui","sessionId":"work","mod":true}' >/dev/null; }

echo
echo "without the mod: the classic notice"
send ben-api "classic path PINE-0101" >/dev/null
sleep 2
has "$(cat "$INBOX")" 'waiting from ben' "the session's inbox gets a notice"
hasnt "$(cat "$INBOX")" 'PINE-0101' "which carries none of ben's words"
rpc "$A" '{"op":"read","sessionId":"work"}' >/dev/null # the agent read it

echo
echo "with the mod polling: a card, and nothing in the inbox"
: >"$INBOX"
poll
send ben-api "token format changed MOSS-0202" >/dev/null
sleep 2
check "$(wc -c <"$INBOX" | tr -d ' ')" "0" "nothing is written to the inbox"
L=$(ui list)
has "$L" 'MOSS-0202' "crosstalk ui lists the message, text and all, for the mod"
has "$L" '"from":"ben"' "with who sent it"
hasnt "$L" 'PINE-0101' "a message the agent already read is no card"
ID=$(item_id MOSS-0202)
has "$ID" 'msg:' "it has an id"

echo
echo "raised, then handed over: once"
check "$(ui act --id "$ID" --action raised | field o.item.state)" '"pending"' "raising the picker leaves it pending"
H=$(ui act --id "$ID" --action hand)
check "$(echo "$H" | field o.item.state)" '"handed"' "hand: handed"
has "$H" 'MOSS-0202' "the data block for the agent holds the message"
has "$H" 'BEGIN QUOTED MESSAGE' "quoted, as data"
has "$(ui act --id "$ID" --action hand)" 'already handed' "a second hand-over is refused"
hasnt "$(ui list)" 'MOSS-0202' "and it is no longer waiting"
hasnt "$(rpc "$A" '{"op":"read","sessionId":"work"}')" 'MOSS-0202' "crosstalk_read does not hand it over again"

echo
echo "muted, and later"
poll
send ben-api "invoice retries REED-0303" >/dev/null
send ben-api "drain node four LARK-0404" >/dev/null
sleep 2
MUTE=$(item_id REED-0303); LATER=$(item_id LARK-0404)
check "$(ui act --id "$MUTE" --action mute | field o.item.state)" '"muted"' "mute: muted"
check "$(ui act --id "$LATER" --action later | field o.item.state)" '"later"' "later: later"
L=$(ui list)
hasnt "$L" 'REED-0303' "a muted card is gone"
has "$L" 'LARK-0404' "a card put off is still waiting"
check "$(wc -c <"$INBOX" | tr -d ' ')" "0" "and still nothing went to the inbox"

echo
echo "a reply goes back to ben, and nothing to ana's agent"
REP=$(ui act --id "$LATER" --action answer --value "drain it after five")
check "$(echo "$REP" | field o.ok)" "true" "the reply is sent"
sleep 2
has "$(rpc "$B" '{"op":"read","sessionId":"ben-api","all":true}')" 'drain it after five' "ben has it"

echo
echo "a route question is a picker of sessions"
poll
send ben-ops "ops runbook moved OAK-0505" >/dev/null
sleep 2
check "$(wc -c <"$INBOX" | tr -d ' ')" "0" "the route question is not injected"
RID=$(ui list | field "o.items.find(i => i.kind === 'route')?.id ?? ''" | tr -d '"')
has "$RID" 'route:' "it is listed as a route item"
Q=$(ui list | field "o.items.find(i => i.kind === 'route')")
has "$Q" 'Which session should get it?' "it asks which session"
has "$Q" '"Hold it"' "with Hold it"
has "$Q" '"docs"' "and the sessions to choose from"
hasnt "$Q" 'OAK-0505' "carrying none of ben's words"
# The session is renamed while the picker is up: the label it showed still names it.
rpc "$A" "{\"op\":\"register\",\"sessionId\":\"docs\",\"pid\":1,\"name\":\"docs-renamed\",\"cwd\":\"$R/ana-docs\",\"socket\":\"\"}" >/dev/null
poll
RT=$(ui act --id "$RID" --action answer --value docs)
check "$(echo "$RT" | field o.ok)" "true" "answering routes it"
sleep 1
has "$(rpc "$A" '{"op":"read","sessionId":"docs","all":true}')" 'OAK-0505' "the message reached docs"
hasnt "$(ui list)" "$RID" "and the question is settled"

echo
echo "after the daemon restarts, nothing comes back"
stop_daemon "$A"
start_daemon "$A" "$TMP/da.log"
sleep 1
L=$(ui list)
for c in MOSS-0202 REED-0303 LARK-0404 OAK-0505; do hasnt "$L" "$c" "$c stays settled"; done
N=$(bun -e 'const f = JSON.parse(require("fs").readFileSync(process.argv[1], "utf8")); console.log(Object.keys(f.items).filter(k => k.startsWith("msg:")).length)' "$A/ui.json")
check "$N" "3" "one item per message, no duplicates"

echo
echo "the mod stops polling: the classic notice comes back"
reg work "$R/ana-api" "$SOCK"
: >"$INBOX"
send ben-api "after the mod MAPLE-0606" >/dev/null
sleep 5
has "$(cat "$INBOX")" 'waiting from ben' "the notice is injected again"

echo
[ $FAILED -eq 0 ] && echo "ui: all $PASSES passed" || { echo "ui: failures"; tail -30 "$TMP/da.log"; }
exit $FAILED
