#!/usr/bin/env bash
# Restore after a restart, through the real hook and real tmux.
#
#   bash test/restore.sh
#
# Sessions announce themselves from tmux panes, the machine "restarts" (the
# tmux server is killed, their pids are dead and the boot time is moved past
# them), and the next session opened has to ask once, keep the question out of
# the model's context, and on `@restore` put each one back in its tmux session,
# in its old window order, in its folder, running `claude --resume <id>`. A
# stub `claude` on PATH records what it was started with.

set -u
export CROSSTALK_NO_GATHER=1  # sessions started before crosstalk: test/gather.sh, with a registry of its own
cd "$(dirname "$0")/.."
ROOT=$(pwd)
TMP=$(mktemp -d)
export CROSSTALK_HOME="$TMP/home"
export TMUX_TMPDIR="$TMP/tmux"
export CROSSTALK_NO_WAITER=1 CROSSTALK_NO_OPEN=1
unset TMUX TMUX_PANE TERM_PROGRAM CLAUDE_CODE_MESSAGING_SOCKET CLAUDE_CODE_SESSION_ID
mkdir -p "$CROSSTALK_HOME" "$TMUX_TMPDIR" "$TMP/bin"
FAILED=0
PASSES=0
pass() { echo "  PASS  $1"; PASSES=$((PASSES+1)); }
fail() { echo "  FAIL  $1"; FAILED=1; }
check() { if [ "$1" = "$2" ]; then pass "$3"; else fail "$3 (wanted '$2', got '$1')"; fi; }
has() { case "$1" in *"$2"*) pass "$3" ;; *) fail "$3"; echo "        got: $1" | head -c 800; echo ;; esac; }
hasnt() { case "$1" in *"$2"*) fail "$3"; echo "        got: $1" | head -c 800; echo ;; *) pass "$3" ;; esac; }
cleanup() { tmux kill-server 2>/dev/null; rm -rf "$TMP"; }
trap cleanup EXIT

# The stand-in for claude: say where it was started and with what, then stay
# open like a session would.
cat >"$TMP/bin/claude" <<EOF
#!/bin/sh
printf '%s|%s\n' "\$(pwd)" "\$*" >>"$TMP/calls"
exec sleep 600
EOF
chmod +x "$TMP/bin/claude"
export PATH="$TMP/bin:$PATH"

D1="$TMP/dir with space"
D2="$TMP/it's \"quoted\""
D3="$TMP/gone-dir"
D4="$TMP/ended"
mkdir -p "$D1" "$D2" "$D3" "$D4"

json() { bun -e 'console.log(JSON.stringify(Object.fromEntries(process.argv.slice(1).map(a => { const i = a.indexOf("="); return [a.slice(0, i), a.slice(i + 1)] }))))' "$@"; }
# hook <pane|-> key=value...   runs the hook as Claude Code would, from that tmux pane
hook() {
  local pane=$1; shift
  if [ "$pane" = "-" ]; then
    json "$@" | bun src/hook.ts 2>&1
  else
    local sock; sock=$(tmux display -p '#{socket_path}')
    json "$@" | TMUX="$sock,1,0" TMUX_PANE="$pane" bun src/hook.ts 2>&1
  fi
}
pane() { tmux display -p -t "$1" '#{pane_id}'; }

echo "state in $TMP"
echo
echo "sessions announce themselves from their tabs"
tmux new-session -d -s work -x 200 -y 50
tmux new-window -d -t work:3
tmux new-window -d -t work:5
tmux new-session -d -s gone
hook "$(pane work:5)" hook_event_name=SessionStart session_id=sess-a "cwd=$D1" source=startup >/dev/null
hook "$(pane work:3)" hook_event_name=SessionStart session_id=sess-b "cwd=$D2" source=startup >/dev/null
hook "$(pane gone:0)" hook_event_name=SessionStart session_id=sess-c "cwd=$D3" source=startup >/dev/null
hook "$(pane work:0)" hook_event_name=SessionStart session_id=sess-ended "cwd=$D4" source=startup >/dev/null
hook "$(pane work:0)" hook_event_name=SessionEnd session_id=sess-ended "cwd=$D4" reason=prompt_input_exit >/dev/null
REC=$(cat "$CROSSTALK_HOME/open/sess-a.json")
has "$REC" '"session": "work"' "the tmux session is recorded"
has "$REC" '"window": 5' "and the window index"
has "$REC" "\"cwd\": \"$D1\"" "and the folder"
has "$(cat "$CROSSTALK_HOME/open/sess-ended.json")" '"endReason": "prompt_input_exit"' "a normal exit is recorded as one"

echo
echo "the machine restarts"
tmux kill-server
DEAD=$(bun -e 'const p = Bun.spawn(["true"]); await p.exited; console.log(p.pid)')
NOW_MS=$(bun -e 'console.log(Date.now())')
export CROSSTALK_BOOT_TIME=$((NOW_MS - 5 * 60 * 1000))
bun -e '
  const R = await import("./src/restore.ts")
  for (const r of R.readAll()) R.writeRec({ ...r, pid: Number(process.argv[1]), pidStart: undefined, seenAt: Number(process.argv[2]) - 10 * 60 * 1000 })
' "$DEAD" "$NOW_MS"
tmux new-session -d -s work -x 200 -y 50   # the person opens tmux again

