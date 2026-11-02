#!/usr/bin/env bash
# Disk, team install, stats and a library's heads-up, through a real daemon.
#
#   bash test/extras.sh
#
# One identity, no relay: everything here happens on one machine. Two repos,
# a library (acme/lib) and an app that depends on it through package.json,
# each with a session in a thread. A Claude Code data folder of its own holds a
# finished worktree and an old transcript.
#
#   1. an edit to the library's public surface    the app's session holds a heads-up
#      an edit elsewhere in the library           it does not
#   2. crosstalk_disk lists                        nothing is removed
#      crosstalk_disk confirm                      the worktree and transcript go
#   3. crosstalk_team_install                      settings merged, unstaged
#   4. crosstalk_stats                             reads back, local only

set -u
export CROSSTALK_NO_GATHER=1 CROSSTALK_NO_RESTORE=1 CROSSTALK_THREADS_NO_PUSH=1 CROSSTALK_NO_EXTRAS_TICK=1 CROSSTALK_NO_REPOTRUST=1
export CROSSTALK_THREAD_SETTLE_MS=300 CROSSTALK_THREAD_SYNC_MS=600000
# Nothing here needs a relay: point it at a port nobody listens on.
export CROSSTALK_RELAY=ws://127.0.0.1:9
cd "$(dirname "$0")/.."
TMP=$(mktemp -d)
A="$TMP/a"; R="$TMP/repos"; C="$TMP/claude"
export CROSSTALK_CLAUDE_DIR="$C"
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
rpc() { CROSSTALK_HOME="$1" bun -e '
  const { request } = await import("./src/client.ts")
  console.log(JSON.stringify(await request(JSON.parse(process.argv[1]))))
' "$2" 2>&1; }
field() { echo "$1" | bun -e 'const r = JSON.parse(await Bun.stdin.text()); const v = (0, eval)("(r) => " + process.argv[1])(r); console.log(typeof v === "string" ? v : JSON.stringify(v ?? null))' "$2"; }
cleanup() {
  stop_daemon "$A"
  rm -rf "$TMP"
}
trap cleanup EXIT
mkdir -p "$A" "$R" "$C/projects/-app"
echo "state in $TMP"

g() { git -C "$1" -c user.email=t@t -c user.name=t "${@:2}"; }
repo() { # dir remote branch
  mkdir -p "$1" && git -C "$1" init -q -b main && git -C "$1" remote add origin "$2"
  echo node_modules >"$1/.gitignore"; echo .claude/ >>"$1/.gitignore"
  g "$1" add . && g "$1" commit -q -m init
  g "$1" checkout -q -b "$3"
}
repo "$R/lib" "git@github.com:acme/lib.git" v2
echo '{"name":"lib","main":"dist/index.js"}' >"$R/lib/package.json"
repo "$R/app" "https://github.com/acme/app.git" auth
echo '{"name":"app","dependencies":{"lib":"github:acme/lib"}}' >"$R/app/package.json"

# A finished Claude Code worktree in the app, and one still being worked on.
g "$R/app" worktree add -q -b done "$R/app/.claude/worktrees/done" main
g "$R/app" worktree add -q -b wip "$R/app/.claude/worktrees/wip" main
echo x >"$R/app/.claude/worktrees/wip/x"
g "$R/app/.claude/worktrees/wip" add x && g "$R/app/.claude/worktrees/wip" commit -q -m wip
# Transcripts: one for the app (so it is a repo with sessions), one old for a folder gone.
echo "{\"type\":\"user\",\"cwd\":\"$R/app\"}" >"$C/projects/-app/live.jsonl"
echo "{\"type\":\"user\",\"cwd\":\"$TMP/gone\"}" >"$C/projects/-app/old.jsonl"
touch -d "45 days ago" "$C/projects/-app/old.jsonl"

CROSSTALK_HOME="$A" bun -e '
  const { saveIdentity } = await import("./src/config.ts")
  const { newIdentity } = await import("./src/crypto.ts")
  saveIdentity(newIdentity("ana"))
'
CROSSTALK_HOME="$A" nohup bun src/daemon.ts >>"$TMP/da.log" 2>&1 &
for _ in $(seq 1 40); do [ -S "$A/daemon.sock" ] && break; sleep 0.25; done
[ -S "$A/daemon.sock" ] || { echo "daemon did not start"; cat "$TMP/da.log"; exit 1; }

reg() { rpc "$A" "{\"op\":\"register\",\"sessionId\":\"$1\",\"pid\":1,\"name\":\"$1\",\"cwd\":\"$2\",\"socket\":\"\",\"touched\":$3}" >/dev/null; }
reg app-s "$R/app" '["src/login.ts"]'
reg lib-s "$R/lib" '["src/index.ts"]'
sleep 0.5

echo
echo "1. a library's surface changes"
check "$(field "$(rpc "$A" '{"op":"threads","sessionId":"app-s"}')" 'r.threads.map(t => t.name).join(",")')" "auth" "the app's session is in its thread"
E=$(rpc "$A" "{\"op\":\"edited\",\"sessionId\":\"lib-s\",\"edit\":{\"file\":\"src/index.ts\",\"root\":\"$R/lib\",\"symbols\":[\"login\"],\"pending\":[\"login\"],\"diff\":\"-export function login(a)\\n+export function login(a, b)\"}}")
check "$(field "$E" 'r.dependents?.join(",")')" "auth" "the edit names the dependent thread"
M=$(rpc "$A" '{"op":"read","sessionId":"app-s","all":true}')
has "$M" "part of acme/lib's public surface, which acme/app depends on" "the app's session holds a heads-up"
has "$M" "\"label\":\"diff of acme/lib/src/index.ts\",\"bytes\":54" "with the diff attached as a slice"
E2=$(rpc "$A" "{\"op\":\"edited\",\"sessionId\":\"lib-s\",\"edit\":{\"file\":\"test/x.test.ts\",\"root\":\"$R/lib\",\"symbols\":[],\"pending\":[],\"diff\":\"+t\"}}")
check "$(field "$E2" 'r.dependents ?? null')" "null" "a test file is not the surface"

echo
echo "2. disk"
D=$(rpc "$A" '{"op":"disk","sessionId":"app-s"}')
has "$(field "$D" 'r.text')" ".claude/worktrees/done" "the finished worktree is listed"
has "$(field "$D" 'r.text')" "old.jsonl" "and the old transcript"
hasnt "$(field "$D" 'r.text')" "worktrees/wip " "the unmerged one is not"
[ -d "$R/app/.claude/worktrees/done" ] && [ -f "$C/projects/-app/old.jsonl" ] && pass "listing removed nothing" || fail "listing removed something"
F=$(rpc "$A" '{"op":"disk","sessionId":"app-s","confirm":true}')
has "$(field "$F" 'r.text')" "freed" "free it"
[ ! -d "$R/app/.claude/worktrees/done" ] && pass "the worktree is gone" || fail "the worktree is still there"
[ ! -f "$C/projects/-app/old.jsonl" ] && pass "the transcript is gone" || fail "the transcript is still there"
[ -d "$R/app/.claude/worktrees/wip" ] && [ -f "$C/projects/-app/live.jsonl" ] && pass "the rest is kept" || fail "something else went"

echo
echo "3. teammates install nothing"
mkdir -p "$R/app/.claude" && echo '{"permissions":{"allow":["Bash(ls)"]}}' >"$R/app/.claude/settings.json"
T=$(rpc "$A" "{\"op\":\"team_install\",\"sessionId\":\"app-s\",\"cwd\":\"$R/app\",\"repo\":\"acme/app\",\"confirm\":true}")
has "$(field "$T" 'r.text')" "unstaged change" "it says to commit it"
S=$(cat "$R/app/.claude/settings.json")
has "$S" '"crosstalk@epode": true' "the plugin is enabled"
has "$S" '"repo": "epode-studio/crosstalk"' "from crosstalk's marketplace"
has "$S" 'Bash(ls)' "the existing settings are kept"

echo
echo "4. stats"
ST=$(rpc "$A" '{"op":"stats","sessionId":"app-s"}')
has "$(field "$ST" 'r.text')" "never sent anywhere" "stats read back"
grep -q '"k":"' "$A/metrics.jsonl" 2>/dev/null || true

echo
[ $FAILED -eq 0 ] && echo "extras: all $PASSES passed" || { echo "extras: FAILED"; tail -30 "$TMP/da.log"; }
exit $FAILED
