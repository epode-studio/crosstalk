#!/usr/bin/env bash
# The main session, answers becoming rules, agents warning each other, and
# first use per repo, between two people over a real relay.
#
#   bash test/next.sh
#
# ana and ben share a direct channel on a local relay. Their clones share one
# bare "remote", so the thread ref (and RULES.md on it) is pushed and fetched
# for real. Sessions are pull mode, so what landed where is read back with the
# read and ui ops.
#
#   1. main session      a question from ben's billing thread reaches ana's main
#                        session and not her working one
#   2. rules             ana answers the same question the same way twice, says
#                        "always": a sealed RULES.md on the ref, and the third
#                        time it is answered by itself, for ben and for ana
#   3. heads-up          ana's edit (through the real hook) to a file ben's
#                        billing session works on reaches that session, diff
#                        attached
#   4. conflict          ben edits the same function: both agents get a
#                        conflict frame naming the other, and agree
#   5. first use         a machine with no identity is asked once per repo,
#                        nothing is pushed before yes, and yes publishes

set -u
export CROSSTALK_NO_GATHER=1 CROSSTALK_NO_RESTORE=1 CROSSTALK_NO_REPOTRUST=1
export CROSSTALK_THREAD_SETTLE_MS=300 CROSSTALK_THREAD_SYNC_MS=600000 CROSSTALK_WARN_RATE_MS=0
cd "$(dirname "$0")/.."
ROOT=$(pwd)
PORT=${PORT:-8897}
TMP=$(mktemp -d)
A="$TMP/a"; B="$TMP/b"; Cc="$TMP/c"; R="$TMP/repos"; SSH="$TMP/ssh"; KEYS="$TMP/keys"
FAILED=0
PASSES=0

