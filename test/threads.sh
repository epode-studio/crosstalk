#!/usr/bin/env bash
# Threads, found automatically, between two people over a real relay.
#
#   bash test/threads.sh
#
# ana and ben share a direct channel on a local relay. Their repos are real
# clones of one bare "remote", so the thread ref is pushed and fetched for
# real. Every session is pull mode (no inbox socket), so what landed where is
# read straight back with the read op, as test/routing.sh does.
#
#   1. both on token-v2              one thread, both people, both sessions
#   2. a message with no recipient   reaches only ana's session in that thread
#   3. a decision                    is on ben's side at once, then on the ref,
#                                    sealed; a fresh replica reads it from a fetch
#   4. a different branch            a second thread
#   5. files converge                the two combine, and both are told

set -u
export CROSSTALK_NO_GATHER=1 CROSSTALK_NO_RESTORE=1
export CROSSTALK_THREAD_SETTLE_MS=300 CROSSTALK_THREAD_SYNC_MS=600000
cd "$(dirname "$0")/.."
ROOT=$(pwd)
PORT=${PORT:-8896}
TMP=$(mktemp -d)
A="$TMP/a"; B="$TMP/b"; R="$TMP/repos"
FAILED=0
PASSES=0

pass() { echo "  PASS  $1"; PASSES=$((PASSES+1)); }
fail() { echo "  FAIL  $1"; FAILED=1; }
check() { if [ "$1" = "$2" ]; then pass "$3"; else fail "$3 (wanted '$2', got '$1')"; fi; }
has() { case "$1" in *"$2"*) pass "$3" ;; *) fail "$3"; echo "        got: $1" | head -c 800; echo ;; esac; }
hasnt() { case "$1" in *"$2"*) fail "$3"; echo "        got: $1" | head -c 800; echo ;; *) pass "$3" ;; esac; }
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
  console.log(JSON.stringify(await request(JSON.parse(process.argv[1]))))
' "$2" 2>&1; }
# One field out of a JSON answer, by a JS expression over `r`.
field() { echo "$1" | bun -e 'const r = JSON.parse(await Bun.stdin.text()); const v = (0, eval)("(r) => " + process.argv[1])(r); console.log(typeof v === "string" ? v : JSON.stringify(v ?? null))' "$2"; }
RELAY_PID=""
cleanup() {
  stop_daemon "$A"; stop_daemon "$B"
  [ -n "$RELAY_PID" ] && kill "$RELAY_PID" 2>/dev/null
  rm -rf "$TMP"
}
trap cleanup EXIT

mkdir -p "$TMP/relay" "$A" "$B" "$R"
echo "state in $TMP"

# --- repos: one bare remote, a clone per session ----------------------------------
g() { git -C "$1" -c user.email=t@t -c user.name=t "${@:2}"; }
git init -q --bare -b main "$R/remote.git"
git clone -q "$R/remote.git" "$R/seed" 2>/dev/null
g "$R/seed" commit -q --allow-empty -m init
g "$R/seed" push -q origin main
clone() { # dir branch
  git clone -q "$R/remote.git" "$1" 2>/dev/null
  [ "$2" = main ] || g "$1" checkout -q -b "$2"
}
clone "$R/ana-feat" token-v2
clone "$R/ana-main" main
clone "$R/ben-feat" token-v2
clone "$R/ana-bill" billing
clone "$R/ben-bill" billing-v2

# --- relay and a direct channel -----------------------------------------------------
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

reg() { # home session dir [touched json array]
  rpc "$1" "{\"op\":\"register\",\"sessionId\":\"$2\",\"pid\":1,\"name\":\"$2\",\"cwd\":\"$3\",\"socket\":\"\",\"touched\":${4:-[]}}" >/dev/null
}
threads_of() { rpc "$1" "{\"op\":\"threads\",\"sessionId\":\"$2\"}"; }
ids_of() { field "$(threads_of "$1" "$2")" 'r.threads.map(t => t.id).join(",")'; }
names_of() { field "$(threads_of "$1" "$2")" 'r.threads.map(t => t.name).join(",")'; }
# Which of ana's sessions hold a message with this text.
where() {
  out=""
  for s in a-feat a-main a-bill; do
    case "$(rpc "$A" "{\"op\":\"read\",\"sessionId\":\"$s\",\"all\":true}")" in
      *"$1"*) out="$out $s" ;;
    esac
  done
  echo "${out# }"
}
wait_for() { # seconds command... : until the command prints something non-empty
  local n=$1; shift
  for _ in $(seq 1 $((n * 4))); do
    v=$("$@")
    [ -n "$v" ] && [ "$v" != "null" ] && { echo "$v"; return; }
    sleep 0.25
  done
  echo ""
}

