#!/usr/bin/env bash
# The session manager, end to end: real tmux, a stub claude, the MCP server,
# two daemons over a local relay.
#
#   bash test/sessions.sh
#
#   1. close        "close billing" from another session, confirmed on the
#                   mod's picker: SIGTERM to the stub, its dev server left
#                   running, the record archived and not offered by restore.
#                   An agent's shell cannot press the picker; without the mod
#                   it needs the person's own typed words.
#   2. find/resume  found by its recap's words, resumed into a new window of
#                   the person's tmux running `claude --resume <id>`.
#   3. rename/move  reflected in the daemon's session list, the thread's
#                   sessions and the title, and in which thread it is in.
#   4. background   a tab's session ends and carries on in `tmux -L crosstalk`
#                   as `claude --resume <id>`; popout attaches a new window.
#   5. machines     ana's laptop (A) and desk (B) are each other's own
#                   machines: B lists A's sessions and starts an agent on A,
#                   in A's background, logged in A's digest. Before A counts
#                   B as its own, B's sessions_req is refused.

set -u
export CROSSTALK_NO_GATHER=1 CROSSTALK_NO_REPOTRUST=1 CROSSTALK_NO_WAITER=1 CROSSTALK_NO_OPEN=1 CROSSTALK_TAB_GAP_MS=150
export CROSSTALK_THREAD_SETTLE_MS=300 CROSSTALK_THREAD_SYNC_MS=600000
export GIT_AUTHOR_NAME=t GIT_AUTHOR_EMAIL=t@t GIT_COMMITTER_NAME=t GIT_COMMITTER_EMAIL=t@t
unset TMUX TMUX_PANE TERM_PROGRAM CLAUDE_CODE_MESSAGING_SOCKET CLAUDE_CODE_SESSION_ID CLAUDECODE CODEX_SANDBOX CROSSTALK_AS_AGENT
cd "$(dirname "$0")/.."
ROOT=$(pwd)
PORT=${PORT:-8899}
TMP=$(mktemp -d)
A="$TMP/a"; B="$TMP/b"; R="$TMP/repos"
export TMUX_TMPDIR="$TMP/tmux"
mkdir -p "$A/claude" "$B/claude" "$R" "$TMUX_TMPDIR" "$TMP/bin" "$TMP/relay"
FAILED=0
PASSES=0
pass() { echo "  PASS  $1"; PASSES=$((PASSES+1)); }
fail() { echo "  FAIL  $1"; FAILED=1; }
check() { if [ "$1" = "$2" ]; then pass "$3"; else fail "$3 (wanted '$2', got '$1')"; fi; }
has() { case "$1" in *"$2"*) pass "$3" ;; *) fail "$3"; echo "        got: $1" | head -c 1200; echo ;; esac; }
hasnt() { case "$1" in *"$2"*) fail "$3"; echo "        got: $1" | head -c 1200; echo ;; *) pass "$3" ;; esac; }
stop_daemon() {
  if [ -f "$1/daemon.lock" ]; then
    P=$(cat "$1/daemon.lock")
    kill "$P" 2>/dev/null
    for _ in $(seq 1 30); do kill -0 "$P" 2>/dev/null || break; sleep 0.2; done
    kill -0 "$P" 2>/dev/null && kill -9 "$P" 2>/dev/null
  fi
  rm -f "$1/daemon.sock" "$1/daemon.lock"
}
start_daemon() { CROSSTALK_HOME="$1" CLAUDE_CONFIG_DIR="$1/claude" nohup bun src/daemon.ts >>"$2" 2>&1 & }
rpc() { CROSSTALK_HOME="$1" CLAUDE_CONFIG_DIR="$1/claude" bun -e '
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
# mcp <home> <session> <tool> <json> [cwd]: one tool call, as an agent makes it, from inside the person's tmux.
mcp() { CLAUDE_CONFIG_DIR="$1/claude" TMUX="$USOCK,1,0" TMUX_PANE="$UPANE" bun test/mcp-call.ts "$@" 2>&1; }
ct() { local h=$1; shift; CROSSTALK_HOME="$h" CLAUDE_CONFIG_DIR="$h/claude" bun "$ROOT/src/cli.ts" "$@"; }
RELAY_PID=""
cleanup() {
  stop_daemon "$A"; stop_daemon "$B"
  [ -n "$RELAY_PID" ] && kill "$RELAY_PID" 2>/dev/null
  tmux kill-server 2>/dev/null; tmux -L crosstalk kill-server 2>/dev/null
  for f in "$TMP"/svc.*; do [ -f "$f" ] && kill "$(cat "$f")" 2>/dev/null; done
  rm -rf "$TMP"
}
trap cleanup EXIT

# A stub claude: says how it was called, starts a "dev server" of its own,
# and exits on SIGTERM the way Claude Code does.
cat >"$TMP/bin/claude" <<EOF
#!/bin/bash
printf '%s|%s\n' "\$(pwd)" "\$*" >>"$TMP/calls"
echo \$\$ >"$TMP/pid.\${CT_SID:-none}"
sleep 300 &
echo \$! >"$TMP/svc.\${CT_SID:-none}"
trap 'echo "\${CT_SID:-none} TERM" >>"$TMP/terms"; exit 0' TERM
while :; do sleep 0.2; done
EOF
chmod +x "$TMP/bin/claude"
export PATH="$TMP/bin:$PATH"

# --- repos ---------------------------------------------------------------------------
g() { git -C "$1" "${@:2}"; }
git init -q --bare -b main "$R/remote.git"
git clone -q "$R/remote.git" "$R/seed" 2>/dev/null
mkdir -p "$R/seed/src/auth" "$R/seed/src/billing"
echo a >"$R/seed/src/auth/login.ts"; echo b >"$R/seed/src/billing/tax.ts"
g "$R/seed" add . && g "$R/seed" commit -qm init && g "$R/seed" push -q origin main
clone() { git clone -q "$R/remote.git" "$1" 2>/dev/null; g "$1" checkout -q -b "$2"; }
clone "$R/shop-auth" auth
clone "$R/shop-bill" billing

# --- relay, two identities with a direct channel ---------------------------------------
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
CROSSTALK_HOME="$B" bun src/cli.ts room join $INVITE --label ana-desk --relay "ws://127.0.0.1:$PORT" >"$TMP/pb.log" 2>&1
for _ in $(seq 1 30); do grep -q "Now in a room with" "$TMP/pa.log" && break; sleep 0.5; done
grep -q "in a room with" "$TMP/pb.log" || { echo "joining did not complete"; cat "$TMP/pb.log"; exit 1; }
stop_daemon "$A"; stop_daemon "$B"
start_daemon "$A" "$TMP/da.log"
start_daemon "$B" "$TMP/db.log"
for _ in $(seq 1 40); do [ -S "$A/daemon.sock" ] && [ -S "$B/daemon.sock" ] && break; sleep 0.25; done
sleep 2
echo "state in $TMP"

# --- the person's own tmux, with sessions in it -------------------------------------------
tmux new-session -d -s work -x 200 -y 50 -c "$R/shop-auth"
USOCK=$(tmux display -p '#{socket_path}')
UPANE=$(tmux display -p -t work:0 '#{pane_id}')

# open <home> <sid> <name> <dir> [touched-json]: a stub claude in its own window, its record, and the daemon told.
open_session() {
  local h=$1 sid=$2 name=$3 dir=$4 touched=${5:-[]}
  rm -f "$TMP/pid.$sid"
  tmux new-window -d -t work: -n "$name" -c "$dir" "env CT_SID=$sid claude"
  for _ in $(seq 1 40); do [ -s "$TMP/pid.$sid" ] && break; sleep 0.1; done
  local pid; pid=$(cat "$TMP/pid.$sid")
  local pane; pane=$(tmux display -p -t "work:$name" '#{pane_id}')
  CROSSTALK_HOME="$h" bun -e '
    const R = await import("./src/restore.ts")
    const [sid, name, dir, pid, pane, sock] = process.argv.slice(1)
    const lstart = Bun.spawnSync(["ps", "-o", "lstart=", "-p", pid]).stdout.toString().trim()
    R.writeRec({ sessionId: sid, cwd: dir, client: "claude", name, pid: Number(pid), pidStart: lstart, interactive: true, startedAt: Date.now(), seenAt: Date.now(), terminal: { tmux: { pane, socket: sock, session: "work" } } })
  ' "$sid" "$name" "$dir" "$pid" "$pane" "$USOCK"
  rpc "$h" "{\"op\":\"register\",\"sessionId\":\"$sid\",\"pid\":$pid,\"name\":\"$name\",\"cwd\":\"$dir\",\"socket\":\"\",\"touched\":$touched}" >/dev/null
}
# say <home> <sid> <dir> <text> [role]: a line in that session's Claude Code transcript.
say() {
  CLAUDE_CONFIG_DIR="$1/claude" bun -e '
    const fs = require("fs"), path = require("path")
    const [sid, dir, text, role] = process.argv.slice(1)
    const d = path.join(process.env.CLAUDE_CONFIG_DIR, "projects", dir.replace(/[^A-Za-z0-9]/g, "-"))
    fs.mkdirSync(d, { recursive: true })
    const e = role === "tool"
      ? { type: "assistant", sessionId: sid, cwd: dir, gitBranch: "billing", message: { role: "assistant", content: [{ type: "tool_use", name: "Edit", input: { file_path: path.join(dir, "src/billing/tax.ts") } }] }, timestamp: new Date().toISOString() }
      : { type: role || "user", sessionId: sid, cwd: dir, gitBranch: "billing", message: { role: role || "user", content: role === "assistant" ? [{ type: "text", text }] : text }, timestamp: new Date().toISOString() }
    fs.appendFileSync(path.join(d, sid + ".jsonl"), JSON.stringify(e) + "\n")
  ' "$2" "$3" "$4" "${5:-}"
}
alive() { kill -0 "$1" 2>/dev/null && echo yes || echo no; }

BILL=11111111-aaaa-4bbb-8ccc-000000000001
API=22222222-aaaa-4bbb-8ccc-000000000002
DOCS=33333333-aaaa-4bbb-8ccc-000000000003
ASK=44444444-aaaa-4bbb-8ccc-000000000004
say "$A" "$BILL" "$R/shop-bill" "fix the invoice tax rounding for euro totals"
say "$A" "$BILL" "$R/shop-bill" "" tool
say "$A" "$BILL" "$R/shop-bill" "Rounded tax per line, half-even, and added tests." assistant
open_session "$A" "$BILL" billing "$R/shop-bill" '["src/billing/tax.ts"]'
open_session "$A" "$API" api "$R/shop-auth" '["src/auth/login.ts"]'
open_session "$A" "$DOCS" docs "$R/shop-auth"
rpc "$A" "{\"op\":\"register\",\"sessionId\":\"$ASK\",\"pid\":$$,\"name\":\"main\",\"cwd\":\"$R/shop-auth\",\"socket\":\"\"}" >/dev/null
BILL_SVC=$(cat "$TMP/svc.$BILL")

# --- 1. close ----------------------------------------------------------------------------
echo
echo "close, confirmed on the picker"
CROSSTALK_HOME="$A" bun -e 'const ui = await import("./src/uistate.ts"); ui.markModActive(process.argv[1])' "$ASK"
OUT=$(mcp "$A" "$ASK" crosstalk_close '{"session":"billing"}' "$R/shop-auth")
has "$OUT" "Asked your user to confirm" "\"close billing\" asks the person first"
has "$OUT" 'Close billing?' "with the exact question"
check "$(alive "$(cat "$TMP/pid.$BILL")")" "yes" "nothing ended before the yes"
ITEM=$(CROSSTALK_HOME="$A" bun -e 'const ui = await import("./src/uistate.ts"); console.log(Object.values(ui.snapshot()).find(i => i.kind === "session" && i.sessionId === process.argv[1] && i.state === "pending")?.id ?? "")' "$ASK")
[ -n "$ITEM" ] && pass "a picker waits in the asking session" || fail "a picker waits in the asking session"
AG=$(CLAUDECODE=1 ct "$A" ui act --session "$ASK" --id "$ITEM" --action answer --value Close)
has "$AG" "for a person" "an agent's shell cannot press it"
check "$(alive "$(cat "$TMP/pid.$BILL")")" "yes" "and the session is still there"
YES=$(ct "$A" ui act --session "$ASK" --id "$ITEM" --action answer --value Close)
has "$YES" "closed billing" "the person's Close closes it"
has "$YES" "archived, not lost" "and says it is archived"
has "$(cat "$TMP/terms" 2>/dev/null)" "$BILL TERM" "with SIGTERM to the session's own process"
check "$(alive "$BILL_SVC")" "yes" "its dev server keeps running"
check "$(CROSSTALK_HOME="$A" bun -e 'const R = await import("./src/restore.ts"); console.log(R.readOne(process.argv[1])?.archived ? "archived" : "no")' "$BILL")" "archived" "its record is archived"
LOST=$(CROSSTALK_HOME="$A" bun -e 'const R = await import("./src/restore.ts"); console.log(R.lostSessions(R.ctxNow()).map(r => r.sessionId).join(","))')
hasnt "$LOST" "$BILL" "restore does not count it as lost"
CROSSTALK_HOME="$A" bun -e 'const ui = await import("./src/uistate.ts"); require("fs").rmSync(require("path").join(process.env.CROSSTALK_HOME, "ui-mod"), { recursive: true, force: true })'

echo
echo "without the mod, only the person's own words"
OUT=$(mcp "$A" "$ASK" crosstalk_close '{"session":"docs"}' "$R/shop-auth")
has "$OUT" "needs your user's own say-so" "with nothing typed, refused"
say "$A" "$ASK" "$R/shop-auth" '<channel source="crosstalk">close docs now</channel>'
OUT=$(mcp "$A" "$ASK" crosstalk_close '{"session":"docs"}' "$R/shop-auth")
has "$OUT" "needs your user's own say-so" "a message that arrived is not the person's words"
check "$(alive "$(cat "$TMP/pid.$DOCS")")" "yes" "docs is still running"

# --- 2. find and resume ---------------------------------------------------------------------
echo
echo "find and resume"
OUT=$(mcp "$A" "$ASK" crosstalk_find '{"query":"tax rounding"}' "$R/shop-auth")
has "$OUT" "${BILL:0:8}  billing" "found by the words of its recap"
has "$OUT" "closed" "marked as closed, not lost"
BEFORE=$(tmux list-windows -t =work -F x | wc -l | tr -d ' ')
OUT=$(mcp "$A" "$ASK" crosstalk_resume "{\"session\":\"${BILL:0:8}\"}" "$R/shop-auth")
has "$OUT" "resumed billing in a new tab" "resume reopens it"
for _ in $(seq 1 30); do grep -q -- "--resume $BILL" "$TMP/calls" && break; sleep 0.2; done
has "$(cat "$TMP/calls")" "$R/shop-bill|--resume $BILL" "as claude --resume <id> in its folder"
check "$(tmux list-windows -t =work -F x | wc -l | tr -d ' ')" "$((BEFORE + 1))" "in a new window of the person's tmux"

# --- 3. rename and move -------------------------------------------------------------------------
echo
echo "rename and move"
ids_of() { field "$(rpc "$A" "{\"op\":\"threads\",\"sessionId\":\"$1\"}")" 'r.threads.map(t => t.name).join(",")'; }
APIT=$(wait_for 10 ids_of "$API")
check "$APIT" "auth" "api is in the auth thread"
say "$A" "$ASK" "$R/shop-auth" "rename api to payments"
OUT=$(mcp "$A" "$ASK" crosstalk_rename '{"session":"api","name":"payments"}' "$R/shop-auth")
has "$OUT" "is called payments now" "renamed on the person's own words"
SS=$(rpc "$A" '{"op":"sessions"}')
has "$(field "$SS" 'r.sessions.map(s => s.name).join(",")')" "payments" "the session list says payments"
HOOK=$(printf '{"session_id":"%s","cwd":"%s","hook_event_name":"UserPromptSubmit","prompt":"hello"}' "$API" "$R/shop-auth" | CROSSTALK_HOME="$A" CLAUDE_CONFIG_DIR="$A/claude" CROSSTALK_NO_RESTORE=1 bun src/hook.ts 2>&1)
has "$HOOK" '"sessionTitle":"auth · payments"' "the session's next hook carries the new title"
TH=$(rpc "$A" "{\"op\":\"threads\",\"sessionId\":\"$API\",\"consume\":true}")
check "$(field "$TH" 'r.currentTitle')" "auth · payments" "and the title its next hook shows"
TR=$(rpc "$A" "{\"op\":\"thread_read\",\"sessionId\":\"$API\"}")
has "$(field "$TR" 'JSON.stringify(r.threads[0].sessions)')" "/payments" "the thread's session entry has the new name"
rpc "$A" "{\"op\":\"register\",\"sessionId\":\"$API\",\"pid\":$(cat "$TMP/pid.$API"),\"name\":\"api\",\"cwd\":\"$R/shop-auth\",\"socket\":\"\"}" >/dev/null
check "$(field "$(rpc "$A" '{"op":"sessions"}')" "r.sessions.find(s => s.id === '$API').name")" "payments" "registering again keeps the person's name"
# billing's resumed session has a thread too
rpc "$A" "{\"op\":\"register\",\"sessionId\":\"$BILL\",\"pid\":1,\"name\":\"billing\",\"cwd\":\"$R/shop-bill\",\"socket\":\"\",\"touched\":[\"src/billing/tax.ts\"]}" >/dev/null
check "$(wait_for 10 ids_of "$BILL")" "billing" "billing is in its own thread"
say "$A" "$ASK" "$R/shop-auth" "move payments to billing"
OUT=$(mcp "$A" "$ASK" crosstalk_move '{"session":"payments","thread":"billing"}' "$R/shop-auth")
has "$OUT" "is in billing now" "moved on the person's own words"
check "$(ids_of "$API")" "billing" "it is in billing, and only billing"
check "$(field "$(rpc "$A" "{\"op\":\"threads\",\"sessionId\":\"$API\",\"consume\":true}")" 'r.title')" "billing · payments" "its title follows"

# --- 4. background and popout ---------------------------------------------------------------------
echo
echo "background and pop out"
say "$A" "$ASK" "$R/shop-auth" "send docs to the background"
DOCS_PID=$(cat "$TMP/pid.$DOCS")
OUT=$(mcp "$A" "$ASK" crosstalk_background '{"session":"docs"}' "$R/shop-auth")
has "$OUT" "carries on in the background as docs" "docs goes to the background"
has "$(cat "$TMP/terms")" "$DOCS TERM" "its tab's process ended with SIGTERM"
if tmux -L crosstalk has-session -t =docs 2>/dev/null; then pass "it is a session in tmux -L crosstalk"; else fail "it is a session in tmux -L crosstalk"; fi
for _ in $(seq 1 30); do grep -q -- "--resume $DOCS" "$TMP/calls" && break; sleep 0.2; done
has "$(cat "$TMP/calls")" "$R/shop-auth|--resume $DOCS" "running claude --resume <id>"
check "$(alive "$(cat "$TMP/svc.$DOCS" 2>/dev/null)")" "yes" "its services untouched"
BEFORE=$(tmux list-windows -t =work -F x | wc -l | tr -d ' ')
OUT=$(mcp "$A" "$ASK" crosstalk_popout '{"name":"docs"}' "$R/shop-auth")
has "$OUT" "opened docs in a new tab" "pop it out"
has "$(tmux list-windows -t =work -F '#{pane_start_command}')" "tmux -L crosstalk attach-session -t =docs" "a new window attached to it"

# --- 5. across your own machines -----------------------------------------------------------------
echo
echo "across your own machines"
own() { CROSSTALK_HOME="$1" bun -e 'const c = await import("./src/config.ts"); const p = c.loadPeers(); p[process.argv[1]].own = true; c.savePeers(p)' "$2"; }
NOTOWN=$(rpc "$B" '{"op":"sessions_remote","machine":"ana","req":{"op":"list"}}')
has "$NOTOWN" "not one of your own machines" "a peer that is not your own machine: refused before asking"
own "$B" ana
REFUSED=$(rpc "$B" '{"op":"sessions_remote","machine":"ana","req":{"op":"list"}}')
has "$REFUSED" "only answers your own machines" "and the other side refuses one it does not count as its own"
hasnt "$REFUSED" "payments" "with none of its sessions"
grep -q "refused a sessions request from ana-desk" "$TMP/da.log" && pass "the refusal is logged there" || fail "the refusal is logged there"
own "$A" ana-desk
LIST=$(rpc "$B" '{"op":"sessions_remote","machine":"ana","req":{"op":"list"}}')
has "$LIST" '"name":"payments"' "the desk lists the laptop's sessions"
ASKB=55555555-aaaa-4bbb-8ccc-000000000005
rpc "$B" "{\"op\":\"register\",\"sessionId\":\"$ASKB\",\"pid\":$$,\"name\":\"desk-main\",\"cwd\":\"$TMP\",\"socket\":\"\"}" >/dev/null
SESS=$(CROSSTALK_HOME="$B" mcp "$B" "$ASKB" crosstalk_sessions '{}' "$TMP")
has "$SESS" '"otherMachines"' "crosstalk_sessions includes the other machine"
has "$SESS" 'payments' "with its sessions"
say "$B" "$ASKB" "$TMP" "start an agent on ana to write the changelog"
OUT=$(CROSSTALK_HOME="$B" mcp "$B" "$ASKB" crosstalk_spawn '{"machine":"ana","repo":"shop-auth","task":"write the changelog for 0.2","name":"changelog"}' "$TMP")
has "$OUT" "crosstalk on " "the desk starts an agent on the laptop"
has "$OUT" "in the background" "in the laptop's background, since nobody is at it"
if tmux -L crosstalk has-session -t =changelog 2>/dev/null; then pass "running in tmux -L crosstalk there"; else fail "running in tmux -L crosstalk there"; fi
for _ in $(seq 1 30); do grep -q "write the changelog" "$TMP/calls" && break; sleep 0.2; done
has "$(cat "$TMP/calls")" "changelog|write the changelog for 0.2" "claude started with the task in its own worktree"
DIG=$(rpc "$A" "{\"op\":\"ui\",\"sessionId\":\"$ASK\",\"mod\":true}")
has "$DIG" "ana-desk, your machine, asked to start an agent" "and it is in the laptop's digest"
say "$B" "$ASKB" "$TMP" "close payments on ana"
OUT=$(CROSSTALK_HOME="$B" mcp "$B" "$ASKB" crosstalk_close '{"machine":"ana","session":"payments"}' "$TMP")
has "$OUT" "never ended from afar" "closing with nobody at the laptop is refused"
check "$(alive "$(cat "$TMP/pid.$API")")" "yes" "and payments keeps running"

echo
if [ "$FAILED" = 0 ]; then echo "sessions: all $PASSES passed"; else echo "sessions: FAILED"; exit 1; fi
