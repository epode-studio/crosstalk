#!/usr/bin/env bash
# The terminal workspace, through real git, real tmux and the real hook.
#
#   bash test/terminal.sh
#
# A repository with node_modules and a .venv, and the person's own tmux with
# one session in it. From that session: two new agents get two worktrees on
# new branches, their dependencies linked not copied, and two new tmux windows
# in the same tmux session, each running the stub `claude "<task>"` in its
# worktree. A background agent runs in crosstalk's own tmux server, and
# "show me" attaches to it from a new window. Its hooks put working, waiting
# and done on its tmux window, and its name through sessionTitle. After one
# branch is merged, cleanup offers once and removes exactly that worktree.

set -u
export CROSSTALK_NO_GATHER=1
cd "$(dirname "$0")/.."
ROOT=$(pwd)
TMP=$(mktemp -d)
export CROSSTALK_HOME="$TMP/home"
export TMUX_TMPDIR="$TMP/tmux"
export CROSSTALK_NO_WAITER=1 CROSSTALK_NO_OPEN=1 CROSSTALK_TAB_GAP_MS=150 CROSSTALK_CLEANUP_EVERY_MS=0
export GIT_AUTHOR_NAME=t GIT_AUTHOR_EMAIL=t@t GIT_COMMITTER_NAME=t GIT_COMMITTER_EMAIL=t@t
unset TMUX TMUX_PANE TERM_PROGRAM CLAUDE_CODE_MESSAGING_SOCKET CLAUDE_CODE_SESSION_ID
mkdir -p "$CROSSTALK_HOME" "$TMUX_TMPDIR" "$TMP/bin"
FAILED=0
PASSES=0
pass() { echo "  PASS  $1"; PASSES=$((PASSES+1)); }
fail() { echo "  FAIL  $1"; FAILED=1; }
check() { if [ "$1" = "$2" ]; then pass "$3"; else fail "$3 (wanted '$2', got '$1')"; fi; }
has() { case "$1" in *"$2"*) pass "$3" ;; *) fail "$3"; echo "        got: $1" | head -c 1200; echo ;; esac; }
hasnt() { case "$1" in *"$2"*) fail "$3"; echo "        got: $1" | head -c 1200; echo ;; *) pass "$3" ;; esac; }
cleanup() { tmux kill-server 2>/dev/null; tmux -L crosstalk kill-server 2>/dev/null; rm -rf "$TMP"; }
trap cleanup EXIT
# wait_for <seconds> <command...>: until the command prints something non-empty.
wait_eq() { local want=$1; shift; local got=""; for _ in $(seq 1 40); do got=$("$@" 2>/dev/null); [ "$got" = "$want" ] && break; sleep 0.1; done; echo "$got"; }

cat >"$TMP/bin/claude" <<EOF
#!/bin/sh
printf '%s|%s\n' "\$(pwd)" "\$*" >>"$TMP/calls"
exec sleep 600
EOF
chmod +x "$TMP/bin/claude"
export PATH="$TMP/bin:$PATH"

REPO="$TMP/code/my repo"
mkdir -p "$REPO"
git -C "$REPO" init -q -b main
printf 'node_modules/\n.venv/\n' >"$REPO/.gitignore"
echo one >"$REPO/a.txt"
git -C "$REPO" add . && git -C "$REPO" commit -qm init
mkdir -p "$REPO/node_modules/left-pad" "$REPO/.venv/bin"
echo pad >"$REPO/node_modules/left-pad/index.js"

ct() { bun "$ROOT/src/cli.ts" "$@"; }
json() { bun -e 'console.log(JSON.stringify(Object.fromEntries(process.argv.slice(1).map(a => { const i = a.indexOf("="); return [a.slice(0, i), a.slice(i + 1)] }))))' "$@"; }

echo "state in $TMP"
echo
echo "two new agents, from a session in the person's own tmux"
tmux new-session -d -s work -x 200 -y 50 -c "$REPO"
SOCK=$(tmux display -p '#{socket_path}')
THEIR_FORMAT=$(tmux show-options -g window-status-format; tmux show-options -g status-format)
PANE=$(tmux display -p -t work:0 '#{pane_id}')
OUT=$(cd "$REPO" && TMUX="$SOCK,1,0" TMUX_PANE="$PANE" ct spawn --count 2 --name auth "make the auth tokens expire after an hour")
has "$OUT" "started 2 agents (auth-1, auth-2)" "says it started two, by name"
has "$OUT" "tmux session \"work\"" "in the tmux session that holds the repo"
WT1="$CROSSTALK_HOME/worktrees/my-repo/auth-1"
WT2="$CROSSTALK_HOME/worktrees/my-repo/auth-2"
LIST=$(git -C "$REPO" worktree list --porcelain)
has "$LIST" "worktree $WT1" "a worktree for the first"
has "$LIST" "worktree $WT2" "and for the second"
has "$LIST" "branch refs/heads/crosstalk/auth-1" "each on a new branch"
has "$LIST" "branch refs/heads/crosstalk/auth-2" "of its own"
check "$(readlink "$WT1/node_modules")" "$REPO/node_modules" "node_modules is linked from the main checkout"
check "$(readlink "$WT2/.venv")" "$REPO/.venv" "and the virtualenv"
check "$(cat "$WT1/node_modules/left-pad/index.js")" "pad" "the dependencies are there through the link"
check "$(git -C "$WT1" status --porcelain)" "" "the links leave the worktree clean"
WINS=$(wait_eq 3 sh -c "tmux list-windows -t =work -F x | wc -l | tr -d ' '")
check "$WINS" "3" "two new windows in the same tmux session"
check "$(tmux display -p -t work:0 '#{window_active}')" "1" "focus stays where it was"
sleep 0.5
CALLS=$(cat "$TMP/calls" 2>/dev/null)
has "$CALLS" "$WT1|make the auth tokens expire after an hour" "the first runs claude with the task in its worktree"
has "$CALLS" "$WT2|make the auth tokens expire after an hour" "and so does the second"
PATHS=$(tmux list-panes -s -t =work -F '#{pane_current_path}')
has "$PATHS" "$WT1" "its window is in the first worktree"
has "$PATHS" "$WT2" "and the second's in the second"