# --- 1. same branch, one thread --------------------------------------------------------
echo
echo "both on token-v2"
reg "$A" a-feat "$R/ana-feat" '["src/auth/token.ts"]'
reg "$A" a-main "$R/ana-main"
sleep 0.5
reg "$B" b-feat "$R/ben-feat" '["src/auth/parse.ts"]'
same() { a=$(ids_of "$A" a-feat); b=$(ids_of "$B" b-feat); [ -n "$a" ] && [ "$a" = "$b" ] && echo "$a"; }
TID=$(wait_for 10 same)
[ -n "$TID" ] && pass "ana's and ben's sessions are in one thread ($TID)" || fail "they are in one thread (ana: $(ids_of "$A" a-feat), ben: $(ids_of "$B" b-feat))"
check "$(names_of "$A" a-feat)" "token-v2" "named from the branch"
check "$(names_of "$A" a-main)" "" "a session on main with nothing touched is in no thread"
T=$(rpc "$A" '{"op":"thread_read","sessionId":"a-feat"}')
check "$(field "$T" 'r.threads[0].people.sort().join(",")')" "ana,ben" "the thread found its people"
check "$(field "$T" 'r.threads[0].sessions.sort().join(",")')" "ana/a-feat @ token-v2,ben/b-feat @ token-v2" "and both sessions"
TH=$(rpc "$A" '{"op":"threads","sessionId":"a-feat","consume":true}')
has "$(field "$TH" 'r.banner.join(";")')" "token-v2 (new branch token-v2)" "the banner says which thread was joined and why"
check "$(field "$TH" 'r.title')" "token-v2 · a-feat" "the session title leads with the thread"
has "$(field "$TH" 'r.notes.join(";")')" "ben joined token-v2" "ana is told ben can now read it"

# --- 1b. a thread's task, finished from a session not in that thread ----------------------------
# The Stop hook keeps an Open list's items in the thread of the session's folder, which
# need not be a thread the session that later finishes them is in.
echo
echo "a thread's task finished from outside it"
TA=$(rpc "$A" "{\"op\":\"tasks\",\"sessionId\":\"a-feat\",\"cwd\":\"$R/ana-feat\",\"write\":\"add\",\"text\":\"wire the retry\"}")
has "$TA" '"thread":"token-v2"' "a task added in token-v2"
TK=$(field "$TA" 'r.id')
TC=$(rpc "$A" "{\"op\":\"tasks\",\"sessionId\":\"a-main\",\"cwd\":\"$R/ana-main\",\"write\":\"claim\",\"id\":\"$TK\"}")
has "$TC" '"ok":true' "a session in no thread can claim it"
TD=$(rpc "$A" "{\"op\":\"tasks\",\"sessionId\":\"a-main\",\"cwd\":\"$R/ana-main\",\"write\":\"done\",\"id\":\"$TK\",\"note\":\"landed\"}")
has "$TD" '"ok":true' "and mark it done"
has "$TD" '"thread":"token-v2"' "in the thread that holds it"
check "$(field "$(rpc "$A" '{"op":"thread_read","sessionId":"a-feat"}')" "r.threads[0].notes.find(n => n.id === '$TK')?.state")" "done" "the thread shows it done"
NONE=$(rpc "$A" "{\"op\":\"tasks\",\"sessionId\":\"a-main\",\"cwd\":\"$R/ana-main\",\"write\":\"done\",\"id\":\"t_0000000000\"}")
has "$NONE" "no open task t_0000000000" "an unknown id says so, rather than nothing"

# --- 2. talking per thread ----------------------------------------------------------------
echo
echo "a message with no recipient"
S=$(rpc "$B" "{\"op\":\"send\",\"sessionId\":\"b-feat\",\"cwd\":\"$R/ben-feat\",\"text\":\"token format v2 landed\",\"intent\":\"fyi\"}")
has "$S" '"sentTo":["ana"]' "ben's send went to the people in his thread"
has "$S" '"threads":"token-v2"' "and says which thread"
sleep 2
check "$(where "token format v2 landed")" "a-feat" "it reached only ana's session in the thread"
has "$(rpc "$A" '{"op":"read","sessionId":"a-feat","all":true}')" '"auto":true' "marked for the agent, being about its own thread"
has "$(cat "$TMP/da.log")" "→ a-feat [thread]" "and the log says it was routed by thread"
NOREC=$(rpc "$A" "{\"op\":\"send\",\"sessionId\":\"a-main\",\"cwd\":\"$R/ana-main\",\"text\":\"x\"}")
has "$NOREC" "in no thread yet" "a session in no thread is told to name someone"

