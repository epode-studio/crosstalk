#!/usr/bin/env bash
# Bringing in sessions started before crosstalk, through the real hook, the
# real CLI and real tmux.
#
#   bash test/gather.sh
#
# Two stub `claude` processes run in tmux panes, each started from the pane's
# shell the way a person would, and register themselves in a Claude Code
# registry of their own (HOME points at a temp dir). Neither has crosstalk's
# hooks. One is idle, one busy. The watch has to record both; the first new
# session has to offer once; and on yes the idle one gets SIGTERM and
# `claude --resume <id>` typed into its own pane, while the busy one is left
# alone until its registry entry says idle.

set -u
cd "$(dirname "$0")/.."
ROOT=$(pwd)
TMP=$(mktemp -d)
export HOME="$TMP/user"
export CROSSTALK_HOME="$TMP/ct"
export TMUX_TMPDIR="$TMP/tmux"
export CROSSTALK_NO_OPEN=1 CROSSTALK_GATHER_POLL_MS=300
unset TMUX TMUX_PANE TERM_PROGRAM CLAUDE_CODE_MESSAGING_SOCKET CLAUDE_CODE_SESSION_ID CROSSTALK_NO_GATHER
mkdir -p "$HOME/.claude/sessions" "$CROSSTALK_HOME" "$TMUX_TMPDIR" "$TMP/bin"
FAILED=0
PASSES=0
pass() { echo "  PASS  $1"; PASSES=$((PASSES+1)); }
fail() { echo "  FAIL  $1"; FAILED=1; }
check() { if [ "$1" = "$2" ]; then pass "$3"; else fail "$3 (wanted '$2', got '$1')"; fi; }
has() { case "$1" in *"$2"*) pass "$3" ;; *) fail "$3"; echo "        got: $1" | head -c 800; echo ;; esac; }
hasnt() { case "$1" in *"$2"*) fail "$3"; echo "        got: $1" | head -c 800; echo ;; *) pass "$3" ;; esac; }
FINISH=""
cleanup() { [ -n "$FINISH" ] && kill "$FINISH" 2>/dev/null; tmux kill-server 2>/dev/null; rm -rf "$TMP"; }
trap cleanup EXIT

# The stand-in for claude. It registers itself as Claude Code does, says how it
# was started and from which tty, and exits on SIGTERM, removing its registry
# file as Claude Code does on a normal exit. A resumed one runs crosstalk's
# SessionStart hook, as a session with crosstalk installed would.
cat >"$TMP/bin/claude" <<EOF
#!/bin/sh
id=\${STUB_ID:-none}
[ "\$1" = "--resume" ] && id=\$2
reg="\$HOME/.claude/sessions/\$\$.json"
printf '%s|%s|%s\n' "\$(pwd)" "\$*" "\$(tty)" >>"$TMP/calls"
printf '{"pid":%s,"sessionId":"%s","cwd":"%s","status":"%s","kind":"interactive","startedAt":%s000}' \$\$ "\$id" "\$(pwd)" "\${STUB_STATUS:-idle}" "\$(date +%s)" >"\$reg"
trap 'echo "\$id TERM" >>"$TMP/signals"; rm -f "\$reg"; exit 0' TERM
trap 'echo "\$id INT" >>"$TMP/signals"; rm -f "\$reg"; exit 0' INT
if [ "\$1" = "--resume" ]; then
  printf '{"hook_event_name":"SessionStart","session_id":"%s","cwd":"%s","source":"resume"}' "\$id" "\$(pwd)" | bun "$ROOT/src/hook.ts" >/dev/null 2>&1
fi
while :; do sleep 0.2; done
EOF
chmod +x "$TMP/bin/claude"
export PATH="$TMP/bin:$PATH"