echo
echo "the first session opened asks, once"
OUT=$(hook "$(pane work:0)" hook_event_name=SessionStart session_id=me "cwd=$TMP" source=startup)
MSG=$(echo "$OUT" | bun -e 'const o = JSON.parse(await Bun.stdin.text()); console.log(o.systemMessage ?? "")')
has "$MSG" '3 sessions were open before the restart' "the question counts the lost sessions"
has "$MSG" 'dir with space' "and names them"
has "$MSG" 'Say "restore them"' "and needs no command remembered"
hasnt "$MSG" '@restore' "it does not ask anyone to type a command"
hasnt "$MSG" 'ended' "the session that exited normally is not offered"
hasnt "$OUT" 'additionalContext' "the question is not in the model's context"
AGAIN=$(hook "$(pane work:0)" hook_event_name=SessionStart session_id=me2 "cwd=$TMP" source=startup)
hasnt "$AGAIN" 'systemMessage' "the next session does not ask again"

echo
echo "@restore puts them back"
OUT=$(hook "$(pane work:0)" hook_event_name=UserPromptSubmit session_id=me "cwd=$TMP" "prompt=  @Restore ")
has "$OUT" '"decision":"block"' "the prompt is blocked, so the model never sees it"
has "$OUT" 'reopened 3 sessions' "the reason says what happened"
for _ in $(seq 1 30); do [ "$(wc -l <"$TMP/calls" 2>/dev/null || echo 0)" -ge 3 ] && break; sleep 0.2; done
CALLS=$(cat "$TMP/calls" 2>/dev/null)
has "$CALLS" "$D1|--resume sess-a" "sess-a resumed in its folder (spaces)"
has "$CALLS" "$D2|--resume sess-b" "sess-b resumed in its folder (quotes)"
has "$CALLS" "$D3|--resume sess-c" "sess-c resumed in its folder"
hasnt "$CALLS" "sess-ended" "the ended session was not resumed"
hasnt "$CALLS" "--resume me" "the asking session was not resumed"
WIN=$(tmux list-windows -t work -F '#{window_index}:#{pane_current_path}' | tr '\n' ' ')
check "$WIN" "0:$ROOT 1:$D2 2:$D1 " "work gets windows in their old order (3 before 5)"
check "$(tmux list-windows -t gone -F '#{pane_current_path}')" "$D3" "the tmux session that was gone is created"
check "$(tmux display -p -t work '#{window_index}')" "0" "the person's own window keeps focus (-d)"

OUT=$(hook "$(pane work:0)" hook_event_name=UserPromptSubmit session_id=me "cwd=$TMP" prompt=@restore)
has "$OUT" 'nothing to restore' "asking again finds nothing left"
OUT=$(hook "$(pane work:0)" hook_event_name=UserPromptSubmit session_id=me "cwd=$TMP" "prompt=restore them")
hasnt "$OUT" 'decision' "an ordinary prompt goes through untouched"

echo
echo "a terminal that dies without a restart counts too"
unset CROSSTALK_BOOT_TIME
export CROSSTALK_BOOT_TIME=$((NOW_MS - 3600 * 1000))
hook "$(pane work:0)" hook_event_name=SessionStart session_id=crashed "cwd=$D1" source=startup >/dev/null
hook "$(pane work:0)" hook_event_name=SessionStart session_id=closed "cwd=$D2" source=startup >/dev/null
hook "$(pane work:0)" hook_event_name=SessionEnd session_id=closed "cwd=$D2" reason=other >/dev/null
bun -e '
  const R = await import("./src/restore.ts")
  for (const id of ["crashed", "closed"]) R.writeRec({ ...R.readOne(id), pid: Number(process.argv[1]), pidStart: undefined })
' "$DEAD"
OUT=$(hook "$(pane work:0)" hook_event_name=SessionStart session_id=me3 "cwd=$TMP" source=startup)
has "$OUT" '1 session was open when they were cut off' "a session gone without SessionEnd is offered"
hasnt "$OUT" 'it'"'"'s' "a tab closed on its own is not"

DRY=$(bun src/cli.ts restore --dry-run)
has "$DRY" "tmux new-window -d -t =work: -c '$D1'" "--dry-run shows the exact command"
has "$(bun src/cli.ts restore)" "1 session to restore" "crosstalk restore lists it"
has "$(bun src/cli.ts restore no)" "left 1 session closed" "and restore no forgets it"
check "$(ls "$CROSSTALK_HOME/open" | grep -c crashed)" "0" "its record is gone"

echo
echo "the MCP tool"
hook "$(pane work:0)" hook_event_name=SessionStart session_id=crashed2 "cwd=$D3" source=startup >/dev/null
bun -e 'const R = await import("./src/restore.ts"); R.writeRec({ ...R.readOne("crashed2"), pid: Number(process.argv[1]), pidStart: undefined })' "$DEAD"
MCP=$( (printf '%s\n' \
  '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2024-11-05","capabilities":{},"clientInfo":{"name":"t","version":"1"}}}' \
  '{"jsonrpc":"2.0","id":2,"method":"tools/call","params":{"name":"crosstalk_restore","arguments":{}}}' \
  '{"jsonrpc":"2.0","id":3,"method":"tools/call","params":{"name":"crosstalk_restore","arguments":{"confirm":true}}}'; sleep 3) \
  | CLAUDE_CODE_SESSION_ID=me3 TMUX="$(tmux display -p '#{socket_path}'),1,0" TMUX_PANE="$(pane work:0)" timeout 10 bun src/server.ts 2>/dev/null)
has "$MCP" '1 session to restore' "without confirm it lists"
has "$MCP" 'reopened 1 session' "with confirm it restores"
for _ in $(seq 1 20); do grep -q crashed2 "$TMP/calls" && break; sleep 0.2; done
has "$(cat "$TMP/calls")" "$D3|--resume crashed2" "and the session is back"

echo
[ $FAILED -eq 0 ] && echo "restore: all $PASSES passed" || echo "restore: failures"
exit $FAILED