# --- 3. a decision, live then on the ref -------------------------------------------------------
echo
echo "a decision"
D=$(rpc "$A" "{\"op\":\"decide\",\"sessionId\":\"a-feat\",\"cwd\":\"$R/ana-feat\",\"text\":\"v1 tokens accepted until 0.2\"}")
has "$D" '"thread":"token-v2"' "recorded in the thread"
[ -f "$R/ana-feat/DECISIONS.md" ] && fail "and not in DECISIONS.md" || pass "and not in DECISIONS.md"
live() { field "$(rpc "$B" '{"op":"thread_read","sessionId":"b-feat"}')" 'r.threads[0].notes.filter(n => n.kind === "decision").map(d => d.text).join(";")'; }
check "$(wait_for 5 live)" "v1 tokens accepted until 0.2" "ben has it at once, over the relay"
onremote() { git --git-dir="$R/remote.git" rev-parse -q --verify refs/crosstalk/threads 2>/dev/null; }
[ -n "$(wait_for 10 onremote)" ] && pass "the ref was pushed to the remote" || fail "the ref was pushed to the remote"
BLOBS=$(git --git-dir="$R/remote.git" ls-tree refs/crosstalk/threads | awk '{print $3}' | xargs -n1 git --git-dir="$R/remote.git" cat-file blob 2>/dev/null)
has "$BLOBS" "sealed: true" "the thread file is sealed"
hasnt "$BLOBS" "v1 tokens accepted" "and the decision is not readable in it"
hasnt "$BLOBS" "token-v2" "nor the thread's name"
check "$(git -C "$R/ana-feat" status --porcelain)" "" "ana's working tree and index are untouched"
has "$(git -C "$R/ana-feat" config --get-all remote.origin.fetch)" "+refs/crosstalk/threads:refs/crosstalk/sync/threads" "the refspec was added to ana's remote"
check "$(git -C "$R/ana-feat" rev-parse --abbrev-ref HEAD)" "token-v2" "and HEAD is where it was"
[ -f "$R/ana-feat/THREADS.md" ] && fail "no THREADS.md for a sealed thread" || pass "no THREADS.md for a sealed thread"
git -C "$R/ben-feat" fetch -q origin
has "$(git -C "$R/ben-feat" ls-tree refs/crosstalk/sync/threads 2>&1)" ".md" "a plain fetch in ben's clone brings the ref, into crosstalk's side ref"
# ben's daemon forgets every thread and starts again: the ref is all it has.
stop_daemon "$B"
rm -f "$B/threads.json"
start_daemon "$B" "$TMP/db.log"
for _ in $(seq 1 40); do [ -S "$B/daemon.sock" ] && break; sleep 0.25; done
fromref() { field "$(rpc "$B" '{"op":"thread_read","sessionId":"b-feat"}')" 'r.threads.flatMap(t => t.notes.filter(n => n.kind === "decision").map(d => d.text)).join(";")'; }
check "$(wait_for 10 fromref)" "v1 tokens accepted until 0.2" "a replica that knew nothing reads the sealed decision back from the ref"
check "$(grep -c 'thread token-v2 started for b-feat' "$TMP/db.log")" "1" "and joins that thread rather than starting another"
sleep 2

# --- 4. a different branch ---------------------------------------------------------------------
echo
echo "a different branch"
reg "$A" a-bill "$R/ana-bill" '["src/billing/invoice.ts","src/billing/tax.ts"]'
sleep 1
BILL=$(ids_of "$A" a-bill)
check "$(names_of "$A" a-bill)" "billing" "billing is a thread of its own"
[ -n "$BILL" ] && [ "$BILL" != "$TID" ] && pass "a second thread, not token-v2" || fail "a second thread ($BILL vs $TID)"
reg "$B" b-bill "$R/ben-bill" '["src/reports/summary.ts"]'
sleep 2
BILL2=$(ids_of "$B" b-bill)
check "$(names_of "$B" b-bill)" "billing-v2" "ben's billing-v2 is another"
[ "$BILL2" != "$BILL" ] && pass "not yet billing: different branch, different files" || fail "kept apart while their work differs"

# --- 5. converging -----------------------------------------------------------------------------
echo
echo "the work converges"
reg "$B" b-bill "$R/ben-bill" '["src/billing/invoice.ts","src/billing/tax.ts"]'
merged() { a=$(ids_of "$A" a-bill); b=$(ids_of "$B" b-bill); [ -n "$a" ] && [ "$a" = "$b" ] && echo "$a"; }
M=$(wait_for 10 merged)
check "$M" "$BILL" "billing-v2 combined into billing, the older"
NB=$(rpc "$B" '{"op":"threads","sessionId":"b-bill","consume":true}')
has "$(field "$NB" 'r.notes.join(";")')" "combined into billing" "ben is told the threads combined"
NA=$(rpc "$A" '{"op":"threads","sessionId":"a-bill","consume":true}')
has "$(field "$NA" 'r.notes.join(";")')" "ben joined billing" "ana is told who can now read it"
check "$(field "$(rpc "$B" '{"op":"thread_read","sessionId":"b-bill"}')" 'r.threads[0].people.sort().join(",")')" "ana,ben" "everyone in either is in the combined thread"

echo
[ $FAILED -eq 0 ] && echo "threads: all $PASSES passed" || { echo "threads: failures"; tail -40 "$TMP/da.log"; echo ---; tail -40 "$TMP/db.log"; }
exit $FAILED
