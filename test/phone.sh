#!/usr/bin/env bash
# Phone, history and env end to end (docs/urls.md): a real daemon, real git
# worktrees, a real service in crosstalk's tmux, the real hook, MCP server and
# CLI, and a stub claude.
#
#   bash test/phone.sh
#
#   env        a worktree spawned in a repo with a gitignored .env (0600) and
#              a tracked .env.example asks once; after yes only .env is copied,
#              with its mode, into it and every later one, and a Claude Code
#              worktree's first session gets it too; nothing of its contents
#              reaches a tool result, the daemon's log or the thread
#   history    a service URL, a preview and a link printed by another session
#              of the thread land in its links section, and crosstalk_history
#              finds them after urls.json has forgotten them and the daemon
#              restarted; a screenshot noted is listed with its machine
#   phone      crosstalk_qr for the public preview puts a QR in the pane (the
#              result says it is on screen, not what it encodes); a localhost
#              URL is refused, saying the phone needs a share link
#
# Every process and tmux server started here is torn down on exit.

set -u
export CROSSTALK_NO_GATHER=1 CROSSTALK_NO_RESTORE=1 CROSSTALK_NO_REPOTRUST=1 CROSSTALK_NO_NOTIFY=1 CROSSTALK_NO_DOCTOR=1 CROSSTALK_NO_WAITER=1 CROSSTALK_NO_OPEN=1
export CROSSTALK_THREAD_SETTLE_MS=300 CROSSTALK_THREAD_SYNC_MS=600000 CROSSTALK_THREADS_NO_PUSH=1 CROSSTALK_CLEANUP_EVERY_MS=0 CROSSTALK_NO_RECAP=1
export CROSSTALK_PORT_START=${CROSSTALK_PORT_START:-28600}
export CROSSTALK_URL_TICK_MS=300 CROSSTALK_URL_SYNC_MS=300 CROSSTALK_HISTORY_MS=400
export CROSSTALK_PROXY_PORT=${CROSSTALK_TEST_PROXY_PORT:-28655}
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
  nohup bun src/daemon.ts >>"$TMP/daemon.log" 2>&1 &
  for _ in $(seq 1 40); do [ -S "$CROSSTALK_HOME/daemon.sock" ] && break; sleep 0.25; done
}
cleanup() {
  stop_daemon
  tmux -L crosstalk kill-server 2>/dev/null
  pkill -f "$TMP/" 2>/dev/null
  rm -rf "$TMP"
}
trap cleanup EXIT
mcp() { bun "$ROOT/test/mcp-call.ts" "$CROSSTALK_HOME" "$1" "$2" "$3" "$4" 2>&1; }
hook() { printf '%s' "$1" | bun "$ROOT/src/hook.ts" 2>&1; }
rpc() { bun -e '
  const { request } = await import("./src/client.ts")
  console.log(JSON.stringify(await request(JSON.parse(process.argv[1]), 60000)))
' "$1" 2>&1; }
waitfor() { # seconds command...: until it prints something
  local n=$1; shift
  for _ in $(seq 1 $((n * 5))); do v=$("$@" 2>/dev/null); [ -n "$v" ] && { echo "$v"; return; }; sleep 0.2; done
  echo ""
}
mode() { stat -c %a "$1" 2>/dev/null || stat -f %Lp "$1"; }
links() { bun -e '
  const f = JSON.parse(require("fs").readFileSync(process.argv[1] + "/threads.json", "utf8"))
  const t = Object.values(f.threads).find((t) => t.meta.value.name === "auth")
  const l = Object.values(t?.links ?? {}).filter((x) => !x.gone)
  console.log(l.map((x) => `${x.kind} ${x.url}`).sort().join("\n"))
' "$CROSSTALK_HOME" 2>/dev/null; }

cat >"$TMP/bin/claude" <<EOF
#!/bin/sh
exec sleep 600
EOF
chmod +x "$TMP/bin/claude"
export PATH="$TMP/bin:$PATH"
cat >"$TMP/srv.ts" <<'EOF'
Bun.serve({ port: Number(process.env.PORT), hostname: "127.0.0.1", fetch: () => new Response("login page") })
EOF

echo "state in $TMP"
REPO="$TMP/code/api"
mkdir -p "$REPO/src/auth"
git -C "$REPO" init -q -b main
git -C "$REPO" remote add origin git@github.com:acme/api.git
printf '.env\n.env.*\n!.env.example\n' >"$REPO/.gitignore"
echo "API_KEY=" >"$REPO/.env.example"
for f in a b c; do echo "export const v = 1" >"$REPO/src/auth/$f.ts"; done
git -C "$REPO" add . && git -C "$REPO" commit -qm init
echo "API_KEY=sk-live-HUNTER2" >"$REPO/.env"
chmod 600 "$REPO/.env"

bun -e '
  const { newIdentity } = await import("./src/crypto.ts")
  const { saveIdentity, saveRelay } = await import("./src/config.ts")
  saveIdentity({ ...newIdentity("ana"), machine: "desk" })
  saveRelay("ws://127.0.0.1:9")
'
start_daemon

# Two sessions in the thread auth: what they edit puts them there.
for s in asker other; do
  hook "{\"hook_event_name\":\"SessionStart\",\"session_id\":\"$s\",\"cwd\":\"$REPO\",\"source\":\"startup\"}" >/dev/null
  for f in a b c; do hook "{\"hook_event_name\":\"PostToolUse\",\"session_id\":\"$s\",\"cwd\":\"$REPO\",\"tool_name\":\"Edit\",\"tool_input\":{\"file_path\":\"$REPO/src/auth/$f.ts\"}}" >/dev/null; done
done
has "$(rpc '{"op":"threads","sessionId":"asker"}')" '"name":"auth"' "the sessions are in the thread auth"

echo
echo "env: a new worktree asks once, and after yes gets only the gitignored .env"
OUT=$(cd "$REPO" && CLAUDE_CODE_SESSION_ID=asker bun "$ROOT/src/cli.ts" spawn --background --name envy "start the dev server" 2>&1)
has "$OUT" "started 1 agent (envy)" "an agent is spawned in its own worktree"
has "$OUT" "Copy .env into new worktrees of api?" "it asks, once, naming the file"
hasnt "$OUT" "sk-live-HUNTER2" "and never says what is in it"
WT=$(bun -e 'const S = await import("./src/spawn.ts"); console.log(S.readSpawned().find((r) => r.name === "envy")?.worktree ?? "")')
check "$(test -e "$WT/.env" && echo there || echo absent)" "absent" "nothing is copied before the answer"
OUT=$(cd "$REPO" && CLAUDE_CODE_SESSION_ID=asker bun "$ROOT/src/cli.ts" spawn --background --name envy2 "run the tests" 2>&1)
hasnt "$OUT" "Copy .env" "the second worktree does not ask again"
WT2=$(bun -e 'const S = await import("./src/spawn.ts"); console.log(S.readSpawned().find((r) => r.name === "envy2")?.worktree ?? "")')
ANS=$(mcp asker crosstalk_env '{"confirm":true}' "$REPO")
has "$ANS" "new worktrees of api get its local files (.env)" "crosstalk_env confirm: yes, naming only .env"
has "$ANS" "Copied into envy (.env), envy2 (.env)" "and copies into the worktrees made so far"
hasnt "$ANS" "sk-live-HUNTER2" "the result has names, not contents"
hasnt "$ANS" ".env.example" "the tracked example is not one of them"
check "$(cat "$WT/.env" 2>/dev/null)" "API_KEY=sk-live-HUNTER2" ".env is in the worktree"
check "$(mode "$WT/.env")" "600" "with its mode"
check "$(test -L "$WT/.env" && echo link || echo file)" "file" "a copy, not a link"
check "$(git -C "$WT" status --porcelain)" "" "and git in the worktree does not see it"
check "$(git -C "$WT" ls-files .env.example)" ".env.example" ".env.example is the tracked one, from the checkout"
check "$(ls -A "$WT" | grep -c '^\.env')" "2" "and nothing else env-like is there"
OUT=$(cd "$REPO" && CLAUDE_CODE_SESSION_ID=asker bun "$ROOT/src/cli.ts" spawn --background --name envy3 "fix the login" 2>&1)
has "$OUT" ".env was copied in from the main checkout" "a worktree made after the yes gets it at once"
CC="$REPO/.claude/worktrees/cc"
git -C "$REPO" worktree add -q -b cc "$CC"
SM=$(hook "{\"hook_event_name\":\"SessionStart\",\"session_id\":\"cc-sess\",\"cwd\":\"$CC\",\"source\":\"startup\"}")
has "$SM" "copied .env into this worktree" "a Claude Code worktree's first session gets it too"
check "$(mode "$CC/.env")" "600" "with its mode"
SM=$(hook "{\"hook_event_name\":\"SessionStart\",\"session_id\":\"cc-sess2\",\"cwd\":\"$CC\",\"source\":\"startup\"}")
hasnt "$SM" "copied .env" "and only what is missing: nothing the second time"
NO=$(mcp asker crosstalk_env '{"confirm":false}' "$REPO")
has "$NO" "not copying local files into new worktrees of api" "a no is kept"
OUT=$(cd "$REPO" && CLAUDE_CODE_SESSION_ID=asker bun "$ROOT/src/cli.ts" spawn --background --name envy4 "docs" 2>&1)
WT4=$(bun -e 'const S = await import("./src/spawn.ts"); console.log(S.readSpawned().find((r) => r.name === "envy4")?.worktree ?? "")')
check "$(test -e "$WT4/.env" && echo there || echo absent)" "absent" "after the no, nothing is copied"
hasnt "$OUT" "Copy .env" "and nothing is asked"

echo
echo "history: what the thread had, kept in it"
OUT=$(mcp asker crosstalk_serve "{\"command\":\"bun $TMP/srv.ts\",\"name\":\"web\"}" "$REPO")
has "$OUT" "started web" "a service runs for the thread"
bun -e '
  const U = await import("./src/urls/index.ts")
  U.recordPreview({ thread: "auth", feature: "login", url: "https://auth-login.preview.acme.dev/" })
'
PAYLOAD=$(bun -e '
  const stdout = "deployed docs to https://docs.acme.dev/auth/login?token=SEKRET9 \n"
  console.log(JSON.stringify({ hook_event_name: "PostToolUse", session_id: "other", cwd: process.argv[1], tool_name: "Bash", tool_input: { command: "deploy" }, tool_response: { stdout, stderr: "" } }))
' "$REPO")
hook "$PAYLOAD" >/dev/null
bun -e '
  const H = await import("./src/urls/history/sync.ts")
  H.noteShot({ urlId: "preview:auth:login", path: "/tmp/shots/login-before.png", note: "before the redesign" })
'
L=$(waitfor 15 sh -c "bun -e '
  const f = JSON.parse(require(\"fs\").readFileSync(\"$CROSSTALK_HOME/threads.json\", \"utf8\"))
  const t = Object.values(f.threads).find((t) => t.meta.value.name === \"auth\")
  const l = Object.values(t?.links ?? {}).filter((x) => !x.gone)
  if (l.length >= 3 && l.some((x) => x.shots?.length)) console.log(\"ok\")
'")
check "$L" "ok" "the daemon records them in the thread"
LINKS=$(links)
has "$LINKS" "local http://" "the service, as a local server"
has "$LINKS" "preview https://auth-login.preview.acme.dev/" "the preview"
has "$LINKS" "link https://docs.acme.dev/auth/login" "the link the other session printed"
hasnt "$LINKS" "SEKRET9" "with its token taken out"
hasnt "$(cat "$CROSSTALK_HOME/threads.json")" "sk-live-HUNTER2" "and no .env contents anywhere in the thread"
hasnt "$(cat "$TMP/daemon.log")" "sk-live-HUNTER2" "or the daemon's log"
# urls.json forgets; the thread keeps, across a restart.
mcp asker crosstalk_stop '{"name":"web"}' "$REPO" >/dev/null
stop_daemon
rm -f "$CROSSTALK_HOME/urls.json"
start_daemon
HIST=$(mcp other crosstalk_history '{"thread":"auth","query":"login"}' "$REPO")
has "$HIST" "in auth's history matching \"login\"" "crosstalk_history finds them by a word"
has "$HIST" "auth · preview (login) — https://auth-login.preview.acme.dev/ · preview · seen 20" "the preview, with when it was seen"
has "$HIST" "screenshot 20" "its screenshot"
has "$HIST" "/tmp/shots/login-before.png · before the redesign" "with its path and note"
has "$HIST" "(this machine)" "and the machine it is on"
has "$HIST" "exist only there" "saying a path is only on that machine"
has "$HIST" "<crosstalk-history>" "framed as data"
has "$(mcp other crosstalk_history '{"thread":"auth","query":"local server"}' "$REPO")" "auth · web" "the service too, after urls.json forgot it"

echo
echo "phone: a QR in the pane"
bun -e 'const ui = await import("./src/uistate.ts"); ui.markModActive("asker")'
bun -e '
  const U = await import("./src/urls/index.ts")
  U.recordPreview({ thread: "auth", feature: "login", url: "https://auth-login.preview.acme.dev/" })
'
QR=$(mcp asker crosstalk_qr '{"name":"auth preview"}' "$REPO")
has "$QR" "the QR code for auth · preview (login) is on screen" "crosstalk_qr says it is on screen"
hasnt "$QR" "auth-login.preview.acme.dev" "and not what it encodes"
hasnt "$QR" "█" "nor the code itself"
PANE=$(bun src/cli.ts ui pane --session asker)
has "$PANE" '"qr":{"label":"auth · preview (login)"' "the pane has it"
has "$PANE" '█' "drawn in half blocks"
DECODED=$(bun -e '
  const p = JSON.parse(process.argv[1]).pane.qr
  const Q = await import("./src/urls/history/qr.ts")
  const q = Q.encode("https://auth-login.preview.acme.dev/")
  console.log(JSON.stringify(Q.halfBlocks(q.modules)) === JSON.stringify(p.rows) ? "same" : "differs")
' "$PANE")
check "$DECODED" "same" "the pane's code is the preview's URL"
LOCAL=$(mcp asker crosstalk_qr '{"url":"http://localhost:3000/login"}' "$REPO")
has "$LOCAL" "needs a share link" "a localhost URL: the phone needs a share link"
CLI=$(bun src/cli.ts urls qr "auth preview")
has "$CLI" "▀" "crosstalk urls qr prints it for a terminal"
hasnt "$(CLAUDECODE=1 bun src/cli.ts urls qr "auth preview")" "▀" "but not inside an agent"

echo
[ $FAILED -eq 0 ] && echo "phone: all $PASSES passed" || { echo "phone: FAILED"; tail -30 "$TMP/daemon.log"; exit 1; }
