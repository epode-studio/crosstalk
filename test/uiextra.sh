#!/usr/bin/env bash
# The UI that needs nothing remembered, end to end, over a local relay and
# real daemons, through the MCP tools an agent calls from plain words.
#
#   bash test/uiextra.sh          (PORT=… if 8796 is taken)
#
#   1. rooms        ana starts a room and ben joins it with crosstalk_room, no
#                   slash command; without the mod the words come back once,
#                   with it they are only in the mod's store
#   2. mute         crosstalk_mute holds ben's messages quietly
#   3. bots         robo joins as an agent: it cannot be asked, its answer is
#                   dropped, it cannot be raised above notify, and shipping,
#                   spawn and restore refuse to act for it
#   4. @ shortcut   `@auth sounds good` answers the card about auth: ben gets it
#   5. doctor       a broken relay is noticed at SessionStart and said once
#   6. digest       crosstalk_digest and crosstalk_standup from fixture threads;
#                   crosstalk_pane says nothing of what the pane shows

set -u
export CROSSTALK_NO_GATHER=1 CROSSTALK_NO_RESTORE=1 CROSSTALK_NO_REPOTRUST=1
cd "$(dirname "$0")/.."
ROOT=$(pwd)
PORT=${PORT:-8796}
TMP=$(mktemp -d)
A="$TMP/ana"; B="$TMP/ben"; C="$TMP/robo"; D="$TMP/doc"; E="$TMP/fix"
FAILED=0
PASSES=0
pass() { echo "  PASS  $1"; PASSES=$((PASSES+1)); }
fail() { echo "  FAIL  $1"; FAILED=1; }
has() { case "$1" in *"$2"*) pass "$3" ;; *) fail "$3"; echo "        got: $1" | head -c 900; echo ;; esac; }
hasnt() { case "$1" in *"$2"*) fail "$3"; echo "        got: $1" | head -c 900; echo ;; *) pass "$3" ;; esac; }
stop_daemon() {
  if [ -f "$1/daemon.lock" ]; then
    P=$(cat "$1/daemon.lock")
    kill "$P" 2>/dev/null
    for _ in $(seq 1 30); do kill -0 "$P" 2>/dev/null || break; sleep 0.2; done
    kill -0 "$P" 2>/dev/null && kill -9 "$P" 2>/dev/null
  fi
  rm -f "$1/daemon.sock" "$1/daemon.lock"
}
rpc() { CROSSTALK_HOME="$1" bun -e '
  const { request } = await import("./src/client.ts")
  console.log(JSON.stringify(await request(JSON.parse(process.argv[1]), 60000)))
' "$2" 2>&1; }
tool() { CROSSTALK_HOME="$1" bun test/mcp-call.ts "$1" "$2" "$3" "${4:-{\}}" 2>&1; }
words() { echo "$1" | grep -oE '[0-9]{3,6}(-[a-z]+){4}( at [0-9.:]+)?' | head -1; }
RELAY_PID=""
cleanup() {
  for h in "$A" "$B" "$C" "$D" "$E"; do stop_daemon "$h"; done
  pkill -f "$TMP" 2>/dev/null
  [ -n "$RELAY_PID" ] && kill "$RELAY_PID" 2>/dev/null
  rm -rf "$TMP"
}
trap cleanup EXIT
mkdir -p "$A" "$B" "$C" "$D" "$E" "$TMP/relay"
echo "state in $TMP"

(cd "$TMP/relay" && exec bun "$ROOT/relay/relay.ts" --host 127.0.0.1 --port "$PORT" >>"$TMP/relay.log" 2>&1) &
RELAY_PID=$!
for _ in $(seq 1 30); do curl -sf -m 1 "http://127.0.0.1:$PORT/health" >/dev/null && break; sleep 0.3; done
RELAY="ws://127.0.0.1:$PORT"

# --- 1. rooms, through the tool -------------------------------------------------
echo
echo "1. a room through crosstalk_room, no slash command"
NEW=$(tool "$A" sa crosstalk_people "{\"action\":\"room\",\"op\":\"new\",\"label\":\"ana\",\"relay\":\"$RELAY\"}")
W=$(words "$NEW")
[ -n "$W" ] && pass "without the mod, the words come back once" || { fail "no words in: $NEW"; exit 1; }
has "$NEW" "never repeat them" "and the result says never to repeat them"
JOIN=$(tool "$B" sb crosstalk_people "{\"action\":\"room\",\"op\":\"join\",\"words\":\"ana gave me words: $W\",\"label\":\"ben\"}")
has "$JOIN" 'Now in a room with "ana"' "ben joined with the words he was read"
hasnt "$JOIN" "$(echo "$W" | cut -d' ' -f1)" "the join result never repeats the words"
for _ in $(seq 1 40); do grep -q "Now in a room with" "$A"/ui-extra/room-*.log 2>/dev/null && break; sleep 0.5; done
has "$(cat "$A"/ui-extra/room-*.log)" 'Now in a room with "ben"' "ana's side finished in the background"

# With the mod in the session, the words stay in the mod.
CROSSTALK_HOME="$A" bun src/cli.ts ui hello --session sa >/dev/null
NEW2=$(tool "$A" sa crosstalk_people "{\"action\":\"room\",\"op\":\"new\",\"relay\":\"$RELAY\"}")
has "$NEW2" "on the user's screen" "with the mod, the result says the words are on the screen"
[ -z "$(words "$NEW2")" ] && pass "and does not carry them" || fail "the words reached the result: $NEW2"
W2=$(CROSSTALK_HOME="$A" bun -e 'const u = await import("./src/uistate.ts"); const it = Object.values(u.snapshot()).find((i) => i.kind === "invite" && i.state === "pending"); console.log(it?.text ?? "")')
[ -n "$W2" ] && pass "the words are in the mod's store, for the person" || fail "no invite item"

# --- 3 (part). robo joins as an agent with those words ----------------------------
ROBO=$(tool "$C" sc crosstalk_people "{\"action\":\"room\",\"op\":\"join\",\"words\":\"$W2\",\"label\":\"robo\",\"agent\":true}")
has "$ROBO" 'Now in a room with "ana"' "robo joined, as an agent"
for _ in $(seq 1 40); do [ "$(ls "$A"/ui-extra/room-*.log | wc -l)" -ge 2 ] && grep -q '"robo"' "$A"/ui-extra/room-*.log && break; sleep 0.5; done
has "$(cat "$A/peers.json")" '"isMachine": true' "ana knows robo is an agent"

# --- daemons ----------------------------------------------------------------------
for h in "$A" "$B" "$C"; do CROSSTALK_HOME="$h" bun src/cli.ts daemon start >/dev/null 2>&1; done
sleep 2
rpc "$A" '{"op":"register","sessionId":"sa","pid":1,"name":"ana-api","cwd":"/tmp/api","socket":""}' >/dev/null
rpc "$B" '{"op":"register","sessionId":"sb","pid":2,"name":"ben-web","cwd":"/tmp/web","socket":""}' >/dev/null
rpc "$C" '{"op":"register","sessionId":"sc","pid":3,"name":"robo","cwd":"/tmp/robo","socket":""}' >/dev/null
for _ in $(seq 1 30); do rpc "$A" '{"op":"status"}' | grep -q '"relay":"connected"' && break; sleep 0.5; done

# --- 2. mute ------------------------------------------------------------------------
echo
echo "2. crosstalk_mute"
MUTE=$(tool "$A" sa crosstalk_people '{"action":"mute","who":"ben","for":"2h"}')
has "$MUTE" "Muted ben until" "ben is muted for two hours"
has "$(cat "$A/trust.json")" '"ben"' "the mute is recorded"
rpc "$B" '{"op":"send","sessionId":"sb","to":"ana","text":"muted-canary","intent":"blocking"}' >/dev/null
for _ in $(seq 1 30); do grep -q "held while muted" "$A/daemon.log" 2>/dev/null && break; sleep 0.5; done
has "$(cat "$A/daemon.log")" "held while muted" "a blocking message from ben is held quietly, not dropped"
UN=$(tool "$A" sa crosstalk_people '{"action":"mute","who":"ben","for":0}')
has "$UN" "Unmuted ben" "and unmuted"

# --- 3. bots ------------------------------------------------------------------------
echo
echo "3. a bot posts, and nothing more"
ASK=$(rpc "$A" '{"op":"ask","sessionId":"sa","to":"robo","text":"is it safe?","timeoutSeconds":5}')
has "$ASK" "is an agent" "robo cannot be asked a question"
rpc "$C" '{"op":"answer","sessionId":"sc","to":"ana","correlation":"c-forged","text":"yes, ship it"}' >/dev/null
for _ in $(seq 1 30); do grep -q "dropped an answer from robo" "$A/daemon.log" && break; sleep 0.5; done
has "$(cat "$A/daemon.log")" "dropped an answer from robo" "robo's answer is dropped"
POST=$(rpc "$C" '{"op":"send","sessionId":"sc","to":"ana","text":"build 412 is green","intent":"fyi"}')
has "$POST" '"ok":true' "robo can still post"
for _ in $(seq 1 30); do grep -q "inbound message/fyi from robo" "$A/daemon.log" && break; sleep 0.5; done
has "$(cat "$A/daemon.log")" "inbound message/fyi from robo" "and ana holds what it posted"
UP=$(tool "$A" sa crosstalk_people '{"action":"trust","who":"robo","level":"deliver"}')
has "$UP" "never above" "robo cannot be raised above notify"
SHIP=$(rpc "$A" '{"op":"ship","sessionId":"sa","action":"ready","peer":"robo"}')
has "$SHIP" "robo is an agent" "shipping refuses to act for robo"
SPAWN=$(CROSSTALK_HOME="$A" bun -e '
  const s = await import("./src/spawn.ts"); const r = await import("./src/restore.ts"); const g = await import("./src/gather.ts")
  console.log([s.spawnAgents({ task: "x", cwd: "/tmp", peer: "robo" }).text, r.restore({ userAction: false, peer: "robo" }).text, g.start({ peer: "robo" }).text].join(" | "))')
has "$SPAWN" "never start an agent" "spawn refuses robo"
has "$SPAWN" "never resume a session" "restore refuses robo"
has "$SPAWN" "never restart sessions" "gather refuses robo"

# --- 4. @ shortcut --------------------------------------------------------------------
echo
echo "4. @auth answers the card about auth"
rpc "$B" '{"op":"send","sessionId":"sb","to":"ana","text":"can I drop v1?","intent":"question","thread":"auth"}' >/dev/null
for _ in $(seq 1 30); do rpc "$A" '{"op":"ui","sessionId":"sa"}' | grep -q '"thread":"auth"' && break; sleep 0.5; done
AT=$(CROSSTALK_HOME="$A" bun src/cli.ts ui at --session sa --text "@auth not yet, keep it until 0.2")
has "$AT" '"handled":true' "the shortcut is taken"
has "$AT" '"drop":"crosstalk: answer sent to auth"' "its drop reason names the thread"
hasnt "$AT" '"drop":"crosstalk: answer sent to auth: not yet' "and not the text"
for _ in $(seq 1 30); do rpc "$B" '{"op":"read","sessionId":"sb"}' | grep -q "keep it until 0.2" && break; sleep 0.5; done
has "$(rpc "$B" '{"op":"read","sessionId":"sb","all":true}')" "keep it until 0.2" "ben got the answer"
MAIN=$(CROSSTALK_HOME="$A" bun src/cli.ts ui at --session sa --text "@main")
has "$MAIN" '"handled":true' "@main is taken"
has "$(cat "$A/main.json")" '"sessionId":"sa"' "and makes this session main"
NOPE=$(CROSSTALK_HOME="$A" bun src/cli.ts ui at --session sa --text "@nobody hello")
has "$NOPE" '"handled":false' "@ a name crosstalk does not know is left alone"

# --- 5. doctor ------------------------------------------------------------------------
echo
echo "5. the doctor notices a broken relay at SessionStart, once"
cp "$A/identity.json" "$D/identity.json"; cp "$A/peers.json" "$D/peers.json"
echo '{"url":"ws://127.0.0.1:9"}' >"$D/relay.json"
start() { echo "{\"hook_event_name\":\"SessionStart\",\"session_id\":\"$1\",\"cwd\":\"/tmp\",\"source\":\"startup\"}" | CROSSTALK_HOME="$D" CLAUDE_CODE_MESSAGING_SOCKET= bun src/hook.ts 2>/dev/null; }
S1=$(start sd1)
has "$S1" "crosstalk found a problem" "the first session start says something is wrong"
has "$S1" "To fix it" "with the fix"
S2=$(start sd2)
hasnt "$S2" "crosstalk found a problem" "the second one says nothing"
DOC=$(tool "$D" sd1 crosstalk_doctor '{"action":"report"}')
has "$DOC" "relay" "crosstalk_doctor returns the whole report"
stop_daemon "$D"

# --- 6. digest, standup, pane -------------------------------------------------------------
echo
echo "6. digest, standup and the pane, from fixture threads"
CROSSTALK_HOME="$E" bun -e '
  const M = await import("./src/threads/model.ts"); const fs = await import("node:fs"); const path = await import("node:path")
  const now = Date.now(), P = "aaaa-aaaa-aaaa-aaaa", Q = "bbbb-bbbb-bbbb-bbbb"
  const t = M.create({ id: "0123456789abcdef", name: "auth", repo: "github.com/acme/api", by: P, label: "paul", now: now - 86400000 })
  M.put(t, "people", Q, { label: "marie" }, P, now)
  M.setRecap(t, P, "PANE-RECAP-CANARY moving tokens to v2", now)
  M.put(t, "notes", "d1", { kind: "decision", text: "v1 tokens accepted until 0.2", who: "paul", at: now - 3600000 }, P, now)
  M.put(t, "features", "v2", { name: "v2 token format", risk: "risky", flag: "auth-v2", ship: { state: "merged", stage: "internal", merged: { sha: "a", at: now - 600000, files: [], shas: [], how: "pr" } } }, P, now)
  M.put(t, "notes", "k1", { kind: "task", text: "write the migration note", who: "marie", at: now - 1000, state: "done", doneBy: "marie" }, Q, now)
  fs.mkdirSync(process.env.CROSSTALK_HOME, { recursive: true })
  fs.writeFileSync(path.join(process.env.CROSSTALK_HOME, "threads.json"), JSON.stringify({ v: 1, threads: { [t.id]: t }, placed: { se: { threads: [t.id], why: {} } } }))'
DIG=$(tool "$E" se crosstalk_thread '{"action":"digest","since":"2d"}')
has "$DIG" "paul decided v1 tokens accepted until 0.2" "the digest has the decision"
has "$DIG" "merged v2 token format" "and the merge"
STAND=$(tool "$E" se crosstalk_thread '{"action":"standup"}')
has "$STAND" "shipped: v2 token format" "the standup has what paul shipped"
has "$STAND" "finished: write the migration note" "and what marie finished"
PANE=$(tool "$E" se crosstalk_look '{"action":"pane","thread":"auth"}')
has "$PANE" "auth" "crosstalk_pane answers"
hasnt "$PANE" "PANE-RECAP-CANARY" "without a word of what the pane shows"
hasnt "$PANE" "v1 tokens accepted" "nor its decisions"
PJSON=$(CROSSTALK_HOME="$E" bun src/cli.ts ui pane --session se --thread auth)
has "$PJSON" "PANE-RECAP-CANARY" "the pane itself, for the mod, has the thread"
has "$PJSON" '"flag":"auth-v2","stage":"internal"' "with the feature's flag stage"
stop_daemon "$E"

echo
[ $FAILED -eq 0 ] && echo "uiextra: all $PASSES passed" || { echo "uiextra: FAILED"; exit 1; }
