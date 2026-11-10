#!/usr/bin/env bash
# A task handed to a session can be finished by its id from wherever the
# session is now. Real git, a real daemon and the real hook.
#
#   bash test/task-done.sh
#
# The plugin keeps a session's open items as tasks in the thread of the
# worktree it was in at the time (ids t_ + 10 hex). The session then moves to
# another worktree, so its thread changes. Finishing the task by id must still
# work, and a task nobody has must be refused with the reason.

set -u
export CROSSTALK_NO_GATHER=1 CROSSTALK_NO_REPOTRUST=1 CROSSTALK_NO_NOTIFY=1 CROSSTALK_NO_WAITER=1 CROSSTALK_NO_OPEN=1 CROSSTALK_NO_RESTORE=1
export CROSSTALK_THREAD_SETTLE_MS=300 CROSSTALK_THREAD_SYNC_MS=600000 CROSSTALK_THREADS_NO_PUSH=1
export CROSSTALK_CLEANUP_EVERY_MS=0 CROSSTALK_NO_RECAP=1
cd "$(dirname "$0")/.."
ROOT=$(pwd)
TMP=$(mktemp -d)
export CROSSTALK_HOME="$TMP/home"
export HOME="$TMP/userhome"
export GIT_AUTHOR_NAME=t GIT_AUTHOR_EMAIL=t@t GIT_COMMITTER_NAME=t GIT_COMMITTER_EMAIL=t@t
unset TMUX TMUX_PANE TERM_PROGRAM CLAUDE_CODE_SESSION_ID CLAUDECODE CLAUDE_CODE_MESSAGING_SOCKET CROSSTALK_BG_AGENT
mkdir -p "$CROSSTALK_HOME" "$HOME"
FAILED=0
PASSES=0
pass() { echo "  PASS  $1"; PASSES=$((PASSES+1)); }
fail() { echo "  FAIL  $1"; FAILED=1; }
check() { if [ "$1" = "$2" ]; then pass "$3"; else fail "$3 (wanted '$2', got '$1')"; fi; }
has() { case "$1" in *"$2"*) pass "$3" ;; *) fail "$3"; echo "        got: $1" | head -c 1500; echo ;; esac; }
stop_daemon() {
  if [ -f "$CROSSTALK_HOME/daemon.lock" ]; then
    P=$(cat "$CROSSTALK_HOME/daemon.lock")
    kill "$P" 2>/dev/null
    for _ in $(seq 1 30); do kill -0 "$P" 2>/dev/null || break; sleep 0.2; done
  fi
  rm -f "$CROSSTALK_HOME/daemon.sock" "$CROSSTALK_HOME/daemon.lock"
}
cleanup() { stop_daemon; rm -rf "$TMP"; }
trap cleanup EXIT
rpc() { bun -e '
  const { request } = await import("./src/client.ts")
  console.log(JSON.stringify(await request(JSON.parse(process.argv[1]), 60000)))
' "$1" 2>&1; }
field() { echo "$1" | bun -e 'const r = JSON.parse(await Bun.stdin.text()); const v = (0, eval)("(r) => " + process.argv[1])(r); console.log(typeof v === "string" ? v : JSON.stringify(v ?? null))' "$2"; }
names_of() { field "$(rpc "{\"op\":\"threads\",\"sessionId\":\"$1\"}")" 'r.threads.map(t => t.name).join(",")'; }
hook() { printf '%s' "$1" | bun "$ROOT/src/hook.ts" 2>&1; }
# The legacy tool handler the MCP tool calls, as the session at $2 would.
done_tool() { bun -e '
  const { callLegacy } = await import("./src/tools/legacy.ts")
  const r = await callLegacy("crosstalk_task_done", { id: process.argv[1] }, { sessionId: "s1", cwd: process.argv[2] })
  console.log(JSON.stringify(r))
' "$1" "$2" 2>&1; }

repo() { # dir branch area
  mkdir -p "$1/src/$3"
  git -C "$1" init -q -b main
  git -C "$1" remote add origin "git@github.com:acme/$(basename "$1").git"
  for f in a b c; do echo "export const v = 1" >"$1/src/$3/$f.ts"; done
  git -C "$1" add . && git -C "$1" commit -qm init
  git -C "$1" checkout -q -b "$2"
}
work_in() { # session dir area
  hook "{\"hook_event_name\":\"SessionStart\",\"session_id\":\"$1\",\"cwd\":\"$2\",\"source\":\"startup\"}" >/dev/null
  for f in a b c; do
    hook "{\"hook_event_name\":\"PostToolUse\",\"session_id\":\"$1\",\"cwd\":\"$2\",\"tool_name\":\"Edit\",\"tool_input\":{\"file_path\":\"$2/src/$3/$f.ts\"}}" >/dev/null
  done
}
API="$TMP/code/api"; WEB="$TMP/code/web"
repo "$API" token-expiry auth
repo "$WEB" staging-redirects pages

bun -e '
  const { newIdentity } = await import("./src/crypto.ts")
  const { saveIdentity, saveRelay } = await import("./src/config.ts")
  saveIdentity({ ...newIdentity("ana"), machine: "desk" })
  saveRelay("ws://127.0.0.1:9")
'
nohup bun src/daemon.ts >>"$TMP/daemon.log" 2>&1 &
for _ in $(seq 1 40); do [ -S "$CROSSTALK_HOME/daemon.sock" ] && break; sleep 0.25; done
echo "state in $TMP"

echo
echo "a session in api keeps an open item as a task in its thread"
work_in s1 "$API" auth
FIRST=$(names_of s1)
check "$([ -n "$FIRST" ] && echo yes)" "yes" "the session is in a thread ($FIRST)"
ADD=$(rpc "{\"op\":\"tasks\",\"sessionId\":\"s1\",\"cwd\":\"$API\",\"write\":\"add\",\"text\":\"write the expiry migration\"}")
ID=$(field "$ADD" 'r.id')
check "$(field "$ADD" 'r.thread')" "$FIRST" "the task is kept in that thread"
check "$(echo "$ID" | grep -cE '^t_[0-9a-f]{10}$')" "1" "with a thread task id ($ID)"

echo
echo "the session moves to another worktree, so its thread changes"
work_in s1 "$WEB" pages
NOW=$(names_of s1)
check "$([ -n "$NOW" ] && [ "$NOW" != "$FIRST" ] && echo moved)" "moved" "it is in another thread now ($NOW)"

echo
echo "it finishes the task it was handed, by id"
OUT=$(done_tool "$ID" "$WEB")
check "$(field "$OUT" 'r.isError ? r.content[0].text : JSON.parse(r.content[0].text).done')" "$ID" "marked done from the other worktree"
STATE=$(field "$(rpc "{\"op\":\"notes\",\"thread\":\"$FIRST\",\"kind\":\"task\"}")" "r.notes.find(n => n.id === \"$ID\")?.state")
check "$STATE" "done" "and the task in $FIRST is done"

echo
echo "a task nobody has is refused, saying where it looked"
OUT=$(done_tool "t_00000000ff" "$WEB")
has "$OUT" "no task t_00000000ff" "names the task"
has "$OUT" "$NOW" "names the thread it looked in"
has "$OUT" "and no room joined" "and that there is no room to look in"

echo
echo "with a room joined, the room is looked in too"
bun -e '
  const rooms = await import("./src/rooms.ts")
  const s = rooms.load(); s.r1 = { id: "r1", name: "macbook", keys: {}, epoch: 0, members: {} }; rooms.save(s)
' >/dev/null 2>&1
OUT=$(done_tool "t_00000000ff" "$WEB")
has "$OUT" "no task t_00000000ff in thread $NOW or room macbook" "names the thread and the room"

echo
[ "$FAILED" = 0 ] && echo "all $PASSES passed" || { echo "FAILED ($PASSES passed)"; tail -20 "$TMP/daemon.log"; }
exit "$FAILED"