pass() { echo "  PASS  $1"; PASSES=$((PASSES+1)); }
fail() { echo "  FAIL  $1"; FAILED=1; }
check() { if [ "$1" = "$2" ]; then pass "$3"; else fail "$3 (wanted '$2', got '$1')"; fi; }
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
start_daemon() { CROSSTALK_HOME="$1" nohup bun src/daemon.ts >>"$2" 2>&1 & }
rpc() { CROSSTALK_HOME="$1" bun -e '
  const { request } = await import("./src/client.ts")
  console.log(JSON.stringify(await request(JSON.parse(process.argv[1]), 60000)))
' "$2" 2>&1; }
field() { echo "$1" | bun -e 'const r = JSON.parse(await Bun.stdin.text()); const v = (0, eval)("(r) => " + process.argv[1])(r); console.log(typeof v === "string" ? v : JSON.stringify(v ?? null))' "$2"; }
wait_for() { # seconds command...
  local n=$1; shift
  for _ in $(seq 1 $((n * 4))); do
    v=$("$@")
    [ -n "$v" ] && [ "$v" != "null" ] && [ "$v" != "false" ] && { echo "$v"; return; }
    sleep 0.25
  done
  echo ""
}
RELAY_PID=""; STUB_PID=""
cleanup() {
  stop_daemon "$A"; stop_daemon "$B"; stop_daemon "$Cc"
  [ -n "$RELAY_PID" ] && kill "$RELAY_PID" 2>/dev/null
  [ -n "$STUB_PID" ] && kill "$STUB_PID" 2>/dev/null
  rm -rf "$TMP"
}
trap cleanup EXIT

mkdir -p "$TMP/relay" "$A" "$B" "$Cc" "$R" "$SSH" "$KEYS"
echo "state in $TMP"

# --- repos -------------------------------------------------------------------------
g() { git -C "$1" -c user.email=t@t -c user.name=t "${@:2}"; }
git init -q --bare -b main "$R/remote.git"
git clone -q "$R/remote.git" "$R/seed" 2>/dev/null
mkdir -p "$R/seed/src/shared"
printf 'export function parse(s: string) {\n  return s.trim()\n}\n\nexport function format(n: number) {\n  return String(n)\n}\n' >"$R/seed/src/shared/util.ts"
g "$R/seed" add .
g "$R/seed" commit -q -m init
g "$R/seed" push -q origin main
clone() { git clone -q "$R/remote.git" "$1" 2>/dev/null; [ "$2" = main ] || g "$1" checkout -q -b "$2"; }
clone "$R/ana-auth" auth
clone "$R/ana-main" main
clone "$R/ben-auth" auth
clone "$R/ben-bill" billing

# --- relay and a direct channel ---------------------------------------------------
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

reg() { # home session dir [touched]
  rpc "$1" "{\"op\":\"register\",\"sessionId\":\"$2\",\"pid\":1,\"name\":\"$2\",\"cwd\":\"$3\",\"socket\":\"\",\"touched\":${4:-[]}}" >/dev/null
}
ids_of() { field "$(rpc "$1" "{\"op\":\"threads\",\"sessionId\":\"$2\"}")" 'r.threads.map(t => t.id).join(",")'; }
read_all() { rpc "$1" "{\"op\":\"read\",\"sessionId\":\"$2\",\"all\":true}"; }
ui_of() { rpc "$1" "{\"op\":\"ui\",\"sessionId\":\"$2\"}"; }

# --- 1. main session ------------------------------------------------------------------
echo
echo "a main session"
reg "$A" a-auth "$R/ana-auth" '["src/auth/login.ts"]'
reg "$A" a-main "$R/ana-main"
reg "$B" b-bill "$R/ben-bill" '["src/billing/invoice.ts","src/billing/tax.ts","src/shared/util.ts"]'
MAIN=$(rpc "$A" '{"op":"main","sessionId":"a-main"}')
has "$MAIN" "This is your main session now" "\"make this my main session\" makes a-main main"
check "$(ids_of "$A" a-main)" "" "main is in no thread"
sleep 1
S=$(rpc "$B" "{\"op\":\"send\",\"sessionId\":\"b-bill\",\"cwd\":\"$R/ben-bill\",\"to\":\"ana\",\"text\":\"which currency should invoices default to?\",\"intent\":\"question\"}")
has "$S" '"ok":true' "ben asks ana a question from his billing thread"
# ben's billing thread is none of ana's, so the question is cross-cutting: main's.
routed() { field "$(ui_of "$A" a-main)" 'r.items.filter(i => i.kind === "route" && i.from === "ben").map(i => i.id)[0]'; }
RID=$(wait_for 10 routed)
[ -n "$RID" ] && pass "the cross-thread question is put to ana's main session" || fail "the cross-thread question is put to ana's main session"
UW=$(ui_of "$A" a-auth)
check "$(field "$UW" 'r.items.filter(i => i.from === "ben").length')" "0" "and not to her working session"
hasnt "$(read_all "$A" a-auth)" "which currency" "whose agent never sees it"
UM=$(ui_of "$A" a-main)
check "$(field "$UM" 'r.main.sessions')" "1" "main's status line counts the other sessions"
has "$(field "$UM" 'JSON.stringify(r.main)')" '"waiting":' "and what waits across all of them"
RA=$(rpc "$A" "{\"op\":\"ui_act\",\"sessionId\":\"a-main\",\"id\":\"$RID\",\"action\":\"answer\",\"value\":\"a-main\"}")
has "$RA" '"ok":true' "main answers where it goes"
inmain() { case "$(read_all "$A" a-main)" in *"which currency"*) echo yes ;; esac; }
check "$(wait_for 10 inmain)" "yes" "and the question reaches main"
hasnt "$(read_all "$A" a-auth)" "which currency" "still not the working session"
SS=$(rpc "$A" '{"op":"sessions","sessionId":"a-main"}')
check "$(field "$SS" 'r.sessions.map(s => s.name + (s.main ? "*" : "")).sort().join(",")')" "a-auth,a-main*" "\"what's running?\" lists every session, main marked"
check "$(field "$SS" 'r.main')" "a-main" "and names main"
ST=$(rpc "$A" '{"op":"steer","sessionId":"a-main","session":"a-auth","text":"stop"}')
has "$ST" "no inbox crosstalk can write to" "steering a session with no inbox says why it cannot"
# A session with an inbox: a socket standing in for Claude Code's, which writes down what arrives.
SOCK="$TMP/inbox.sock"
(exec bun -e '
  const [sock, out] = process.argv.slice(1)
  const fs = require("fs")
  require("net").createServer((c) => c.on("data", (d) => fs.appendFileSync(out, d))).listen(sock)
' "$SOCK" "$TMP/inbox.log" >/dev/null 2>&1) &
INBOX_PID=$!
for _ in $(seq 1 20); do [ -S "$SOCK" ] && break; sleep 0.1; done
rpc "$A" "{\"op\":\"register\",\"sessionId\":\"a-api\",\"pid\":1,\"name\":\"a-api\",\"cwd\":\"$R/ana-main\",\"socket\":\"$SOCK\",\"token\":\"tok-123\"}" >/dev/null
ST=$(rpc "$A" '{"op":"steer","sessionId":"a-main","session":"a-api","text":"stop and summarise where you are"}')
has "$ST" "Told a-api" "\"tell the api one to stop\" steers it"
sleep 0.5
INBOX=$(cat "$TMP/inbox.log" 2>/dev/null)
has "$INBOX" "stop and summarise where you are" "the instruction lands in that session's inbox"
has "$INBOX" '"token":"tok-123"' "as the user's own, with that session's token"
kill $INBOX_PID 2>/dev/null
rpc "$A" '{"op":"register","sessionId":"a-api","pid":1,"name":"a-api","cwd":"/nowhere","socket":""}' >/dev/null

# --- 2. answers become rules ---------------------------------------------------------
echo
echo "answers become rules"
reg "$B" b-auth "$R/ben-auth" '["src/auth/token.ts"]'
same() { a=$(ids_of "$A" a-auth); b=$(ids_of "$B" b-auth); [ -n "$a" ] && [ "$a" = "$b" ] && echo "$a"; }
TID=$(wait_for 10 same)
[ -n "$TID" ] && pass "ana and ben share the auth thread" || fail "ana and ben share the auth thread"
Q="Use the v2 token format for new endpoints?"
ask() { # home session text -> question id
  r=$(rpc "$1" "{\"op\":\"thread\",\"sessionId\":\"$2\",\"question\":{\"text\":\"$3\"}}")
  field "$r" 'r.thread.questions[r.thread.questions.length-1].id'
}
answer() { rpc "$1" "{\"op\":\"thread\",\"sessionId\":\"$2\",\"answer\":{\"id\":\"$3\",\"text\":\"$4\"}}"; }
Q1=$(ask "$A" a-auth "$Q")
R1=$(answer "$A" a-auth "$Q1" "yes")
check "$(field "$R1" 'r.offer ? "offer" : "none"')" "none" "the first answer offers nothing"
Q2=$(ask "$A" a-auth "use the v2 token format for new endpoints")
R2=$(answer "$A" a-auth "$Q2" "Yes")
OFFER=$(field "$R2" 'r.offer && r.offer.id')
has "$(field "$R2" 'r.offer && r.offer.question')" "Always do this" "the second identical answer offers \"Always do this?\""
NA=$(rpc "$A" '{"op":"threads","sessionId":"a-auth","consume":true}')
has "$(field "$NA" 'r.notes.join(";")')" "Always do this" "and a session without the mod is told in its systemMessage"
ACC=$(rpc "$A" "{\"op\":\"rule\",\"sessionId\":\"a-auth\",\"accept\":\"$OFFER\"}")
has "$ACC" "Standing rule" "yes makes it a standing rule"
benrule() { field "$(rpc "$B" '{"op":"rule","sessionId":"b-auth"}')" 'r.rules.map(x => x.answer).join(",")'; }
check "$(wait_for 10 benrule)" "Yes" "ben has the rule at once, over the relay"
onref() { git -C "$R/remote.git" ls-tree --name-only refs/crosstalk/threads 2>/dev/null | grep -x RULES.md; }
check "$(wait_for 15 onref)" "RULES.md" "RULES.md is committed and pushed on the thread ref"
RF=$(git -C "$R/remote.git" show refs/crosstalk/threads:RULES.md 2>/dev/null)
has "$RF" "sealed: true" "sealed to the repo's people"
hasnt "$RF" "token format" "with nothing readable in it"
Q3=$(ask "$B" b-auth "use the v2 token format for new endpoints?")
answered_b() { field "$(rpc "$B" '{"op":"thread_read","sessionId":"b-auth"}')" "r.threads[0].questions.find(q => q.id === '$Q3')?.answer"; }
check "$(wait_for 10 answered_b)" "Yes" "the third time, ben's question is answered by the rule"
Q4=$(ask "$A" a-auth "Use the v2 token format for new endpoints")
answered_a() { field "$(rpc "$A" '{"op":"thread_read","sessionId":"a-auth"}')" "r.threads[0].questions.find(q => q.id === '$Q4')?.answer"; }
check "$(wait_for 10 answered_a)" "Yes" "and so is ana's"
NB=$(rpc "$B" '{"op":"threads","sessionId":"b-auth","consume":true}')
has "$(field "$NB" 'r.notes.join(";")')" "ana made a standing rule" "ben's digest says ana made a rule"
has "$(field "$NB" 'r.notes.join(";")')" "by the standing rule" "and that it answered for him"
NM=$(rpc "$A" '{"op":"threads","sessionId":"a-main","consume":true}')
has "$(field "$NM" 'r.notes.join(";")')" "by the standing rule" "ana's digest goes to her main session"
RM=$(rpc "$B" '{"op":"rule","sessionId":"b-auth","remove":"token format"}')
has "$RM" "Dropped the standing rule" "ben can undo it"
gone() { field "$(rpc "$A" '{"op":"rule","sessionId":"a-auth"}')" 'r.rules.length === 0 ? "gone" : ""'; }
check "$(wait_for 10 gone)" "gone" "and it is gone for ana too"
told() { case "$(rpc "$A" '{"op":"threads","sessionId":"a-main","consume":true}')" in *"ben dropped the standing rule"*) echo yes ;; esac; }
check "$(wait_for 10 told)" "yes" "ana is told ben dropped it"

# --- 3. heads-up -----------------------------------------------------------------------
echo
echo "agents warn each other"
reg "$B" b-bill "$R/ben-bill" '["src/shared/util.ts"]'
sleep 1.5
# ana's agent edits parse() in util.ts; the real PostToolUse hook reports it.
printf 'export function parse(s: string) {\n  return s.trim().toLowerCase()\n}\n\nexport function format(n: number) {\n  return String(n)\n}\n' >"$R/ana-auth/src/shared/util.ts"
HOOK_IN="{\"session_id\":\"a-auth\",\"cwd\":\"$R/ana-auth\",\"hook_event_name\":\"PostToolUse\",\"tool_name\":\"Edit\",\"tool_input\":{\"file_path\":\"$R/ana-auth/src/shared/util.ts\",\"old_string\":\"  return s.trim()\",\"new_string\":\"  return s.trim().toLowerCase()\"}}"
echo "$HOOK_IN" | env -u CLAUDE_CODE_MESSAGING_SOCKET CROSSTALK_HOME="$A" bun src/hook.ts >/dev/null 2>&1
headsup() { case "$(read_all "$B" b-bill)" in *"heads-up"*) echo yes ;; esac; }
check "$(wait_for 10 headsup)" "yes" "the edit reaches ben's billing session as a heads-up"
HB=$(read_all "$B" b-bill)
has "$HB" "src/shared/util.ts (parse)" "naming the file and the function"
has "$HB" "diff of src/shared/util.ts" "with the diff attached as a slice"
UB=$(ui_of "$B" b-bill)
check "$(field "$UB" 'r.items.filter(i => /heads-up/.test(i.text ?? "")).every(i => i.auto)')" "true" "handed to its agent by itself (own thread)"
hasnt "$(read_all "$B" b-auth)" "heads-up" "ben's auth session, in ana's own thread, gets none"

