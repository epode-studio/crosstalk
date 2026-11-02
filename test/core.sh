#!/usr/bin/env bash
# Core correctness through a real daemon: held messages and who is alive.
#
#   bash test/core.sh
#
#   1. CLAUDE_CONFIG_DIR   Claude Code's registry is read from there: a daemon
#                          restart keeps a live session, and another session
#                          registering does not take its unread messages
#   2. pull mode           a Codex or agy session heard from recently is alive
#                          too: another session does not take its messages
#   3. route, a day later  a held message routed long after it arrived is
#                          delivered, not dropped as a replay
#   4. route, with main    the session the person picked gets it, even with a
#                          main session open
#
# No relay and no peer: what the daemon holds is written to its state before it
# starts, so nothing here depends on timing over a network.

set -u
export CROSSTALK_NO_GATHER=1 CROSSTALK_NO_RESTORE=1 CROSSTALK_NO_TERM=1 CROSSTALK_NO_REPOTRUST=1 CROSSTALK_NO_NOTIFY=1
export CROSSTALK_THREADS_NO_PUSH=1 CROSSTALK_NO_ATTENTION=1 CROSSTALK_NO_WAITER=1 CROSSTALK_NO_OPEN=1
cd "$(dirname "$0")/.."
ROOT=$(pwd)
TMP=$(mktemp -d)
export CROSSTALK_HOME="$TMP/ct"
export HOME="$TMP/home"
export GIT_AUTHOR_NAME=t GIT_AUTHOR_EMAIL=t@t GIT_COMMITTER_NAME=t GIT_COMMITTER_EMAIL=t@t
unset CLAUDE_CONFIG_DIR CLAUDE_CODE_SESSION_ID CLAUDECODE CLAUDE_CODE_MESSAGING_SOCKET CROSSTALK_BG_AGENT TMUX TMUX_PANE
mkdir -p "$CROSSTALK_HOME" "$HOME"
CFG="$TMP/claude-config"
mkdir -p "$CFG/sessions"
FAILED=0
PASSES=0
pass() { echo "  PASS  $1"; PASSES=$((PASSES+1)); }
fail() { echo "  FAIL  $1"; FAILED=1; }
has() { case "$1" in *"$2"*) pass "$3" ;; *) fail "$3"; echo "        got: $1" | head -c 800; echo ;; esac; }
hasnt() { case "$1" in *"$2"*) fail "$3"; echo "        got: $1" | head -c 800; echo ;; *) pass "$3" ;; esac; }
PIDS=""
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
cleanup() {
  stop_daemon
  for p in $PIDS; do kill "$p" 2>/dev/null; done
  rm -rf "$TMP"
}
trap cleanup EXIT
rpc() { bun -e '
  const { request } = await import("./src/client.ts")
  console.log(JSON.stringify(await request(JSON.parse(process.argv[1]), 20000)))
' "$1" 2>&1; }

bun -e '
  const { newIdentity } = await import("./src/crypto.ts")
  const { saveIdentity, saveRelay } = await import("./src/config.ts")
  saveIdentity({ ...newIdentity("ana"), machine: "desk" })
  saveRelay("ws://127.0.0.1:9")
'
REPO="$TMP/code/api"
mkdir -p "$REPO"
git -C "$REPO" init -q -b main
git -C "$REPO" remote add origin git@github.com:acme/api.git
git -C "$REPO" commit -q --allow-empty -m init
OTHER="$TMP/code/web"
mkdir -p "$OTHER"
git -C "$OTHER" init -q -b main
git -C "$OTHER" remote add origin git@github.com:acme/web.git
git -C "$OTHER" commit -q --allow-empty -m init

# Two live Claude Code sessions, as Claude Code lists them, in CLAUDE_CONFIG_DIR.
sleep 600 & P1=$!; sleep 600 & P2=$!
PIDS="$P1 $P2"
touch "$TMP/cc1.sock" "$TMP/cc2.sock"
echo "{\"pid\":$P1,\"sessionId\":\"cc1\",\"name\":\"cc1\",\"cwd\":\"$REPO\",\"messagingSocketPath\":\"$TMP/cc1.sock\",\"updatedAt\":1}" >"$CFG/sessions/$P1.json"
echo "{\"pid\":$P2,\"sessionId\":\"cc2\",\"name\":\"cc2\",\"cwd\":\"$OTHER\",\"messagingSocketPath\":\"$TMP/cc2.sock\",\"updatedAt\":2}" >"$CFG/sessions/$P2.json"

# What the daemon holds when it starts: cc1 registered, an unread message for it
# and one for a pull-mode session, and a message held two days ago, unrouted.
bun -e '
  const [tmp, repo] = process.argv.slice(1)
  const fs = require("fs")
  const home = process.env.CROSSTALK_HOME
  const now = Date.now(), DAY = 24 * 60 * 60 * 1000
  const held = (id, text) => ({ id, from: "ben", fromSession: "ben-s", intent: "fyi", kind: "message", text, slices: [], ts: now - 1000 })
  fs.writeFileSync(home + "/sessions.json", JSON.stringify({
    cc1: { sessionId: "cc1", pid: 1, name: "cc1", cwd: repo, socket: tmp + "/cc1.sock", lastStatus: "idle", seenAt: now },
  }))
  fs.writeFileSync(home + "/queue.json", JSON.stringify({
    cc1: [held("m-cc1", "FOR-CC1-ONLY")],
    codexa: [held("m-codex", "FOR-CODEX-A-ONLY")],
  }))
  const env = { v: 1, id: "old-1", ts: now - 2 * DAY, from: "ben", fromSession: "ben-s", to: "ana", kind: "message", intent: "question", text: "TWO-DAYS-OLD", footprint: { repo: "github.com/acme/docs", branch: "main" } }
  fs.writeFileSync(home + "/unrouted.json", JSON.stringify([{ id: "old-1", label: "ben", env, at: now - 2 * DAY, why: "none" }]))
' "$TMP" "$REPO"

start_daemon CLAUDE_CONFIG_DIR="$CFG"
echo "state in $TMP"

echo
echo "1. CLAUDE_CONFIG_DIR"
# A pull-mode session announces itself first (section 2 checks its messages).
rpc "{\"op\":\"register\",\"sessionId\":\"codexa\",\"pid\":1,\"name\":\"codexa\",\"cwd\":\"$REPO\",\"socket\":\"\"}" >/dev/null
has "$(cat "$CROSSTALK_HOME/sessions.json")" '"cc1"' "a restart keeps a session alive in CLAUDE_CONFIG_DIR's registry"
rpc "{\"op\":\"register\",\"sessionId\":\"cc2\",\"pid\":$P2,\"name\":\"cc2\",\"cwd\":\"$OTHER\",\"socket\":\"$TMP/cc2.sock\"}" >/dev/null
has "$(rpc '{"op":"read","sessionId":"cc1","all":true}')" 'FOR-CC1-ONLY' "another session registering leaves cc1's unread message with cc1"
hasnt "$(rpc '{"op":"read","sessionId":"cc2","all":true}')" 'FOR-CC1-ONLY' "and cc2 did not take it"

echo
echo "2. a pull-mode session heard from recently is alive"
rpc "{\"op\":\"register\",\"sessionId\":\"codexb\",\"pid\":1,\"name\":\"codexb\",\"cwd\":\"$OTHER\",\"socket\":\"\"}" >/dev/null
hasnt "$(rpc '{"op":"read","sessionId":"codexb","all":true}')" 'FOR-CODEX-A-ONLY' "another session registering does not take its messages"
has "$(rpc '{"op":"read","sessionId":"codexa","all":true}')" 'FOR-CODEX-A-ONLY' "they are still its own"

echo
echo "3 and 4. routing a message held two days, with a main session open"
rpc "{\"op\":\"register\",\"sessionId\":\"lead\",\"pid\":$$,\"name\":\"lead\",\"cwd\":\"$REPO\",\"socket\":\"\"}" >/dev/null
rpc "{\"op\":\"register\",\"sessionId\":\"work\",\"pid\":$$,\"name\":\"work\",\"cwd\":\"$REPO\",\"socket\":\"\"}" >/dev/null
has "$(rpc '{"op":"main","sessionId":"lead"}')" '"main":true' "lead is the main session"
has "$(rpc '{"op":"route"}')" 'old-1' "the old message is held"
R=$(rpc '{"op":"route","id":"old-1","session":"work","sessionId":"lead"}')
has "$R" '"ok":true' "routing it to work answers ok"
has "$(rpc '{"op":"read","sessionId":"work","all":true}')" 'TWO-DAYS-OLD' "and it is in work, not dropped as a replay"
hasnt "$(rpc '{"op":"read","sessionId":"lead","all":true}')" 'TWO-DAYS-OLD' "and not redirected to the main session"
hasnt "$(cat "$TMP/daemon.log")" 'dropped stale' "nothing was dropped as stale"

echo
echo "5. an edit nobody else shares needs no report"
has "$(rpc "{\"op\":\"edit_shared\",\"sessionId\":\"work\",\"cwd\":\"$REPO\",\"path\":\"$REPO/src/a.ts\"}")" '"shared":false' "the daemon says no other thread has the file"

echo
[ $FAILED -eq 0 ] && echo "core: all $PASSES passed" || { echo "core: failures"; tail -30 "$TMP/daemon.log"; }
exit $FAILED
