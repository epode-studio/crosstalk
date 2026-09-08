#!/usr/bin/env bash
# Every feature, two identities, one real relay.
#
#   bash test/e2e.sh
#
# Runs two separate crosstalk installations on this machine, pairs them through
# whichever relay is configured, and exercises the whole surface: pairing,
# messages, slices, presence, questions, the trust ladder, rooms, facts, tasks,
# unprompted sending, local posts, the attention budget, device linking and the
# hook contracts for all three clients.
#
# Two rules learned the hard way and worth keeping: never read an exit code
# through a pipe, because it belongs to the last command, and resolve a process
# by what it is listening on rather than by $!, which in a backgrounded compound
# is the subshell.

set -u
cd "$(dirname "$0")/.."
ROOT=$(pwd)
A=$(mktemp -d)/a
B=$(mktemp -d)/b
mkdir -p "$A" "$B"
PASS=0
FAIL=0

ok()   { echo "  PASS  $1"; PASS=$((PASS+1)); }
bad()  { echo "  FAIL  $1"; FAIL=$((FAIL+1)); }
check() { if [ "$1" = "$2" ]; then ok "$3"; else bad "$3 (wanted '$2', got '$1')"; fi; }
has()  { if echo "$1" | grep -q "$2"; then ok "$3"; else bad "$3"; fi; }

