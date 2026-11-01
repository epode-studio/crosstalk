#!/usr/bin/env bash
# A message reaches the session working on the same thing, not whichever is idle.
#
#   bash test/routing.sh
#
# Two identities on a local relay. ana has three sessions open: api on main,
# api on a feature branch, and firmware. ben sends from sessions in different
# repos and branches, and each message has to land in exactly one of ana's
# sessions, the right one, or be held with a question when none fits.
#
# Every session is pull mode (no inbox socket), so what landed where is read
# straight back with the read op, and a held message's question comes out of
# the notices op the way a Codex or agy hook would collect it.

set -u
export CROSSTALK_NO_GATHER=1  # sessions started before crosstalk: test/gather.sh, with a registry of its own
export CROSSTALK_THREADS_NO_PUSH=1  # the remotes here are made up: threads are committed locally, never pushed
cd "$(dirname "$0")/.."
ROOT=$(pwd)
PORT=${PORT:-8897}
TMP=$(mktemp -d)
A="$TMP/a"; B="$TMP/b"; R="$TMP/repos"
FAILED=0
PASSES=0

pass() { echo "  PASS  $1"; PASSES=$((PASSES+1)); }
fail() { echo "  FAIL  $1"; FAILED=1; }
check() { if [ "$1" = "$2" ]; then pass "$3"; else fail "$3 (wanted '$2', got '$1')"; fi; }
has() { case "$1" in *"$2"*) pass "$3" ;; *) fail "$3"; echo "        got: $1" | head -c 600; echo ;; esac; }
stop_daemon() {
  if [ -f "$1/daemon.lock" ]; then
    P=$(cat "$1/daemon.lock")
    kill "$P" 2>/dev/null
    for _ in $(seq 1 30); do kill -0 "$P" 2>/dev/null || break; sleep 0.2; done
  fi
  rm -f "$1/daemon.sock" "$1/daemon.lock"
}
rpc() { CROSSTALK_HOME="$1" bun -e '
  const { request } = await import("./src/client.ts")
  console.log(JSON.stringify(await request(JSON.parse(process.argv[1]))))
' "$2" 2>&1; }
RELAY_PID=""
cleanup() {
  stop_daemon "$A"; stop_daemon "$B"
  [ -n "$RELAY_PID" ] && kill "$RELAY_PID" 2>/dev/null
  rm -rf "$TMP"
}
trap cleanup EXIT

mkdir -p "$TMP/relay" "$A" "$B" "$R"
echo "state in $TMP"

# --- repos ---------------------------------------------------------------------
# Same remote cloned two ways, to prove the spelling does not matter.
repo() { # dir remote branch
  mkdir -p "$1" && git -C "$1" init -q -b "$3" && git -C "$1" remote add origin "$2"
  git -C "$1" -c user.email=t@t -c user.name=t commit -q --allow-empty -m init
}
repo "$R/ana-api"      "git@github.com:acme/api.git"            main
repo "$R/ana-api-feat" "https://github.com/acme/api"            token-v2
repo "$R/ana-fw"       "git@github.com:acme/firmware.git"       main
repo "$R/ben-api"      "https://github.com/Acme/api.git"        main
repo "$R/ben-feat"     "git@github.com:acme/api.git"            token-v2
repo "$R/ben-docs"     "git@github.com:acme/docs.git"           main
repo "$R/ben-other"    "git@github.com:acme/api.git"            spike
repo "$R/ben-ops"      "git@github.com:acme/ops.git"            main
mkdir -p "$R/ben-plain"

# --- relay and room ------------------------------------------------------------
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
grep -q "in a room with" "$TMP/pb.log" || { echo "joining did not complete"; cat "$TMP/pb.log"; exit 1; }

# The room command may already have started a daemon; restart both cleanly.
stop_daemon "$A"; stop_daemon "$B"
CROSSTALK_HOME="$A" nohup bun src/daemon.ts >"$TMP/da.log" 2>&1 &
CROSSTALK_HOME="$B" nohup bun src/daemon.ts >"$TMP/db.log" 2>&1 &
for _ in $(seq 1 40); do [ -S "$A/daemon.sock" ] && [ -S "$B/daemon.sock" ] && break; sleep 0.25; done
sleep 2

reg() { rpc "$1" "{\"op\":\"register\",\"sessionId\":\"$2\",\"pid\":1,\"name\":\"$2\",\"cwd\":\"$3\",\"socket\":\"\"}" >/dev/null; }
reg "$A" api      "$R/ana-api"
reg "$A" api-feat "$R/ana-api-feat"
reg "$A" fw       "$R/ana-fw"
for s in ben-api ben-feat ben-docs ben-other ben-ops ben-plain; do reg "$B" "$s" "$R/$s"; done
sleep 1

send() { rpc "$B" "{\"op\":\"send\",\"sessionId\":\"$1\",\"cwd\":\"$R/$1\",\"to\":\"$2\",\"text\":\"$3\",\"intent\":\"fyi\"}"; }
# Which of ana's sessions hold a message with this text, as a sorted list.
where() {
  out=""
  for s in api api-feat fw; do
    case "$(rpc "$A" "{\"op\":\"read\",\"sessionId\":\"$s\",\"all\":true}")" in
      *"$1"*) out="$out $s" ;;
    esac
  done
  echo "${out# }"
}