# --- 4. conflict -------------------------------------------------------------------------
echo
echo "conflicts agreed before they happen"
CE=$(rpc "$B" '{"op":"edited","sessionId":"b-bill","edit":{"file":"src/shared/util.ts","symbols":["parse"],"pending":["parse"],"diff":"+  return s.trim().toUpperCase()"}}')
CID=$(field "$CE" 'r.conflicts[0]')
[ -n "$CID" ] && [ "$CID" != "null" ] && pass "ben editing the same function is a conflict ($CID)" || fail "ben editing the same function is a conflict: $CE"
has "$(read_all "$B" b-bill)" "conflict ahead: parse in src/shared/util.ts" "ben's agent gets a conflict frame"
has "$(read_all "$B" b-bill)" "auth (ana)" "naming the other thread and its person"
conflict_a() { case "$(read_all "$A" a-auth)" in *"conflict ahead"*) echo yes ;; esac; }
check "$(wait_for 10 conflict_a)" "yes" "and so does ana's"
has "$(read_all "$A" a-auth)" "billing (ben)" "naming billing"
ASID=a-auth
P1=$(rpc "$A" "{\"op\":\"conflict\",\"sessionId\":\"$ASID\",\"id\":\"$CID\",\"owner\":\"mine\",\"text\":\"auth owns parsing\"}")
check "$(field "$P1" 'r.outcome')" "waiting" "ana's agent proposes auth changes it"
sleep 1
P2=$(rpc "$B" "{\"op\":\"conflict\",\"sessionId\":\"b-bill\",\"id\":\"$CID\",\"owner\":\"theirs\"}")
check "$(field "$P2" 'r.outcome')" "agreed" "ben's agrees: no person asked"
dec_a() { field "$(rpc "$A" '{"op":"thread_read","sessionId":"'"$ASID"'"}')" 'r.threads[0].decisions.some(d => /auth changes it/.test(d.text)) ? "yes" : ""'; }
check "$(wait_for 5 dec_a)" "yes" "recorded as a decision in auth"
check "$(field "$(rpc "$B" '{"op":"thread_read","sessionId":"b-bill"}')" 'r.threads[0].decisions.some(d => /auth changes it/.test(d.text)) ? "yes" : ""')" "yes" "and in billing"