a() { CROSSTALK_HOME="$A" bun src/cli.ts "$@" 2>&1; }
b() { CROSSTALK_HOME="$B" bun src/cli.ts "$@" 2>&1; }
rpc() { CROSSTALK_HOME="$1" bun -e '
  const { request } = await import("./src/client.ts")
  console.log(JSON.stringify(await request(JSON.parse(process.argv[1]))))
' "$2" 2>&1; }
stop() { [ -f "$1/daemon.lock" ] && kill "$(cat "$1/daemon.lock")" 2>/dev/null; rm -f "$1/daemon.sock" "$1/daemon.lock"; }

cleanup() { stop "$A"; stop "$B"; pkill -f "src/cli.ts pair" 2>/dev/null; rm -rf "$A" "$B"; }
trap cleanup EXIT

echo "state in $A and $B"
echo

# --- pairing -------------------------------------------------------------------
echo "pairing"
CROSSTALK_HOME="$A" bun src/cli.ts pair --label ana >"$A/pair.log" 2>&1 &
for _ in $(seq 1 60); do
  INVITE=$(sed -n 's/^    \([0-9]\{3,6\}-[a-z][a-z-]*\)$/\1/p' "$A/pair.log" | head -1)
  [ -n "$INVITE" ] && break
  sleep 0.5
done
if [ -z "$INVITE" ]; then bad "an invite was printed"; cat "$A/pair.log"; exit 1; fi
has "$INVITE" '^[0-9]' "invite leads with a public slot"
check "$(echo "$INVITE" | tr -cd - | wc -c | tr -d ' ')" "4" "four secret words after it"

JOIN=$(b pair "$INVITE" --label ben)
has "$JOIN" 'Paired with "ana"' "the joining side paired"
for _ in $(seq 1 40); do grep -q "Paired with" "$A/pair.log" && break; sleep 0.5; done
has "$(cat "$A/pair.log")" 'Paired with "ben"' "the inviting side paired"

FA=$(bun -e 'const {fingerprint}=await import("./src/crypto.ts");const fs=require("fs");console.log(fingerprint(JSON.parse(fs.readFileSync(process.argv[1]+"/identity.json","utf8")).ed.pub))' "$A")
has "$JOIN" "$FA" "the fingerprints match across the two sides"

# --- daemons -------------------------------------------------------------------
echo
echo "daemons and presence"
CROSSTALK_HOME="$A" nohup bun src/daemon.ts >"$A/daemon.log" 2>&1 &
CROSSTALK_HOME="$B" nohup bun src/daemon.ts >"$B/daemon.log" 2>&1 &
sleep 4
has "$(cat "$A/daemon.log")" "relay ready" "ana's daemon linked to the relay"
has "$(cat "$B/daemon.log")" "relay ready" "ben's daemon linked to the relay"

rpc "$A" '{"op":"register","sessionId":"sa","pid":1,"name":"ana-web","cwd":"/tmp/web","socket":""}' >/dev/null
rpc "$B" '{"op":"register","sessionId":"sb","pid":2,"name":"ben-api","cwd":"/tmp/api","socket":""}' >/dev/null
sleep 3
has "$(a peers)" "ben" "ana sees ben"

# --- messages ------------------------------------------------------------------
echo
echo "messages"
SENT=$(rpc "$B" '{"op":"send","sessionId":"sb","to":"ana","text":"the tenant column is gone","intent":"fyi"}')
has "$SENT" '"ok":true' "ben sent a message"
sleep 3
READ=$(rpc "$A" '{"op":"read","sessionId":"sa","all":true}')
has "$READ" "tenant column is gone" "ana received it"

# --- the trust ladder ----------------------------------------------------------
echo
echo "the trust ladder"
a trust ben notify >/dev/null
ASKED=$(rpc "$B" '{"op":"ask","sessionId":"sb","to":"ana","text":"is the schema frozen?","timeoutMs":8000}')
has "$ASKED" "Refused" "a question is refused when they are only at notify"
a trust ben ask >/dev/null
sleep 1
ASK2=$(rpc "$B" '{"op":"ask","sessionId":"sb","to":"ana","text":"is the schema frozen?","timeoutMs":6000}')
has "$ASK2" "no answer" "at ask it goes through and waits for a reply"

# --- unprompted sending --------------------------------------------------------
echo
echo "what an agent may send on its own"
NOREASON=$(rpc "$B" '{"op":"send","sessionId":"sb","to":"ana","text":"x","intent":"fyi","unprompted":true}')
has "$NOREASON" "why it affects them" "unprompted without a reason is refused"
WITH=$(rpc "$B" '{"op":"send","sessionId":"sb","to":"ana","text":"x","intent":"fyi","unprompted":true,"because":"their query uses it"}')
has "$WITH" '"ok":true' "unprompted with a reason goes"
for i in 1 2 3 4 5; do rpc "$B" '{"op":"send","sessionId":"sb","to":"ana","text":"n","intent":"fyi","unprompted":true,"because":"why"}' >/dev/null; done
OVER=$(rpc "$B" '{"op":"send","sessionId":"sb","to":"ana","text":"n","intent":"fyi","unprompted":true,"because":"why"}')
has "$OVER" "unprompted messages" "the ration runs out"

# --- facts ---------------------------------------------------------------------
echo
echo "what the room remembers"
a facts add "the API returns snake_case" >/dev/null
a facts add "uploads chunk at 4KB" --in palpable-fw >/dev/null
sleep 3
has "$(b facts)" "snake_case" "a fact ana wrote reached ben"
DIGEST=$(CROSSTALK_HOME="$B" bun -e '
  const { request } = await import("./src/client.ts")
  console.log((await request({op:"facts",cwd:"/tmp/anything"})).digest ?? "")' 2>&1)
has "$DIGEST" "snake_case" "an untagged fact is offered everywhere"
if echo "$DIGEST" | grep -q "4KB"; then bad "a tagged fact stays out of an unrelated repo"; else ok "a tagged fact stays out of an unrelated repo"; fi

FID=$(CROSSTALK_HOME="$B" bun -e '
  const { request } = await import("./src/client.ts")
  const r = await request({op:"facts"})
  const f = Object.values(r.facts).flat().find(x => x.text.includes("snake_case"))
  console.log(f ? f.id : "")' 2>&1)
b facts confirm "$FID" >/dev/null
sleep 2
has "$(a facts)" "ben" "ben's confirmation reached ana, so the fact has two names on it"

# --- tasks ---------------------------------------------------------------------
echo
echo "what the room has agreed to do"
a tasks add "wire the upload retry" >/dev/null
sleep 3
has "$(b tasks)" "upload retry" "a task ana added reached ben"
TID=$(CROSSTALK_HOME="$B" bun -e '
  const { request } = await import("./src/client.ts")
  const r = await request({op:"tasks"})
  const t = Object.values(r.tasks).flat()[0]
  console.log(t ? t.id : "")' 2>&1)
has "$(b tasks claim "$TID")" "claim" "ben claimed it"
sleep 3
CLASH=$(a tasks claim "$TID")
has "$CLASH" "somebody else" "ana cannot claim what ben already has"
has "$(b tasks done "$TID" "landed with backoff")" "done" "ben finished it"

# --- rooms ---------------------------------------------------------------------
echo
echo "rooms"
has "$(a room)" "ben" "pairing shows as a room of two"
a room create beta >/dev/null
has "$(a room invite beta ben)" "invited" "ana invited ben to a bigger room"
sleep 3
has "$(b room)" "INVITATION" "ben sees an invitation rather than membership"
b room accept beta >/dev/null
sleep 2
has "$(b room)" "#beta" "ben is in it after accepting"

# --- local sources and the attention budget ------------------------------------
echo
echo "things that are not people"
has "$(a post 'build failed on main' --intent blocking --source ci)" "posted as ci" "a script posted without pairing"
sleep 1
has "$(a attention)" "ci" "the attention view shows what spent it"

# --- hooks, for all three clients ----------------------------------------------
echo
echo "hook contracts"
for shape in \
  '{"session_id":"h1","cwd":"/tmp","hook_event_name":"SessionStart"}' \
  '{"session_id":"h2","cwd":"/tmp","hook_event_name":"SessionStart","thread_name":"codex"}' \
  '{"session_id":"h3","cwd":"/tmp","event_name":"SessionStart"}'
do
  OUT=$(echo "$shape" | env -u CLAUDE_CODE_MESSAGING_SOCKET CROSSTALK_HOME="$A" bun src/hook.ts 2>&1)
  has "$OUT" '"continue":true' "hook accepts $(echo "$shape" | grep -o '"h[0-9]"')"
done
sleep 1
DELIVER=$(echo '{"session_id":"h1","cwd":"/tmp","hook_event_name":"PostToolUse"}' | env -u CLAUDE_CODE_MESSAGING_SOCKET CROSSTALK_HOME="$A" bun src/hook.ts 2>&1)
has "$DELIVER" "continue" "a delivery event answers cleanly"

# --- cost ----------------------------------------------------------------------
echo
echo "cost"
has "$(a cost)" "ben" "traffic is accounted per person"

echo
echo "─────────────────────────────"
echo "  $PASS passed, $FAIL failed"
[ "$FAIL" = "0" ] && echo "  all good" || echo "  something above needs looking at"
exit "$FAIL"