# --- footprint from the hook -----------------------------------------------------
echo
echo "the hook reports what a tool call touched"
echo "{\"hook_event_name\":\"PostToolUse\",\"session_id\":\"api\",\"cwd\":\"$R/ana-api\",\"tool_name\":\"Edit\",\"tool_input\":{\"file_path\":\"$R/ana-api/src/auth/token.ts\"}}" \
  | CROSSTALK_HOME="$A" CLAUDE_CODE_MESSAGING_SOCKET= bun src/hook.ts >/dev/null 2>&1
has "$(cat "$A/sessions.json")" '"src/auth/token.ts"' "the touched file is in api's persisted footprint"
has "$(cat "$A/sessions.json")" '"github.com/acme/api"' "the repo remote is normalised"

# --- routing ---------------------------------------------------------------------
echo
echo "different repos"
send ben-docs ana "warmup" >/dev/null   # (held: docs matches nothing; resolved below)
has "$(send ben-api ana "tenant column is gone")" '"ok":true' "ben sent from api@main"
sleep 2
check "$(where "tenant column is gone")" "api" "it reached api only, not firmware"

echo
echo "same repo, different branches"
send ben-feat ana "v2 token format changed" >/dev/null
sleep 2
check "$(where "v2 token format changed")" "api-feat" "the matching branch wins"

echo
echo "named session still wins"
send ben-api ana/fw "flash layout question" >/dev/null
sleep 2
check "$(where "flash layout question")" "fw" "a session named by the sender gets it"

echo
echo "no match: held, asked, nothing delivered"
# The question goes to the session touched last.
reg "$A" fw "$R/ana-fw"
send ben-docs ana "docs site moved" >/dev/null
sleep 2
check "$(where "docs site moved")" "" "delivered to no session"
LIST=$(rpc "$A" '{"op":"route"}')
has "$LIST" '"github.com/acme/docs"' "it is held, with the sender's repo"
NOTICE=$(rpc "$A" '{"op":"notices","sessionId":"fw"}')
has "$NOTICE" 'which session should get it' "the most recent session is asked where it goes"
has "$NOTICE" 'crosstalk_route' "and told how to answer"
case "$NOTICE" in *"docs site moved"*) fail "the question leaked the sender's words" ;; *) pass "the question carries none of the sender's words" ;; esac
check "$(rpc "$A" '{"op":"notices","sessionId":"api-feat"}')" '{"ok":true,"notice":null}' "a session that was not touched last is not asked"

ID=$(echo "$LIST" | bun -e 'const r=JSON.parse(await Bun.stdin.text()); console.log(r.held.find(h=>h.repo==="github.com/acme/docs").id)')
ROUTED=$(rpc "$A" "{\"op\":\"route\",\"id\":\"$ID\",\"session\":\"api\"}")
has "$ROUTED" '"remembered":true' "answering routes it and remembers"
check "$(where "docs site moved")" "api" "the held message lands where it was sent"
check "$(where "warmup")" "api" "and so does the earlier one about the same work"
send ben-docs ana "docs again" >/dev/null
sleep 2
check "$(where "docs again")" "api" "the next one from ben about docs follows the answer"

echo
echo "a tie is a question too"
send ben-other ana "spike notes" >/dev/null
sleep 2
check "$(where "spike notes")" "" "two equal matches deliver to neither"
has "$(rpc "$A" '{"op":"route"}')" 'more than one session' "and it is held as a tie"

echo
echo "a peer without a footprint routes the old way"
# Outside a git repo the sender has no footprint, exactly like a peer that
# predates the field: the first registered session, as before.
send ben-plain ana "no footprint here" >/dev/null
sleep 2
check "$(where "no footprint here")" "api" "it reaches one session, chosen as before"
has "$(cat "$TMP/da.log")" '[no footprint]' "and the log says why"

echo
echo "a session with an inbox socket is asked through it"
# Stands in for Claude Code's inbox: whatever is written to it lands in a file.
SOCK="$TMP/inbox.sock"
bun -e '
  const fs = require("fs"), net = require("net")
  net.createServer((c) => c.on("data", (d) => fs.appendFileSync(process.argv[2], d))).listen(process.argv[1])
' "$SOCK" "$TMP/inbox.txt" &
INBOX_PID=$!
for _ in $(seq 1 20); do [ -S "$SOCK" ] && break; sleep 0.2; done
rpc "$A" "{\"op\":\"register\",\"sessionId\":\"cc\",\"pid\":1,\"name\":\"cc\",\"cwd\":\"$R/ana-fw\",\"socket\":\"$SOCK\"}" >/dev/null
send ben-ops ana "ops runbook" >/dev/null
sleep 2
has "$(cat "$TMP/inbox.txt" 2>/dev/null)" 'which session should get it' "the question is injected into the session touched last"
case "$(cat "$TMP/inbox.txt" 2>/dev/null)" in *"ops runbook"*) fail "the injected question leaked the sender's words" ;; *) pass "and carries none of the sender's words" ;; esac
kill "$INBOX_PID" 2>/dev/null

echo
[ $FAILED -eq 0 ] && echo "routing: all $PASSES passed" || { echo "routing: failures"; tail -30 "$TMP/da.log"; }
exit $FAILED