D1="$TMP/idle dir"
D2="$TMP/busy's dir"
mkdir -p "$D1" "$D2"
json() { bun -e 'console.log(JSON.stringify(Object.fromEntries(process.argv.slice(1).map(a => { const i = a.indexOf("="); return [a.slice(0, i), a.slice(i + 1)] }))))' "$@"; }
hook() { json "$@" | bun src/hook.ts 2>&1; }
msg() { bun -e 'const t = await Bun.stdin.text(); try { console.log(JSON.parse(t).systemMessage ?? "") } catch { console.log("") }'; }
regfile() { grep -l "\"sessionId\":\"$1\"" "$HOME"/.claude/sessions/*.json 2>/dev/null | head -1; }
waitfor() { for _ in $(seq 1 "${3:-50}"); do grep -q -- "$2" "$1" 2>/dev/null && return 0; sleep 0.2; done; return 1; }

echo "state in $TMP"
echo
echo "two sessions started before crosstalk, one idle, one busy"
tmux new-session -d -s work -x 200 -y 50 -c "$D1" sh
tmux new-window -d -t work:1 -c "$D2" sh
IDLE_PANE=$(tmux display -p -t work:0 '#{pane_id}')
BUSY_PANE=$(tmux display -p -t work:1 '#{pane_id}')
IDLE_TTY=$(tmux display -p -t work:0 '#{pane_tty}')
BUSY_TTY=$(tmux display -p -t work:1 '#{pane_tty}')
tmux send-keys -t "$IDLE_PANE" "STUB_ID=sess-idle claude" Enter
tmux send-keys -t "$BUSY_PANE" "STUB_ID=sess-busy STUB_STATUS=busy claude" Enter
for _ in $(seq 1 50); do [ -n "$(regfile sess-idle)" ] && [ -n "$(regfile sess-busy)" ] && break; sleep 0.2; done
IDLE_PID=$(basename "$(regfile sess-idle)" .json)
BUSY_PID=$(basename "$(regfile sess-busy)" .json)
[ -n "$IDLE_PID" ] && [ -n "$BUSY_PID" ] && pass "both registered in the fake registry" || fail "the stubs registered"

echo
echo "the watch records them"
OUT=$(bun src/cli.ts gather)
has "$OUT" "2 Claude sessions started before crosstalk" "crosstalk gather lists both"
has "$OUT" "(busy)" "and says which is busy"
REC=$(cat "$CROSSTALK_HOME/open/sess-idle.json")
has "$REC" '"adopted": "watched"' "the record is marked watched"
has "$REC" "\"pane\": \"$IDLE_PANE\"" "with its tmux pane"
has "$REC" "\"tty\": \"$IDLE_TTY\"" "and its tty"
has "$REC" '"interactive": true' "and is interactive, having a tty"
has "$REC" "\"pid\": $IDLE_PID" "and its pid"
has "$REC" '"pidStart"' "and the pid's start time"

echo
echo "the first new session offers once"
OUT=$(hook hook_event_name=SessionStart session_id=asker "cwd=$TMP" source=startup)
MSG=$(echo "$OUT" | msg)
has "$MSG" "2 Claude sessions started before crosstalk. Bring them in? Idle ones restart in their tab with their conversation." "the offer, word for word"
has "$MSG" 'Say "bring them in"' "answered in plain words"
hasnt "$OUT" "additionalContext" "it is not in the model's context"
AGAIN=$(hook hook_event_name=SessionStart session_id=asker2 "cwd=$TMP" source=startup | msg)
check "$AGAIN" "" "the next session does not offer again"
check "$(cat "$TMP/signals" 2>/dev/null)" "" "nothing has been signalled yet"

echo
echo "the MCP tool lists them without confirm"
MCP=$( (printf '%s\n' \
  '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2024-11-05","capabilities":{},"clientInfo":{"name":"t","version":"1"}}}' \
  '{"jsonrpc":"2.0","id":2,"method":"tools/list","params":{}}' \
  '{"jsonrpc":"2.0","id":3,"method":"tools/call","params":{"name":"crosstalk_sessions","arguments":{"action":"gather"}}}'; sleep 2) \
  | CLAUDE_CODE_SESSION_ID=asker timeout 10 bun src/server.ts 2>/dev/null)
has "$MCP" 'bring my other sessions into crosstalk' "the tool says when to use it, in plain words"
has "$MCP" '2 Claude sessions started before crosstalk' "without confirm it only lists"
check "$(cat "$TMP/signals" 2>/dev/null)" "" "and touches nothing"

echo
echo "yes: the idle one restarts in its own pane"
OUT=$( (printf '%s\n' \
  '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2024-11-05","capabilities":{},"clientInfo":{"name":"t","version":"1"}}}' \
  '{"jsonrpc":"2.0","id":2,"method":"tools/call","params":{"name":"crosstalk_sessions","arguments":{"action":"gather","confirm":true}}}'; sleep 2) \
  | CLAUDE_CODE_SESSION_ID=asker CROSSTALK_NO_WAITER=1 timeout 10 bun src/server.ts 2>/dev/null)
has "$OUT" "bringing 2 sessions into crosstalk" "with confirm it starts"
has "$OUT" "1 is idle and restarts in its tab now" "the idle one now"
has "$OUT" "1 is busy" "the busy one later"
bun src/cli.ts gather --finish >"$TMP/finish.log" 2>&1 &
FINISH=$!
waitfor "$TMP/calls" "--resume sess-idle" 75 && pass "the idle one was resumed" || fail "the idle one was resumed"
check "$(grep -c 'sess-idle TERM' "$TMP/signals" 2>/dev/null)" "1" "after exactly one SIGTERM"
hasnt "$(cat "$TMP/signals" 2>/dev/null)" "INT" "with no SIGINT needed"
has "$(grep -- '--resume sess-idle' "$TMP/calls")" "$D1|--resume sess-idle|$IDLE_TTY" "in its folder, in the same pane (same tty)"
kill -0 "$IDLE_PID" 2>/dev/null && fail "the old process is gone" || pass "the old process is gone"
check "$(tmux list-panes -a | wc -l | tr -d ' ')" "2" "no pane or window was added"
sleep 1.5
hasnt "$(cat "$TMP/signals")" "sess-busy" "the busy one is left alone while busy"
kill -0 "$BUSY_PID" 2>/dev/null && pass "and still running" || fail "and still running"

echo
echo "the busy one goes idle"
BF=$(regfile sess-busy)
sed -i.bak 's/"status":"busy"/"status":"idle"/' "$BF" && rm -f "$BF.bak"
waitfor "$TMP/calls" "--resume sess-busy" 75 && pass "then it is resumed too" || fail "then it is resumed too"
has "$(grep -- '--resume sess-busy' "$TMP/calls")" "$D2|--resume sess-busy|$BUSY_TTY" "in its own folder and pane"
check "$(grep -c 'sess-busy TERM' "$TMP/signals")" "1" "after one SIGTERM"
for _ in $(seq 1 50); do kill -0 "$FINISH" 2>/dev/null || break; sleep 0.2; done
kill -0 "$FINISH" 2>/dev/null && fail "the waiter finishes" || pass "the waiter finishes"
FINISH=""
has "$(cat "$TMP/finish.log")" "2 sessions are now in crosstalk." "and says so"

echo
echo "afterwards"
for _ in $(seq 1 50); do grep -q '"adopted"' "$CROSSTALK_HOME/open/sess-busy.json" || break; sleep 0.2; done
hasnt "$(cat "$CROSSTALK_HOME/open/sess-idle.json")" '"adopted"' "the resumed session's own hook now keeps its record"
hasnt "$(cat "$CROSSTALK_HOME/open/sess-busy.json")" '"adopted"' "for both"
NOTE=$(hook hook_event_name=UserPromptSubmit session_id=asker "cwd=$TMP" prompt=hi | msg)
check "$NOTE" "◢ crosstalk: 2 sessions are now in crosstalk." "the asking session gets the receipt, in plain text"
NOTE2=$(hook hook_event_name=UserPromptSubmit session_id=asker "cwd=$TMP" prompt=hi | msg)
check "$NOTE2" "" "once"
has "$(bun src/cli.ts gather)" "every running Claude session already has crosstalk" "nothing is left to bring in"
has "$(CROSSTALK_NO_WAITER=1 bun src/cli.ts restore)" "nothing to restore" "and restore does not take the restarts for crashes"
hasnt "$(cat "$TMP/signals")" "asker" "the asking session was never touched"

echo
echo "a watched session lost to a crash is restored like any other"
tmux new-window -d -t work:2 -c "$D1" sh
tmux send-keys -t work:2 "STUB_ID=sess-crash claude" Enter
for _ in $(seq 1 50); do [ -n "$(regfile sess-crash)" ] && break; sleep 0.2; done
CP=$(basename "$(regfile sess-crash)" .json)
CROSSTALK_WATCH_EVERY_MS=0 hook hook_event_name=Stop session_id=asker "cwd=$TMP" >/dev/null
has "$(cat "$CROSSTALK_HOME/open/sess-crash.json" 2>/dev/null)" '"adopted": "watched"' "any hook's throttled watch records it"
kill -9 "$CP" 2>/dev/null   # the crash: its registry file stays behind
sleep 0.3
has "$(CROSSTALK_NO_WAITER=1 bun src/cli.ts restore)" "1 session to restore" "restore offers it back"

echo
[ $FAILED -eq 0 ] && echo "gather: all $PASSES passed" || echo "gather: failures"
exit $FAILED
