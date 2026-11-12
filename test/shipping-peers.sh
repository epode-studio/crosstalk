#!/usr/bin/env bash
# A shipping question answered from another person's machine, over a real relay.
#
#   bash test/shipping-peers.sh
#
# ana and ben share a direct channel on a local relay, and work on the same
# branch of one repo, so they are in one thread. The feature is ana's: her
# daemon reviews it (stub reviewers), checks it and asks. The questions go
# onto the thread, and reach ben's machine like any thread item:
#
#   1. ben sees ana's merge question, in `ship questions` and as a picker
#   2. an agent on ben's machine cannot answer it
#   3. ben answers in his terminal: signed, sent, and taken on ana's machine,
#      which merges
#   4. the next flag step is answered through ben's picker; ana's flags move

set -u
export CROSSTALK_NO_GATHER=1 CROSSTALK_NO_RESTORE=1
export CROSSTALK_THREAD_SETTLE_MS=300 CROSSTALK_THREAD_SYNC_MS=600000 CROSSTALK_THREADS_NO_PUSH=1
export CROSSTALK_SHIP_VOTE_MS=300
cd "$(dirname "$0")/.."
ROOT=$(pwd)
# The reviewers' wrappers call back with this source's crosstalk, not the prebuilt bundle.
export CROSSTALK_BIN="bun $ROOT/src/cli.ts"
PORT=${PEERS_PORT:-8891}
TMP=$(mktemp -d)
A="$TMP/a"; B="$TMP/b"; R="$TMP/repos"
export TMUX_TMPDIR="$TMP/tmux"
export GIT_AUTHOR_NAME=t GIT_AUTHOR_EMAIL=t@t GIT_COMMITTER_NAME=t GIT_COMMITTER_EMAIL=t@t
unset TMUX TMUX_PANE CLAUDE_CODE_SESSION_ID CLAUDECODE CLAUDE_CODE_MESSAGING_SOCKET
FAILED=0
PASSES=0
pass() { echo "  PASS  $1"; PASSES=$((PASSES+1)); }
fail() { echo "  FAIL  $1"; FAILED=1; }
check() { if [ "$1" = "$2" ]; then pass "$3"; else fail "$3 (wanted '$2', got '$1')"; fi; }
has() { case "$1" in *"$2"*) pass "$3" ;; *) fail "$3"; echo "        got: $1" | head -c 1200; echo ;; esac; }
stop_daemon() {
  if [ -f "$1/daemon.lock" ]; then
    P=$(cat "$1/daemon.lock")
    kill "$P" 2>/dev/null
    for _ in $(seq 1 30); do kill -0 "$P" 2>/dev/null || break; sleep 0.2; done
  fi
  rm -f "$1/daemon.sock" "$1/daemon.lock"
}
start_daemon() { CROSSTALK_HOME="$1" nohup bun src/daemon.ts >>"$2" 2>&1 & }
rpc() { CROSSTALK_HOME="$1" bun -e '
  const { request } = await import("./src/client.ts")
  console.log(JSON.stringify(await request(JSON.parse(process.argv[1]), 60000)))
' "$2" 2>&1; }
field() { echo "$1" | bun -e 'const r = JSON.parse(await Bun.stdin.text()); const v = (0, eval)("(r) => " + process.argv[1])(r); console.log(typeof v === "string" ? v : JSON.stringify(v ?? null))' "$2"; }
ct() { local h=$1; shift; CROSSTALK_HOME="$h" bun "$ROOT/src/cli.ts" "$@"; }
wait_for() {
  local n=$1; shift
  for _ in $(seq 1 $((n * 4))); do
    v=$("$@" 2>/dev/null)
    [ -n "$v" ] && [ "$v" != "null" ] && { echo "$v"; return; }
    sleep 0.25
  done
  echo ""
}
RELAY_PID=""
cleanup() {
  stop_daemon "$A"; stop_daemon "$B"
  [ -n "$RELAY_PID" ] && kill "$RELAY_PID" 2>/dev/null
  tmux -L crosstalk kill-server 2>/dev/null
  rm -rf "$TMP"
}
trap cleanup EXIT
mkdir -p "$TMP/relay" "$A" "$B" "$R" "$TMP/bin" "$TMUX_TMPDIR"
echo "state in $TMP"

# Stub reviewers that approve.
printf '#!/bin/sh\nprintf "VERDICT: approve\\nFINDINGS:\\nnone\\n"\n' >"$TMP/bin/claude"
printf '#!/bin/sh\nprintf "VERDICT: approve\\nFINDINGS:\\nnone\\n" >"$4"\n' >"$TMP/bin/codex"
chmod +x "$TMP/bin/claude" "$TMP/bin/codex"
export PATH="$TMP/bin:$PATH"

# --- one repo: ana has the work, ben the same branch -----------------------------------
g() { git -C "$1" "${@:2}"; }
git init -q --bare -b main "$R/remote.git"
git clone -q "$R/remote.git" "$R/seed" 2>/dev/null
g "$R/seed" checkout -q -b main
mkdir -p "$R/seed/.crosstalk" "$R/seed/src/auth"
printf 'test: true\npush: local\nramp: internal on\n' >"$R/seed/.crosstalk/ship"
printf 'high: src/auth/**\n' >"$R/seed/.crosstalk/risk"
echo "export const login = 1" >"$R/seed/src/auth/login.ts"
g "$R/seed" add -A && g "$R/seed" commit -qm init && g "$R/seed" push -q origin main 2>/dev/null
git clone -q "$R/remote.git" "$R/ana" 2>/dev/null
g "$R/ana" remote set-head origin main
g "$R/ana" checkout -q -b crosstalk/login
echo "export const login = (p) => check(p)" >"$R/ana/src/auth/login.ts"
g "$R/ana" add -A && g "$R/ana" commit -qm "login v2"
git clone -q "$R/remote.git" "$R/ben" 2>/dev/null
g "$R/ben" checkout -q -b crosstalk/login

# --- relay and a direct channel ------------------------------------------------------------
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
stop_daemon "$A"; stop_daemon "$B"
start_daemon "$A" "$TMP/da.log"
start_daemon "$B" "$TMP/db.log"
for _ in $(seq 1 40); do [ -S "$A/daemon.sock" ] && [ -S "$B/daemon.sock" ] && break; sleep 0.25; done
sleep 2

reg() { rpc "$1" "{\"op\":\"register\",\"sessionId\":\"$2\",\"pid\":1,\"name\":\"$2\",\"cwd\":\"$3\",\"socket\":\"\",\"touched\":${4:-[]}}" >/dev/null; }
reg "$A" a-login "$R/ana" '["src/auth/login.ts"]'
sleep 0.5
reg "$B" b-login "$R/ben" '["src/auth/login.ts"]'
ids_of() { field "$(rpc "$1" "{\"op\":\"threads\",\"sessionId\":\"$2\"}")" 'r.threads.map(t => t.id).join(",")'; }
same() { a=$(ids_of "$A" a-login); b=$(ids_of "$B" b-login); [ -n "$a" ] && [ "$a" = "$b" ] && echo "$a"; }
TID=$(wait_for 15 same)
[ -n "$TID" ] && pass "ana and ben are in one thread" || { fail "ana and ben are in one thread"; tail -20 "$TMP/da.log"; exit 1; }

ship() { rpc "$A" "{\"op\":\"ship\",\"sessionId\":\"a-login\",\"cwd\":\"$R/ana\",$1}"; }
state_of() { field "$(rpc "$A" '{"op":"ship","action":"status"}')" "r.threads.flatMap(t => t.features).find(f => f.name === 'login v2')?.state"; }
until_state() { for _ in $(seq 1 120); do [ "$(state_of)" = "$1" ] && { echo "$1"; return; }; sleep 0.25; done; state_of; }
ben_q() { field "$(rpc "$B" '{"op":"ship","action":"questions"}')" "r.questions.filter(q => q.elsewhere && q.kind === '$1').map(q => q.id).join(' ')"; }
ben_items() { field "$(rpc "$B" '{"op":"ui","sessionId":"b-login"}')" "r.items.filter(i => i.kind === 'ship' && i.state === 'pending').map(i => i.id).join(' ')"; }

# --- ana's risky feature, up to its merge question ------------------------------------------
echo
echo "ana's feature asks"
check "$(field "$(ship '"action":"feature","name":"login v2"')" 'r.risk')" "risky" "login v2 is risky"
ship '"action":"ready","feature":"login v2"' >/dev/null
# Running the repo's commands on ana's machine is ana's to allow, once; ben is not even shown it.
ana_cmds() { field "$(rpc "$A" '{"op":"ship","action":"questions"}')" "r.questions.filter(q => q.kind === 'commands' && !q.elsewhere).map(q => q.id).join(' ')"; }
CQ=$(wait_for 15 ana_cmds)
[ -n "$CQ" ] && pass "ana is asked once to allow the repo's commands" || fail "ana is asked once to allow the repo's commands"
check "$(field "$(rpc "$B" '{"op":"ship","action":"questions"}')" "r.questions.filter(q => q.kind === 'commands').length")" "0" "ben is not asked about ana's machine"
ct "$A" ship answer "$CQ" "Run them" >/dev/null 2>&1
check "$(until_state needs-evidence)" "needs-evidence" "reviewed, green, waiting for evidence"
EV=$(ship '"action":"evidence","feature":"login v2","summary":"Login rejects empty passwords now.","tests":["login.test: 6 pass"]')
QID=$(field "$EV" 'r.question')
[ -n "$QID" ] && [ "$QID" != "null" ] && pass "the merge is a question on ana's machine" || fail "the merge is a question ($EV)"

# --- 1. ben sees it --------------------------------------------------------------------------------
echo
echo "on ben's machine"
check "$(wait_for 15 ben_q merge)" "$QID" "ben's machine has ana's merge question"
has "$(field "$(rpc "$B" '{"op":"ship","action":"questions"}')" "r.questions.find(q => q.id === '$QID')?.text")" "Login rejects empty passwords" "with its evidence"
has "$(wait_for 10 ben_items)" "ship:$QID:b-login" "and as a picker in ben's session"

# --- 2. not an agent --------------------------------------------------------------------------------
AG=$(CLAUDECODE=1 ct "$B" ship answer "$QID" "Merge it" 2>&1)
has "$AG" "for a person" "an agent on ben's machine cannot answer it"
AT=$(rpc "$B" "{\"op\":\"thread\",\"sessionId\":\"b-login\",\"cwd\":\"$R/ben\",\"answer\":{\"id\":\"$QID\",\"text\":\"Merge it\"}}")
has "$AT" "a person answers it" "nor can ben's agent's crosstalk_work"
check "$(state_of)" "awaiting-merge" "ana's feature is still waiting"

# --- 3. ben answers in his terminal ------------------------------------------------------------------
YES=$(ct "$B" ship answer "$QID" "Merge it" 2>&1)
has "$YES" "on its way to ana" "ben's answer is signed and sent to ana's machine"
check "$(until_state merged)" "merged" "ana's machine takes it and merges"
check "$(g "$R/ana" merge-base --is-ancestor crosstalk/login main && echo in || echo out)" "in" "the branch is in ana's main"
TA=$(rpc "$A" '{"op":"thread_read","sessionId":"a-login"}')
has "$(field "$TA" "r.threads[0].questions.find(q => q.id === '$QID')?.answeredBy")" "ben" "the thread says ben answered it"
has "$(field "$TA" 'r.threads[0].notes.filter(n => n.kind === "decision").map(d => d.text).join(";")')" "ben agreed to merge login v2" "and the decision is ben's"
gone() { case " $(ben_items) " in *" ship:$QID:b-login "*) ;; *) echo gone ;; esac; }
check "$(wait_for 10 gone)" "gone" "ben's picker comes down"

# --- 4. the next step, through ben's picker --------------------------------------------------------------
echo
echo "a flag step through ben's picker"
RQ=$(wait_for 15 ben_q ramp)
[ -n "$RQ" ] && pass "the step to internal reaches ben" || fail "the step to internal reaches ben"
ITEM=$(wait_for 10 ben_items)
check "$ITEM" "ship:$RQ:b-login" "as a picker"
UA=$(ct "$B" ui act --session b-login --id "$ITEM" --action answer --value "Turn it up to internal" 2>&1)
has "$UA" "on its way" "ben answers in the picker"
flag_internal() { g "$R/ana" show main:.crosstalk/flags 2>/dev/null | grep -o "login-v2: internal"; }
check "$(wait_for 15 flag_internal)" "login-v2: internal" "ana's flags file says internal"

echo
if [ "$FAILED" = 0 ]; then echo "shipping-peers: all $PASSES passed"; else echo "shipping-peers: FAILED ($PASSES passed)"; tail -25 "$TMP/da.log"; echo ---; tail -15 "$TMP/db.log"; fi
exit $FAILED
