#!/usr/bin/env bash
# Long-running processes outlive Claude sessions: real tmux, a real HTTP
# server (bun), real git, the real MCP server, hook and CLI, and stub claudes.
#
#   bash test/services.sh
#
#   serve       crosstalk_serve starts the server in `tmux -L crosstalk` with
#               PORT set to the worktree's own block, and says where it listens
#   survives    the session that asked is restarted by gather (SIGTERM, then
#               `claude --resume` typed into its pane): the server still answers
#   told        the resumed session's SessionStart names it, on that port, for
#               the person and for the agent
#   postponed   a session running a server it started itself (outside
#               crosstalk) is not restarted while that child runs, and is once
#               it exits
#   cleanup     refuses while the service runs; after the person's yes, the
#               service is stopped first and the worktree removed
#
# Every tmux server and process started here is torn down on exit.

set -u
export CROSSTALK_NO_GATHER= CROSSTALK_NO_REPOTRUST=1 CROSSTALK_NO_NOTIFY=1 CROSSTALK_NO_OPEN=1 CROSSTALK_NO_DOCTOR=1
export CROSSTALK_GATHER_POLL_MS=300 CROSSTALK_CLEANUP_EVERY_MS=0 CROSSTALK_PORT_START=${CROSSTALK_PORT_START:-47100}
unset CROSSTALK_NO_GATHER
cd "$(dirname "$0")/.."
ROOT=$(pwd)
TMP=$(mktemp -d)
export HOME="$TMP/user"
export CROSSTALK_HOME="$TMP/ct"
export TMUX_TMPDIR="$TMP/tmux"
export GIT_AUTHOR_NAME=t GIT_AUTHOR_EMAIL=t@t GIT_COMMITTER_NAME=t GIT_COMMITTER_EMAIL=t@t
unset TMUX TMUX_PANE TERM_PROGRAM CLAUDE_CODE_MESSAGING_SOCKET CLAUDE_CODE_SESSION_ID CROSSTALK_BG_AGENT CLAUDECODE
mkdir -p "$HOME/.claude/sessions" "$CROSSTALK_HOME" "$TMUX_TMPDIR" "$TMP/bin"
FAILED=0
PASSES=0
pass() { echo "  PASS  $1"; PASSES=$((PASSES+1)); }
fail() { echo "  FAIL  $1"; FAILED=1; }
check() { if [ "$1" = "$2" ]; then pass "$3"; else fail "$3 (wanted '$2', got '$1')"; fi; }
has() { case "$1" in *"$2"*) pass "$3" ;; *) fail "$3"; echo "        got: $1" | head -c 1200; echo ;; esac; }
hasnt() { case "$1" in *"$2"*) fail "$3"; echo "        got: $1" | head -c 1200; echo ;; *) pass "$3" ;; esac; }
FINISH=""
cleanup() {
  [ -n "$FINISH" ] && kill "$FINISH" 2>/dev/null
  tmux kill-server 2>/dev/null
  tmux -L crosstalk kill-server 2>/dev/null
  [ -f "$TMP/child.pid" ] && kill "$(cat "$TMP/child.pid")" 2>/dev/null
  pkill -f "$TMP/" 2>/dev/null
  rm -rf "$TMP"
}
trap cleanup EXIT
waitfor() { for _ in $(seq 1 "${3:-50}"); do grep -q -- "$2" "$1" 2>/dev/null && return 0; sleep 0.2; done; return 1; }
regfile() { grep -l "\"sessionId\":\"$1\"" "$HOME"/.claude/sessions/*.json 2>/dev/null | head -1; }
mcp() { bun "$ROOT/test/mcp-call.ts" "$CROSSTALK_HOME" "$1" "$2" "$3" "$4" 2>&1; }
get() { curl -s --max-time 2 "http://127.0.0.1:$1/" 2>/dev/null; }

# The server: answers with its PORT and whether a provider token reached it.
cat >"$TMP/srv.ts" <<'EOF'
const port = Number(process.env.PORT)
Bun.serve({ port, hostname: "127.0.0.1", fetch: () => new Response(`up on ${port} token=${process.env.GITHUB_TOKEN ?? "none"}`) })
console.log(`listening on ${port}`)
EOF

# The stand-in for claude, as in test/gather.sh: registers itself, exits on
# SIGTERM, and a resumed one runs crosstalk's SessionStart hook, keeping what
# it said. STUB_CHILD starts a server of its own through a shell, the way a
# backgrounded Bash call would.
cat >"$TMP/bin/claude" <<EOF
#!/bin/sh
id=\${STUB_ID:-none}
[ "\$1" = "--resume" ] && id=\$2
reg="\$HOME/.claude/sessions/\$\$.json"
printf '%s|%s\n' "\$(pwd)" "\$*" >>"$TMP/calls"
printf '{"pid":%s,"sessionId":"%s","cwd":"%s","status":"idle","kind":"interactive","startedAt":%s000}' \$\$ "\$id" "\$(pwd)" "\$(date +%s)" >"\$reg"
trap 'echo "\$id TERM" >>"$TMP/signals"; rm -f "\$reg"; exit 0' TERM
trap 'echo "\$id INT" >>"$TMP/signals"; rm -f "\$reg"; exit 0' INT
if [ -n "\${STUB_CHILD:-}" ]; then
  sh -c 'PORT=\$1 bun "\$2" >/dev/null 2>&1; true' - "\$STUB_CHILD" "$TMP/srv.ts" &
fi
if [ "\$1" = "--resume" ]; then
  printf '{"hook_event_name":"SessionStart","session_id":"%s","cwd":"%s","source":"resume"}' "\$id" "\$(pwd)" | bun "$ROOT/src/hook.ts" >"$TMP/start-\$id.json" 2>&1
fi
while :; do sleep 0.2; done
EOF
chmod +x "$TMP/bin/claude"
export PATH="$TMP/bin:$PATH"

echo "state in $TMP"
REPO="$TMP/code/app"
mkdir -p "$REPO"
git -C "$REPO" init -q -b main
echo hi >"$REPO/README.md"
git -C "$REPO" add . && git -C "$REPO" commit -qm init
WT="$REPO/.claude/worktrees/web"
git -C "$REPO" worktree add -q -b crosstalk/web "$WT"
echo "a change" >"$WT/change.txt"
git -C "$WT" add . && git -C "$WT" commit -qm "the work"
OTHER="$TMP/code/other"
mkdir -p "$OTHER"

echo
echo "serve: in crosstalk's tmux, on the worktree's own port"
OUT=$(GITHUB_TOKEN=ghp_secret mcp sess-a crosstalk_serve "{\"command\":\"bun $TMP/srv.ts\",\"name\":\"web\"}" "$WT")
has "$OUT" "started web in crosstalk's background tmux" "crosstalk_serve starts it"
PORT=$(echo "$OUT" | sed -n 's/.*PORT=\([0-9]*\).*/\1/p' | head -1)
check "$PORT" "$CROSSTALK_PORT_START" "PORT is the first port of the worktree's block"
has "$OUT" "listening on http://localhost:$PORT" "and it says where it listens, as detected"
has "$(get "$PORT")" "up on $PORT" "the server answers on that port"
has "$(get "$PORT")" "token=none" "a provider token did not reach it"
has "$(tmux -L crosstalk list-windows -t =crosstalk-services -F '#{window_name}' 2>&1)" "web" "one window for it in tmux -L crosstalk"
LIST=$(mcp sess-a crosstalk_services '{}' "$WT")
has "$LIST" "web" "crosstalk_services lists it"
has "$LIST" "http://localhost:$PORT" "with its URL"
TAIL=$(mcp sess-a crosstalk_services '{"name":"web","tail":5}' "$WT")
has "$TAIL" "listening on $PORT" "its log, read only when asked"
AGAIN=$(mcp sess-a crosstalk_serve "{\"command\":\"bun $TMP/srv.ts\",\"name\":\"web\"}" "$WT")
has "$AGAIN" "already running" "a second serve of the same name reuses it"
check "$(tmux -L crosstalk list-windows -t =crosstalk-services | wc -l | tr -d ' ')" "1" "and starts nothing twice"
O2=$(mcp sess-x crosstalk_serve "{\"command\":\"bun $TMP/srv.ts\",\"name\":\"web\"}" "$OTHER")
P2=$(echo "$O2" | sed -n 's/.*PORT=\([0-9]*\).*/\1/p' | head -1)
[ -n "$P2" ] && [ "$P2" -ge $((CROSSTALK_PORT_START + 10)) ] && pass "another folder gets a block of its own ($P2)" || fail "another folder's block ($P2)"
mcp sess-x crosstalk_stop '{"name":"web"}' "$OTHER" >/dev/null

echo
echo "two sessions started before crosstalk, in the worktree; one runs a server of its own"
tmux new-session -d -s work -x 200 -y 50 -c "$WT" sh
tmux new-window -d -t work:1 -c "$WT" sh
PA=$(tmux display -p -t work:0 '#{pane_id}')
PB=$(tmux display -p -t work:1 '#{pane_id}')
CHILD_PORT=$((CROSSTALK_PORT_START + 90))
tmux send-keys -t "$PA" "STUB_ID=sess-a claude" Enter
tmux send-keys -t "$PB" "STUB_ID=sess-b STUB_CHILD=$CHILD_PORT claude" Enter
for _ in $(seq 1 50); do [ -n "$(regfile sess-a)" ] && [ -n "$(regfile sess-b)" ] && break; sleep 0.2; done
for _ in $(seq 1 50); do [ -n "$(get "$CHILD_PORT")" ] && break; sleep 0.2; done
has "$(get "$CHILD_PORT")" "up on $CHILD_PORT" "sess-b's own server answers"
APID=$(basename "$(regfile sess-a)" .json)
BPID=$(basename "$(regfile sess-b)" .json)

echo
echo "gather: yes"
OUT=$( (printf '%s\n' \
  '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2024-11-05","capabilities":{},"clientInfo":{"name":"t","version":"1"}}}' \
  '{"jsonrpc":"2.0","id":2,"method":"tools/call","params":{"name":"crosstalk_gather","arguments":{"confirm":true}}}'; sleep 2) \
  | CLAUDE_CODE_SESSION_ID=asker CROSSTALK_NO_WAITER=1 timeout 15 bun src/server.ts 2>/dev/null)
has "$OUT" "bringing 2 sessions into crosstalk" "both queued"
bun src/cli.ts gather --finish >"$TMP/finish.log" 2>&1 &
FINISH=$!
waitfor "$TMP/calls" "--resume sess-a" 75 && pass "sess-a was restarted in its pane" || fail "sess-a was restarted"
kill -0 "$APID" 2>/dev/null && fail "its old process is gone" || pass "its old process is gone"
sleep 0.5
has "$(get "$PORT")" "up on $PORT" "the service still answers after the session ended"

echo
echo "the next session is told"
waitfor "$TMP/start-sess-a.json" "systemMessage" 50
START=$(cat "$TMP/start-sess-a.json" 2>/dev/null)
has "$START" "still running in this worktree: web (http://localhost:$PORT)" "the person: running, with its URL"
has "$START" "additionalContext" "the agent gets a line"
has "$START" "crosstalk services already running in this worktree" "naming the services, as a status report"
has "$START" "ports are $PORT-$((PORT + 9))" "and the worktree's ports"

echo
echo "postponed: sess-b is idle but its own server runs"
sleep 2
hasnt "$(cat "$TMP/signals" 2>/dev/null)" "sess-b" "sess-b is not signalled while its child runs"
kill -0 "$BPID" 2>/dev/null && pass "and keeps running" || fail "and keeps running"
has "$(get "$CHILD_PORT")" "up on $CHILD_PORT" "and so does its server"
pkill -f "PORT=$CHILD_PORT bun" 2>/dev/null
for p in $(pgrep -f "$TMP/srv.ts"); do
  # Only sess-b's: the one whose parent is a shell below sess-b.
  pp=$(ps -o ppid= -p "$p" | tr -d ' ')
  [ "$(ps -o ppid= -p "$pp" 2>/dev/null | tr -d ' ')" = "$BPID" ] && kill "$p"
done
waitfor "$TMP/calls" "--resume sess-b" 75 && pass "once it exits, sess-b is restarted" || fail "sess-b restarted after its child exits"
for _ in $(seq 1 50); do kill -0 "$FINISH" 2>/dev/null || break; sleep 0.2; done
FINISH=""
has "$(cat "$TMP/finish.log")" "2 sessions are now in crosstalk." "the waiter reports both"
has "$(get "$PORT")" "up on $PORT" "the service never stopped"

echo
echo "cleanup: the work lands; nothing in use is removed"
git -C "$REPO" merge -q --ff-only crosstalk/web
mkdir -p "$CROSSTALK_HOME/spawned"
cat >"$CROSSTALK_HOME/spawned/app--web.json" <<EOF
{"id":"app--web","name":"web","task":"t","repo":"$REPO","worktree":"$WT","cwd":"$WT","branch":"crosstalk/web","base":"$(git -C "$REPO" rev-parse HEAD~1)","createdAt":1,"background":false,"links":[]}
EOF
LIST=$(mcp asker crosstalk_cleanup '{}' "$REPO")
has "$LIST" "Still in use or not merged: web (a process is running in it" "with sessions still in it, it is kept"
# The sessions end the way Claude Code exits (their shells reap them), then the panes close.
for f in "$HOME"/.claude/sessions/*.json; do [ -f "$f" ] && kill -TERM "$(basename "$f" .json)" 2>/dev/null; done
sleep 0.5
tmux kill-server 2>/dev/null
sleep 0.5
LIST=$(mcp asker crosstalk_cleanup '{}' "$REPO")
has "$LIST" "its services web · :$PORT stop first" "the listing says its service stops first"
REF=$(bun -e '
  const C = await import("./src/cleanup.ts")
  console.log(JSON.stringify(C.removeOne({ repo: process.argv[1], worktree: process.argv[2], links: [], ours: true })))
' "$REPO" "$WT")
has "$REF" "a crosstalk service is running in it (web)" "removing without the yes refuses while it runs"
[ -d "$WT" ] && pass "the worktree is still there" || fail "the worktree is still there"
has "$(get "$PORT")" "up on $PORT" "and its service still answers"
YES=$(mcp asker crosstalk_cleanup '{"confirm":true}' "$REPO")
has "$YES" "stopped its service first: web" "after the yes, the service stops first"
has "$YES" "removed 1 worktree" "then the worktree goes"
[ -d "$WT" ] && fail "the folder is gone" || pass "the folder is gone"
check "$(get "$PORT")" "" "nothing answers on its port"
tmux -L crosstalk has-session -t =crosstalk-services 2>/dev/null && fail "its tmux window is gone" || pass "its tmux window is gone"

echo
[ $FAILED -eq 0 ] && echo "services: all $PASSES passed" || echo "services: failures"
exit $FAILED