echo
echo "a name taken is not reused"
OUT=$(cd "$REPO" && TMUX="$SOCK,1,0" TMUX_PANE="$PANE" ct spawn --name auth "another one on auth")
has "$OUT" "(auth)" "a single agent takes the bare name"
OUT=$(cd "$REPO" && TMUX="$SOCK,1,0" TMUX_PANE="$PANE" ct spawn --name auth "and one more")
has "$OUT" "(auth-3)" "the next skips the names already taken"

echo
echo "a background agent, in crosstalk's own tmux"
OUT=$(cd "$REPO" && TMUX="$SOCK,1,0" TMUX_PANE="$PANE" ct spawn --background --name bg "watch the logs")
has "$OUT" "in the background" "says it runs in the background"
has "$OUT" 'show me bg' "and how to see it"
if tmux -L crosstalk has-session -t =bg 2>/dev/null; then pass "it is a tmux session in tmux -L crosstalk"; else fail "it is a tmux session in tmux -L crosstalk"; fi
check "$(tmux has-session -t =bg 2>/dev/null; echo $?)" "1" "and not in the person's own server"
WTB="$CROSSTALK_HOME/worktrees/my-repo/bg"
sleep 0.3
has "$(cat "$TMP/calls")" "$WTB|watch the logs" "running claude with its task in its worktree"
BSOCK=$(tmux -L crosstalk display -p -t =bg: '#{socket_path}')
BPANE=$(tmux -L crosstalk display -p -t =bg: '#{pane_id}')

echo
echo "show me bg"
BEFORE=$(tmux list-windows -t =work -F x | wc -l | tr -d ' ')
OUT=$(cd "$REPO" && TMUX="$SOCK,1,0" TMUX_PANE="$PANE" ct show bg)
has "$OUT" "opened bg in a new tab" "says it opened it"
AFTER=$(wait_eq $((BEFORE + 1)) sh -c "tmux list-windows -t =work -F x | wc -l | tr -d ' '")
check "$AFTER" "$((BEFORE + 1))" "a new window in the person's tmux"
has "$(tmux list-windows -t =work -F '#{pane_start_command}')" "tmux -L crosstalk attach-session -t =bg" "attached to the background agent"
CLIENTS=$(wait_eq 1 sh -c "tmux -L crosstalk list-clients -t =bg | wc -l | tr -d ' '")
check "$CLIENTS" "1" "and it really is attached"
has "$(ct show nope)" "no background agent called nope" "an unknown name says so, and lists the ones there are"

echo
echo "status on its tab, from its own hooks"
# The background agent's hooks run inside its pane in crosstalk's server.
bhook() { json "$@" | TMUX="$BSOCK,1,0" TMUX_PANE="$BPANE" bun "$ROOT/src/hook.ts" 2>&1; }
state() { tmux -L crosstalk show-options -w -t "$BPANE" -v @crosstalk_state 2>/dev/null; }
OUT=$(bhook hook_event_name=SessionStart session_id=bg-sess "cwd=$WTB" source=startup)
has "$OUT" '"sessionTitle":"bg"' "a spawned agent's session is named after it, through sessionTitle"
hasnt "$OUT" ']0;' "and the title is never set by escape code"
T0=$(date +%s%N)
OUT=$(bhook hook_event_name=UserPromptSubmit session_id=bg-sess "cwd=$WTB" prompt=go)
T1=$(date +%s%N)
has "$OUT" '"terminalSequence":"\u001b]9;4;3\u001b\\"' "the hook returns OSC 9;4 progress while working"
check "$(wait_eq working state)" "working" "its tmux window says working"
MS=$(( (T1 - T0) / 1000000 ))
if [ "$MS" -lt 1500 ]; then pass "the hook did not wait for the terminal (${MS}ms with bun startup)"; else fail "the hook took ${MS}ms"; fi
bhook hook_event_name=Notification session_id=bg-sess "cwd=$WTB" notification_type=permission_prompt "message=Claude needs your permission to use Bash" >/dev/null
check "$(wait_eq waiting state)" "waiting" "a permission prompt is waiting on you"
bhook hook_event_name=PostToolUse session_id=bg-sess "cwd=$WTB" tool_name=Bash >/dev/null
check "$(wait_eq working state)" "working" "answered, it is working again"
OUT=$(bhook hook_event_name=Stop session_id=bg-sess "cwd=$WTB")
has "$OUT" '"terminalSequence":"\u001b]9;4;0\u001b\\"' "done clears the progress"
check "$(wait_eq done state)" "done" "a finished turn is done"
bhook hook_event_name=UserPromptSubmit session_id=bg-sess "cwd=$WTB" prompt=again >/dev/null
check "$(wait_eq working state)" "working" "working again"
CROSSTALK_HOME="$CROSSTALK_HOME" bun -e '
  const ui = await import(process.argv[1] + "/src/uistate.ts")
  ui.withStore((items, now) => ui.upsert(items, { id: "msg:1", kind: "message", sessionId: "bg-sess", from: "ben", text: "hi" }, now))