# --- 5. first use, per repo ---------------------------------------------------------------
echo
echo "first use, per repo"
command -v ssh-keygen >/dev/null || { echo "  SKIP  ssh-keygen missing"; [ $FAILED -eq 0 ] && echo "next: all $PASSES passed"; exit $FAILED; }
ssh-keygen -q -t ed25519 -N '' -C "cara@test" -f "$SSH/cara"
cp "$SSH/cara.pub" "$KEYS/cara.keys"
STUB_PORT=$((PORT+1))
(exec bun -e '
  const [dir, port] = process.argv.slice(1)
  const fs = require("fs")
  Bun.serve({ port: Number(port), hostname: "127.0.0.1", fetch(req) {
    const m = new URL(req.url).pathname.match(/^\/([a-z0-9-]+)\.keys$/)
    if (!m) return new Response("nope", { status: 404 })
    try { return new Response(fs.readFileSync(`${dir}/${m[1]}.keys`, "utf8")) } catch { return new Response("Not Found", { status: 404 }) }
  } })
' "$KEYS" "$STUB_PORT" >"$TMP/stub.log" 2>&1) &
STUB_PID=$!
for _ in $(seq 1 30); do curl -sf -m 1 "http://127.0.0.1:$STUB_PORT/cara.keys" >/dev/null && break; sleep 0.3; done
for n in rt rt2; do git init -q --bare -b main "$R/$n.git"; git clone -q "$R/$n.git" "$R/$n" 2>/dev/null; g "$R/$n" commit -q --allow-empty -m init; g "$R/$n" push -q origin main 2>/dev/null; done
cara() { # the third machine: no identity, trust through the repo on
  env -u CLAUDE_CODE_MESSAGING_SOCKET -u CROSSTALK_NO_REPOTRUST CROSSTALK_HOME="$Cc" CROSSTALK_REPOTRUST_ANY_REMOTE=1 \
    CROSSTALK_GITHUB_URL="http://127.0.0.1:$STUB_PORT" CROSSTALK_GITHUB_LOGIN=cara CROSSTALK_MACHINE=desk CROSSTALK_SSH_KEY="$SSH/cara" \
    CROSSTALK_KEYS_MIN_MS=0 CROSSTALK_REPOTRUST_MIN_MS=0 CROSSTALK_RELAY="ws://127.0.0.1:$PORT" SSH_AUTH_SOCK= "$@"
}
start_hook() { echo "{\"session_id\":\"$1\",\"cwd\":\"$2\",\"hook_event_name\":\"SessionStart\",\"source\":\"startup\"}" | cara bun src/hook.ts 2>&1; }
H1=$(start_hook c1 "$R/rt")
has "$(field "$H1" 'r.systemMessage')" "Connect with your team in local/rt? This publishes your public key and GitHub login on a hidden ref in this repo." "the first session in a repo asks, with no identity at all"
H2=$(start_hook c2 "$R/rt")
hasnt "$H2" "Connect with your team" "a second session in the same repo does not ask again"
check "$(git -C "$R/rt.git" for-each-ref refs/crosstalk | wc -l | tr -d ' ')" "0" "nothing is pushed before a yes"
check "$([ -f "$Cc/identity.json" ] && echo made || echo none)" "none" "and no identity is made before one"
# The mod is in c3's session: the question is its picker instead.
cara bin/crosstalk ui hello --session c3 >/dev/null
H3=$(start_hook c3 "$R/rt2")
hasnt "$H3" "Connect with your team" "with the mod there is no systemMessage"
check "$(field "$(cat "$Cc/ui.json")" 'r.items["connect:local/rt2"].options.join("/")')" "Connect/Not in this repo" "but a picker: Connect / Not in this repo"
NO=$(cara bun -e 'const f = await import("./src/repotrust/firstuse.ts"); const c = await import("./src/client.ts"); console.log(JSON.stringify(await f.connect({ slug: "local/rt", yes: false, ensureDaemon: () => c.ensureDaemon(), request: c.request })))')
has "$NO" "will not be asked there again" "\"not in this repo\" is remembered"
hasnt "$(start_hook c4 "$R/rt")" "Connect with your team" "and never asked there again"
YES=$(cara bin/crosstalk ui act --session c3 --id connect:local/rt2 --action answer --value Connect)
has "$YES" "Connected in local/rt2" "Connect: an identity, the daemon, a sync"
has "$YES" "Made you \\\"cara\\\"" "the identity is made on yes"
published() { git -C "$R/rt2.git" for-each-ref --format='%(refname)' refs/crosstalk/keys | grep -x refs/crosstalk/keys/cara/desk; }
check "$(wait_for 20 published)" "refs/crosstalk/keys/cara/desk" "and the statement is published in that repo"
check "$(git -C "$R/rt.git" for-each-ref refs/crosstalk | wc -l | tr -d ' ')" "0" "but not in the repo that said no"

echo
[ $FAILED -eq 0 ] && echo "next: all $PASSES passed" || { echo "next: failures"; tail -30 "$TMP/da.log"; echo ---; tail -30 "$TMP/db.log"; echo ---; tail -20 "$Cc/daemon.log" 2>/dev/null; }
exit $FAILED
