#!/usr/bin/env bash
# Sessions and attention, through a real daemon, real git, real tmux and the
# real hook, with a stub `claude` and a stub ntfy server.
#
#   bash test/attention.sh
#
#   1. recap        a session whose files touch auth and billing equally is
#                   placed by its last turns: at once from its transcript, or at
#                   Stop; the empty billing thread takes its recap
#   2. fresh        PreCompact asks; "Start fresh" ends the stub claude in its
#                   tmux pane and starts a fresh one in the same pane, primed
#                   with the thread; restore counts it as ended on purpose, and
#                   the next session there carries on the thread
#   3. focus        the person's tmux has one client attached; a background
#                   agent's permission request (the real hook, held open)
#                   becomes a question in the session that client shows, and
#                   the answer goes back to the waiting hook; after the client
#                   switches, the next one goes to the other session
#   4. staffing     a thread with nothing moving is a question; yes starts a
#                   second agent in crosstalk's background tmux with the brief,
#                   marked so its permission prompts come back as questions
#   5. away         nothing typed, focus unchanged: a blocking question is a
#                   POST to ntfy with a count and a thread name, no content

set -u
export CROSSTALK_NO_GATHER=1 CROSSTALK_NO_RESTORE=1 CROSSTALK_NO_TERM=1 CROSSTALK_NO_REPOTRUST=1 CROSSTALK_NO_NOTIFY=1
export CROSSTALK_THREAD_SETTLE_MS=300 CROSSTALK_THREAD_SYNC_MS=600000 CROSSTALK_THREADS_NO_PUSH=1
export CROSSTALK_PERMISSION_WAIT_MS=20000 CROSSTALK_ATTENTION_TICK_MS=200 CROSSTALK_STUCK_MS=600000 CROSSTALK_NO_WAITER=1 CROSSTALK_NO_OPEN=1 CROSSTALK_ASK_FRESH=1
cd "$(dirname "$0")/.."
ROOT=$(pwd)
TMP=$(mktemp -d)
export CROSSTALK_HOME="$TMP/home"
export TMUX_TMPDIR="$TMP/tmux"
export GIT_AUTHOR_NAME=t GIT_AUTHOR_EMAIL=t@t GIT_COMMITTER_NAME=t GIT_COMMITTER_EMAIL=t@t
unset TMUX TMUX_PANE TERM_PROGRAM CLAUDE_CODE_SESSION_ID CLAUDECODE CLAUDE_CODE_MESSAGING_SOCKET CROSSTALK_BG_AGENT
mkdir -p "$CROSSTALK_HOME" "$TMUX_TMPDIR" "$TMP/bin"
NPORT=${NTFY_PORT:-8796}
FAILED=0
PASSES=0
pass() { echo "  PASS  $1"; PASSES=$((PASSES+1)); }
fail() { echo "  FAIL  $1"; FAILED=1; }
check() { if [ "$1" = "$2" ]; then pass "$3"; else fail "$3 (wanted '$2', got '$1')"; fi; }
has() { case "$1" in *"$2"*) pass "$3" ;; *) fail "$3"; echo "        got: $1" | head -c 1500; echo ;; esac; }
hasnt() { case "$1" in *"$2"*) fail "$3"; echo "        got: $1" | head -c 1500; echo ;; *) pass "$3" ;; esac; }
stop_daemon() {
  if [ -f "$CROSSTALK_HOME/daemon.lock" ]; then
    P=$(cat "$CROSSTALK_HOME/daemon.lock")
    kill "$P" 2>/dev/null
    for _ in $(seq 1 30); do kill -0 "$P" 2>/dev/null || break; sleep 0.2; done
  fi
  rm -f "$CROSSTALK_HOME/daemon.sock" "$CROSSTALK_HOME/daemon.lock"
}
start_daemon() {
  env "$@" nohup bun src/daemon.ts >>"$TMP/daemon.log" 2>&1 &
  for _ in $(seq 1 40); do [ -S "$CROSSTALK_HOME/daemon.sock" ] && break; sleep 0.25; done
}
NTFY_PID=""
cleanup() {
  stop_daemon
  tmux kill-server 2>/dev/null; tmux -L outer kill-server 2>/dev/null; tmux -L crosstalk kill-server 2>/dev/null
  [ -n "$NTFY_PID" ] && kill "$NTFY_PID" 2>/dev/null
  rm -rf "$TMP"
}
trap cleanup EXIT
rpc() { bun -e '
  const { request } = await import("./src/client.ts")
  console.log(JSON.stringify(await request(JSON.parse(process.argv[1]), 60000)))
' "$1" 2>&1; }
field() { echo "$1" | bun -e 'const r = JSON.parse(await Bun.stdin.text()); const v = (0, eval)("(r) => " + process.argv[1])(r); console.log(typeof v === "string" ? v : JSON.stringify(v ?? null))' "$2"; }
wait_for() { # seconds command...: until the command prints something that is not empty, null or false
  local n=$1; shift
  for _ in $(seq 1 $((n * 5))); do
    v=$("$@" 2>/dev/null)
    [ -n "$v" ] && [ "$v" != "null" ] && [ "$v" != "false" ] && { echo "$v"; return; }
    sleep 0.2
  done
  echo ""
}
reg() { rpc "{\"op\":\"register\",\"sessionId\":\"$1\",\"pid\":1,\"name\":\"$1\",\"cwd\":\"$REPO\",\"socket\":\"\",\"touched\":${2:-[]}${3:+,\"transcript\":\"$3\"}}" >/dev/null; }
names_of() { field "$(rpc "{\"op\":\"threads\",\"sessionId\":\"$1\"}")" 'r.threads.map(t => t.name).join(",")'; }
question_of() { field "$(rpc "{\"op\":\"threads\",\"sessionId\":\"$1\"}")" 'r.question ? r.question.question : ""'; }
# The attention question waiting in one session, by id prefix.
item_in() { field "$(rpc "{\"op\":\"ui\",\"sessionId\":\"$1\"}")" "(r.items||[]).filter(i => i.id.startsWith('$2')).map(i => i.id)[0] ?? ''"; }
item_anywhere() { bun -e 'const f = JSON.parse(require("fs").readFileSync(process.argv[1] + "/ui.json", "utf8")); const it = Object.values(f.items).find(i => i.id.startsWith(process.argv[2]) && i.state === "pending"); console.log(it ? `${it.id} ${it.sessionId}` : "")' "$CROSSTALK_HOME" "$1" 2>/dev/null; }
answer() { rpc "{\"op\":\"ui_act\",\"sessionId\":\"$1\",\"id\":\"$2\",\"action\":\"answer\",\"value\":\"$3\"}"; }
hook() { # json [extra env...]: the real hook, as Claude Code runs it
  local input=$1; shift
  printf '%s' "$input" | env "$@" bun "$ROOT/src/hook.ts" 2>&1
}
user() { printf '{"type":"user","message":{"role":"user","content":"%s"}}\n' "$1"; }
assistant() { printf '{"type":"assistant","message":{"role":"assistant","content":[{"type":"text","text":"%s"}]}}\n' "$1"; }
# A restore record, as the hook writes one, for a session showing in a tmux pane.
rec_for() { # session pane
  local pid sock
  pid=$(tmux display -p -t "$2" '#{pane_pid}')
  sock=$(tmux display -p -t "$2" '#{socket_path}')
  bun -e '
    const R = await import("./src/restore.ts")
    const [sid, cwd, pid, pane, socket] = process.argv.slice(1)
    R.writeRec({ sessionId: sid, cwd, client: "claude", name: sid, pid: Number(pid), interactive: true, startedAt: Date.now(), seenAt: Date.now(), terminal: { tmux: { pane, socket } } })
  ' "$1" "$REPO" "$pid" "$2" "$sock"
}

cat >"$TMP/bin/claude" <<EOF
#!/bin/sh
printf '%s|%s|%s\n' "\$(pwd)" "\${CROSSTALK_BG_AGENT:-}" "\$*" >>"$TMP/calls"
exec "$TMP/sleeper/claude" 600
EOF
chmod +x "$TMP/bin/claude"
# sleep under the name claude: a session is only ended when its process is claude.
mkdir -p "$TMP/sleeper" && ln -s "$(command -v sleep)" "$TMP/sleeper/claude"
export PATH="$TMP/bin:$PATH"

REPO="$TMP/code/api"
mkdir -p "$REPO/src/auth" "$REPO/src/billing"
git -C "$REPO" init -q -b main
git -C "$REPO" remote add origin git@github.com:acme/api.git
for f in auth/a auth/b auth/c billing/x billing/y billing/z; do echo "export const v = 1" >"$REPO/src/$f.ts"; done
git -C "$REPO" add . && git -C "$REPO" commit -qm init

bun -e '
  const { newIdentity } = await import("./src/crypto.ts")
  const { saveIdentity, saveRelay } = await import("./src/config.ts")
  saveIdentity({ ...newIdentity("ana"), machine: "desk" })
  saveRelay("ws://127.0.0.1:9")
'
start_daemon
echo "state in $TMP"

# --- 1. recap ---------------------------------------------------------------------------
echo
echo "1. a recap breaks the tie the files cannot"
reg s-auth '["src/auth/a.ts","src/auth/b.ts","src/auth/c.ts"]'
reg s-bill '["src/billing/x.ts","src/billing/y.ts","src/billing/z.ts"]'
check "$(names_of s-auth)" "auth" "three files in src/auth start auth"
check "$(names_of s-bill)" "billing" "three in src/billing start billing"
rpc '{"op":"thread","sessionId":"s-auth","recap":"rotating the session tokens and their refresh"}' >/dev/null
T1="$TMP/t1.jsonl"
{ user "make the session token refresh rotate every hour"; assistant "The refresh token now rotates hourly."; } >"$T1"
reg s-new '["src/auth/a.ts","src/billing/x.ts"]' "$T1"
check "$(names_of s-new)" "auth" "touching both equally, its transcript places it in auth"
check "$(question_of s-new)" "" "and nobody is asked"
reg s-amb '["src/auth/c.ts","src/billing/y.ts"]'
has "$(question_of s-amb)" "touches auth and billing equally" "with no transcript yet, it is a question"
T2="$TMP/t2.jsonl"
{ user "retry the failed invoice emails in billing"; assistant "Invoice retries now back off exponentially."; } >"$T2"
OUT=$(hook "{\"hook_event_name\":\"Stop\",\"session_id\":\"s-amb\",\"cwd\":\"$REPO\",\"transcript_path\":\"$T2\"}")
has "$OUT" '"continue":true' "the Stop hook answers as usual"
check "$(wait_for 5 names_of s-amb)" "billing" "at Stop its last turns place it in billing"
check "$(question_of s-amb)" "" "and the question is gone"
RECAP=$(field "$(rpc '{"op":"thread_read","thread":"billing"}')" 'r.threads[0].recap')
has "$RECAP" "retry the failed invoice emails" "billing had no recap, and takes the session's"
RECAP=$(field "$(rpc '{"op":"thread_read","thread":"auth"}')" 'r.threads[0].recap')
check "$RECAP" "rotating the session tokens and their refresh" "auth's own recap is left alone"

# --- 2. a fresh session instead of a compaction ---------------------------------------------
echo
echo "2. PreCompact: a fresh session in the same pane, primed with the thread"
tmux new-session -d -s work -x 200 -y 50 -c "$REPO" claude
PANE=$(tmux display -p -t work: '#{pane_id}')
PID0=$(tmux display -p -t "$PANE" '#{pane_pid}')
sleep 0.3
rec_for s-auth "$PANE"
rpc '{"op":"thread","sessionId":"s-auth","question":{"text":"keep the v1 endpoint?"}}' >/dev/null
OUT=$(hook "{\"hook_event_name\":\"PreCompact\",\"session_id\":\"s-auth\",\"cwd\":\"$REPO\",\"trigger\":\"auto\"}")
hasnt "$OUT" '"decision":"block"' "with no standing rule, the compaction is not blocked"
ID=$(wait_for 5 item_in s-auth attn:dispose:s-auth)
check "$ID" "attn:dispose:s-auth" "it is a question, in the session the person is in"
Q=$(field "$(rpc '{"op":"ui","sessionId":"s-auth"}')" "r.items.find(i => i.id === '$ID').question")
has "$Q" "Start a fresh session from auth instead of compacting?" "naming the thread"
OUT=$(answer s-auth "$ID" "Start fresh")
check "$(field "$OUT" r.ok)" "true" "Start fresh"
has "$(field "$OUT" r.text)" "s-auth started fresh from auth" "the receipt says so"
check "$(tmux display -p -t "$PANE" '#{pane_id}')" "$PANE" "the same pane"
PID1=$(tmux display -p -t "$PANE" '#{pane_pid}')
if [ "$PID1" != "$PID0" ] && kill -0 "$PID1" 2>/dev/null; then pass "a new process runs in it"; else fail "a new process runs in it ($PID0 -> $PID1)"; fi
kill -0 "$PID0" 2>/dev/null && fail "the old one has exited" || pass "the old one has exited"
sleep 0.3
CALLS=$(cat "$TMP/calls")
has "$CALLS" "$REPO||You are a fresh session on the crosstalk thread \"auth\"" "claude started in the same folder, primed with the thread"
has "$CALLS" "rotating the session tokens and their refresh" "the primer carries the recap"
has "$CALLS" "keep the v1 endpoint?" "and the open questions"
check "$(tmux show-options -p -t "$PANE" -v remain-on-exit 2>/dev/null)" "" "the pane's remain-on-exit is put back"
END=$(bun -e 'const R = await import("./src/restore.ts"); const r = R.readOne("s-auth"); console.log(r.endReason, R.endedNormally(r, R.readAll(), 0))')
check "$END" "disposed true" "restore counts it as ended on purpose, not a crash"
reg s-auth2
check "$(names_of s-auth2)" "auth" "the next session there carries on the thread"

# --- 3. focus and a background agent's permission request -----------------------------------
echo
echo "3. the focused tmux client decides where a background agent's question goes"
tmux new-session -d -s bill -x 200 -y 50 -c "$REPO" "sleep 600"
tmux new-session -d -s amb -x 200 -y 50 -c "$REPO" "sleep 600"
BPANE=$(tmux display -p -t bill: '#{pane_id}')
APANE=$(tmux display -p -t amb: '#{pane_id}')
rec_for s-bill "$BPANE"
rec_for s-amb "$APANE"
# A client of the person's tmux, attached to bill, inside another tmux standing in for their terminal.
tmux -L outer new-session -d -x 200 -y 50 "env -u TMUX tmux attach -t =bill"
CLIENT=$(wait_for 5 sh -c "tmux list-clients -F '#{client_name}' | head -1")
[ -n "$CLIENT" ] && pass "a client is attached" || fail "a client is attached"
FOCUS=$(wait_for 5 sh -c "bun -e 'const { request } = await import(\"./src/client.ts\"); const r = await request({ op: \"attn_focus\" }); console.log(r.focus?.sessionId ?? \"\")'")
check "$FOCUS" "s-bill" "crosstalk sees s-bill in front"
PERM='{"hook_event_name":"PermissionRequest","session_id":"bg-sess","cwd":"'"$REPO"'","tool_name":"Bash","tool_input":{"command":"rm -rf build"},"permission_suggestions":[{"type":"addRules","rules":[{"toolName":"Bash","ruleContent":"rm -rf build"}],"behavior":"allow","destination":"session"}]}'
hook "$PERM" CROSSTALK_BG_AGENT=bg1 >"$TMP/perm1.out" &
HOOK1=$!
ID=$(wait_for 10 item_in s-bill attn:perm:bg-sess)
has "$ID" "attn:perm:bg-sess" "the request is a question in s-bill"
check "$(item_in s-amb attn:perm:)" "" "and not in s-amb"
Q=$(field "$(rpc '{"op":"ui","sessionId":"s-bill"}')" "r.items.find(i => i.id === '$ID').question")
check "$Q" "bg1 (in the background) wants to use Bash: rm -rf build. Allow it?" "it says who wants what"
kill -0 $HOOK1 2>/dev/null && pass "the hook is still waiting" || fail "the hook is still waiting"
OUT=$(answer s-bill "$ID" "Allow for this session")
check "$(field "$OUT" r.ok)" "true" "answered"
wait $HOOK1
P1=$(cat "$TMP/perm1.out")
has "$P1" '"hookEventName":"PermissionRequest"' "the hook answers Claude Code"
has "$P1" '"behavior":"allow"' "with allow"
has "$P1" '"updatedPermissions":[{"type":"addRules"' "and the session-wide rule Claude Code suggested"
tmux switch-client -c "$CLIENT" -t =amb
FOCUS=$(wait_for 5 sh -c "bun -e 'const { request } = await import(\"./src/client.ts\"); const r = await request({ op: \"attn_focus\" }); console.log(r.focus?.sessionId === \"s-amb\" ? \"s-amb\" : \"\")'")
check "$FOCUS" "s-amb" "after the client switches, s-amb is in front"
hook "$PERM" CROSSTALK_BG_AGENT=bg1 >"$TMP/perm2.out" &
HOOK2=$!
ID=$(wait_for 10 item_in s-amb attn:perm:bg-sess)
has "$ID" "attn:perm:bg-sess" "the next request is a question in s-amb"
answer s-amb "$ID" "Deny" >/dev/null
wait $HOOK2
has "$(cat "$TMP/perm2.out")" '"behavior":"deny"' "Deny goes back as deny"
OUT=$(hook "$PERM")
hasnt "$OUT" '"decision"' "a session the person runs themselves keeps its own dialog"
NOTES=$(field "$(rpc '{"op":"ui","sessionId":"s-amb","mod":true}')" '(r.threadNotes||[]).map(n => n.text).join(" | ")')
has "$NOTES" 'Say "show me bg1"' "the session in front gets a receipt naming the asker"

# --- 4. staffing --------------------------------------------------------------------------------
echo
echo "4. a stuck thread: add a second agent?"
stop_daemon
start_daemon CROSSTALK_STUCK_MS=1500 CROSSTALK_STAFF_EVERY_MS=200 CROSSTALK_STAFFING=1
AUTH_ID=$(field "$(rpc '{"op":"thread_read","thread":"auth"}')" 'r.threads[0].id')
IT=$(wait_for 15 item_anywhere "attn:staff:$AUTH_ID")
[ -n "$IT" ] && pass "nothing moved in auth: a question" || fail "nothing moved in auth: a question"
SID=${IT#* }; ID=${IT% *}
check "$SID" "s-amb" "put to the session in front"
Q=$(field "$(rpc "{\"op\":\"ui\",\"sessionId\":\"$SID\"}")" "r.items.find(i => i.id === '$ID').question")
has "$Q" "auth has been stuck for" "auth has been stuck for …"
has "$Q" "Add a second agent?" "add a second agent?"
OUT=$(answer "$SID" "$ID" "Add an agent")
check "$(field "$OUT" r.ok)" "true" "yes"
has "$(field "$OUT" r.text)" "in the background" "started in the background"
if tmux -L crosstalk has-session -t =auth 2>/dev/null; then pass "a tmux session in crosstalk's own server"; else fail "a tmux session in crosstalk's own server"; fi
sleep 0.5
CALLS=$(grep -F "second agent on the crosstalk thread" "$TMP/calls" | head -1)
has "$CALLS" "/auth|auth|You are a second agent on the crosstalk thread \"auth\"" "claude runs in its own worktree with the brief, marked as a background agent"
OUT=$(answer "$SID" "$ID" "Add an agent")
check "$(field "$OUT" r.ok)" "false" "a second press does nothing"
sleep 1
check "$(item_anywhere "attn:staff:$AUTH_ID")" "" "and it is not asked again for this spell"

# --- 5. away: the phone -----------------------------------------------------------------------------
echo
echo "5. away and blocked: ntfy, with no content"
bun -e '
  const fs = require("fs")
  Bun.serve({ port: Number(process.argv[1]), hostname: "127.0.0.1", async fetch(r) {
    fs.appendFileSync(process.argv[2], JSON.stringify({ path: new URL(r.url).pathname, title: r.headers.get("title"), body: await r.text() }) + "\n")
    return new Response("ok")
  } })
' "$NPORT" "$TMP/ntfy.log" &
NTFY_PID=$!
for _ in $(seq 1 20); do curl -s -m 1 -o /dev/null "http://127.0.0.1:$NPORT/probe" && break; sleep 0.2; done
: >"$TMP/ntfy.log"
stop_daemon
start_daemon CROSSTALK_AWAY_MIN=0 CROSSTALK_NTFY_URL="http://127.0.0.1:$NPORT/ct-topic"
# (auth and billing have combined by now: the sessions above touched both.)
TNAME=$(names_of s-bill | cut -d, -f1)
rpc '{"op":"thread","sessionId":"s-bill","question":{"text":"CANARY-7731 ship the invoice retry change?","blocking":true}}' >/dev/null
GOT=$(wait_for 10 cat "$TMP/ntfy.log")
has "$GOT" '"path":"/ct-topic"' "a POST to the topic"
has "$GOT" "\"body\":\"crosstalk: 1 question waiting in $TNAME\"" "the body is a count and the thread"
hasnt "$GOT" "CANARY-7731" "and none of the question"
hasnt "$GOT" "acme" "nor the repo"
check "$(wc -l <"$TMP/ntfy.log" | tr -d ' ')" "1" "once"
PUSH=$(field "$(rpc '{"op":"ui","sessionId":"s-amb","mod":true}')" 'r.push ? r.push.text : ""')
check "$PUSH" "crosstalk: 1 question waiting in $TNAME" "the mod gets the same sealed line for Claude's own push"

echo
grep -E "attention:" "$TMP/daemon.log" | sed 's/^/  log: /' | head -20
echo
if [ $FAILED -eq 0 ]; then echo "attention: all $PASSES passed"; else echo "attention: FAILED ($PASSES passed)"; fi
exit $FAILED