' "$ROOT"
bhook hook_event_name=Stop session_id=bg-sess "cwd=$WTB" >/dev/null
check "$(wait_eq waiting state)" "waiting" "a turn ending with something of crosstalk's pending is waiting on you"
# Three changes in a row: the last one lands.
for s in working done waiting done; do ct term status --session bg-sess --state $s >/dev/null; done
check "$(wait_eq done state)" "done" "of quick changes, the last one lands"
check "$(tmux show-options -g window-status-format; tmux show-options -g status-format)" "$THEIR_FORMAT" "the person's own status line is left alone"
bhook hook_event_name=SessionEnd session_id=bg-sess "cwd=$WTB" reason=prompt_input_exit >/dev/null
check "$(wait_eq "" state)" "" "an ended session takes its state off the window"

echo
echo "cleanup, after one branch is merged"
echo two >"$WT1/b.txt" && git -C "$WT1" add b.txt && git -C "$WT1" commit -qm "auth-1 work"
echo three >"$WT2/c.txt" && git -C "$WT2" add c.txt && git -C "$WT2" commit -qm "auth-2 work"
git -C "$REPO" merge -q --no-ff -m "merge auth-1" crosstalk/auth-1
git -C "$REPO" worktree add -q "$TMP/code/theirs" -b theirs
OUT=$(json hook_event_name=SessionStart session_id=other-sess "cwd=$REPO" source=startup | bun "$ROOT/src/hook.ts")
has "$OUT" "agent worktree is done with" "the next session offers once"
has "$OUT" "auth-1" "naming the merged one"
hasnt "$OUT" "auth-2" "and not the unmerged one"
OUT=$(json hook_event_name=SessionStart session_id=other-sess2 "cwd=$REPO" source=startup | bun "$ROOT/src/hook.ts")
hasnt "$OUT" "done with" "and only once"
LIST=$(cd "$REPO" && ct cleanup)
has "$LIST" "auth-1" "the list names the merged one"
has "$LIST" "theirs" "and a merged worktree crosstalk did not make, apart"
has "$LIST" "Still in use or not merged:" "and what stays"
OUT=$(cd "$REPO" && ct cleanup --yes)
has "$OUT" "removed 1 worktree, freeing" "removes one, saying how much space it freed"
if [ -e "$WT1" ]; then fail "the merged worktree is gone"; else pass "the merged worktree is gone"; fi
if [ -d "$WT2" ]; then pass "the unmerged one stays"; else fail "the unmerged one stays"; fi
if [ -d "$WTB" ]; then pass "the background agent's stays (its session is running)"; else fail "the background agent's stays"; fi
if [ -d "$TMP/code/theirs" ]; then pass "one crosstalk did not make stays, unless named"; else fail "one crosstalk did not make stays"; fi
check "$(cat "$REPO/node_modules/left-pad/index.js")" "pad" "the main checkout's node_modules is untouched"
check "$(git -C "$REPO" branch --list crosstalk/auth-1)" "" "the merged branch is deleted"
has "$(git -C "$REPO" worktree list)" "$WT2" "git still knows the rest"
hasnt "$(git -C "$REPO" worktree list)" "$WT1" "and has pruned the removed one"
OUT=$(cd "$REPO" && ct cleanup --yes --include "$TMP/code/theirs")
has "$OUT" "removed 1 worktree" "named, the other one goes too"
if [ -e "$TMP/code/theirs" ]; then fail "it is gone"; else pass "it is gone"; fi

echo
echo "the tmux snippet for the person's own status line"
has "$(ct term tmux-snippet)" "set -ga window-status-format" "appends to their format, never replaces it"

echo
echo "$PASSES passed"
[ $FAILED -eq 0 ] && echo "all passed" || { echo "SOME FAILED"; exit 1; }
