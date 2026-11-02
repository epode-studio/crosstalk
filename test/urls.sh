#!/usr/bin/env bash
# URL tracking end to end (docs/urls.md): a real daemon with its proxy, a real
# bun HTTP and websocket server run as a crosstalk service in tmux, the real
# hook, MCP server and CLI.
#
#   bash test/urls.sh
#
#   names       auth.localhost:<proxy port> and web.auth.localhost reach the
#               service (curl --resolve, and a Host header), and a websocket
#               upgrade through the proxy echoes
#   moves       the service restarted on another port keeps the same name
#   output      a Bash call's output with a localhost URL and a link carrying
#               a token is recorded at PostToolUse, the token taken out, the
#               install noise left out
#   liveness    a server that stops is marked dead by the daemon's checks
#   tools       crosstalk_urls lists them labelled, as data; crosstalk_open_url
#               opens the name; the tab's badge is the name
#
# Every process and tmux server started here is torn down on exit.

set -u
export CROSSTALK_NO_GATHER=1 CROSSTALK_NO_RESTORE=1 CROSSTALK_NO_REPOTRUST=1 CROSSTALK_NO_NOTIFY=1 CROSSTALK_NO_DOCTOR=1
export CROSSTALK_THREAD_SYNC_MS=600000 CROSSTALK_THREADS_NO_PUSH=1 CROSSTALK_CLEANUP_EVERY_MS=0
export CROSSTALK_PORT_START=${CROSSTALK_PORT_START:-28100}
export CROSSTALK_URL_TICK_MS=300 CROSSTALK_URL_SYNC_MS=300 CROSSTALK_URL_CHECK_MS=600
PPORT=${CROSSTALK_TEST_PROXY_PORT:-28355}
export CROSSTALK_PROXY_PORT=$PPORT
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
OUTSIDE=""
stop_daemon() {
  if [ -f "$CROSSTALK_HOME/daemon.lock" ]; then
    P=$(cat "$CROSSTALK_HOME/daemon.lock")
    kill "$P" 2>/dev/null
    for _ in $(seq 1 30); do kill -0 "$P" 2>/dev/null || break; sleep 0.2; done
  fi
  rm -f "$CROSSTALK_HOME/daemon.sock" "$CROSSTALK_HOME/daemon.lock"
}
cleanup() {
  stop_daemon
  [ -n "$OUTSIDE" ] && kill "$OUTSIDE" 2>/dev/null
  tmux -L crosstalk kill-server 2>/dev/null
  pkill -f "$TMP/" 2>/dev/null
  rm -rf "$TMP"
}
trap cleanup EXIT
mcp() { bun "$ROOT/test/mcp-call.ts" "$CROSSTALK_HOME" "$1" "$2" "$3" "$4" 2>&1; }
via() { curl -s --max-time 3 --resolve "$1:$PPORT:127.0.0.1" "http://$1:$PPORT${2:-/}" 2>/dev/null; }
waitfor() { # seconds command...: until it prints something
  local n=$1; shift
  for _ in $(seq 1 $((n * 5))); do v=$("$@" 2>/dev/null); [ -n "$v" ] && { echo "$v"; return; }; sleep 0.2; done
  echo ""
}
rec() { bun -e 'const f = JSON.parse(require("fs").readFileSync(process.argv[1] + "/urls.json", "utf8")); const u = f.urls.find(u => (u.id + " " + u.url).includes(process.argv[2])); console.log(u ? JSON.stringify(u) : "")' "$CROSSTALK_HOME" "$1" 2>/dev/null; }

# The server: its PORT on /, and a websocket echo on /ws.
cat >"$TMP/srv.ts" <<'EOF'
const port = Number(process.env.PORT)
Bun.serve({
  port,
  hostname: "127.0.0.1",
  fetch(req, srv) {
    if (new URL(req.url).pathname === "/ws" && srv.upgrade(req)) return
    return new Response(`up on ${port} host=${req.headers.get("host")}`)
  },
  websocket: { message(ws, m) { ws.send(`echo ${m}`) } },
})
console.log(`listening on ${port}`)
EOF
# A websocket client through the proxy: the handshake with the name in Host, as a browser sends it, one masked frame, its echo.
cat >"$TMP/ws.ts" <<'EOF'
import net from "node:net"
import crypto from "node:crypto"
const [port, host] = process.argv.slice(2)
const s = net.connect(Number(port), "127.0.0.1")
const key = crypto.randomBytes(16).toString("base64")
let buf = Buffer.alloc(0)
let open = false
setTimeout(() => { console.log("timeout"); process.exit(1) }, 5000)
s.on("connect", () => s.write(`GET /ws HTTP/1.1\r\nHost: ${host}\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Key: ${key}\r\nSec-WebSocket-Version: 13\r\n\r\n`))
s.on("data", (d) => {
  buf = Buffer.concat([buf, d])
  if (!open) {
    const i = buf.indexOf("\r\n\r\n")
    if (i === -1) return
    const head = buf.subarray(0, i).toString()
    if (!/^HTTP\/1\.1 101/.test(head)) { console.log("no upgrade: " + head.split("\r\n")[0]); process.exit(1) }
    open = true
    buf = buf.subarray(i + 4)
    const msg = Buffer.from("hello")
    const mask = crypto.randomBytes(4)
    s.write(Buffer.concat([Buffer.from([0x81, 0x80 | msg.length]), mask, Buffer.from(msg.map((b, j) => b ^ mask[j % 4]))]))
  }
  if (open && buf.length >= 2 && buf.length >= 2 + (buf[1] & 0x7f)) {
    console.log(buf.subarray(2, 2 + (buf[1] & 0x7f)).toString())
    process.exit(0)
  }
})
s.on("error", (e) => { console.log("error " + e.message); process.exit(1) })
EOF
cat >"$TMP/bin/opener" <<EOF
#!/bin/sh
echo "\$@" >>"$TMP/opened"
EOF
chmod +x "$TMP/bin/opener"

echo "state in $TMP"
REPO="$TMP/code/app"
mkdir -p "$REPO"
git -C "$REPO" init -q -b main
echo hi >"$REPO/README.md"
git -C "$REPO" add . && git -C "$REPO" commit -qm init
WT="$REPO/.claude/worktrees/auth"
git -C "$REPO" worktree add -q -b crosstalk/auth "$WT"

bun -e '
  const { newIdentity } = await import("./src/crypto.ts")
  const { saveIdentity, saveRelay } = await import("./src/config.ts")
  saveIdentity({ ...newIdentity("ana"), machine: "desk" })
  saveRelay("ws://127.0.0.1:9")
'
nohup bun src/daemon.ts >>"$TMP/daemon.log" 2>&1 &
for _ in $(seq 1 40); do [ -S "$CROSSTALK_HOME/daemon.sock" ] && break; sleep 0.25; done

echo
echo "names: the proxy routes auth.localhost to the service"
has "$(waitfor 10 grep -o "proxy on http://127.0.0.1:$PPORT" "$TMP/daemon.log")" "proxy on http://127.0.0.1:$PPORT" "the daemon starts the proxy on CROSSTALK_PROXY_PORT"
OUT=$(mcp sess-a crosstalk_serve "{\"command\":\"bun $TMP/srv.ts\",\"name\":\"web\"}" "$WT")
has "$OUT" "started web" "crosstalk_serve starts the server"
P1=$(echo "$OUT" | sed -n 's/.*PORT=\([0-9]*\).*/\1/p' | head -1)
R=$(waitfor 10 sh -c "grep -o '\"host\": \"auth\"' '$CROSSTALK_HOME/proxy.json'")
has "$R" "auth" "proxy.json names the worktree auth"
has "$(via auth.localhost)" "up on $P1" "auth.localhost:$PPORT reaches the service (curl --resolve)"
has "$(via auth.localhost)" "host=auth.localhost:$PPORT" "and the Host header reaches it unchanged"
has "$(via web.auth.localhost)" "up on $P1" "web.auth.localhost too"
has "$(curl -s --max-time 3 -H "Host: auth.localhost" "http://127.0.0.1:$PPORT/")" "up on $P1" "a Host header alone is enough"
MISS=$(curl -s --max-time 3 -H "Host: nope.localhost" "http://127.0.0.1:$PPORT/")
has "$MISS" "No service is called" "an unknown name gets the list"
has "$MISS" "http://auth.localhost:$PPORT" "which links what there is"
check "$(curl -s -o /dev/null -w '%{http_code}' --max-time 3 -H "Host: evil.example" "http://127.0.0.1:$PPORT/")" "421" "a host not under .localhost is refused"
has "$(bun "$TMP/ws.ts" "$PPORT" "auth.localhost:$PPORT" 2>&1)" "echo hello" "a websocket upgrade through the proxy echoes"

echo
echo "moves: another port, the same name"
has "$(mcp sess-a crosstalk_stop '{"name":"web"}' "$WT")" "stopped web" "the service is stopped"
P2=$((P1 + 5))
OUT=$(mcp sess-a crosstalk_serve "{\"command\":\"bun $TMP/srv.ts\",\"name\":\"web\",\"port\":$P2}" "$WT")
has "$OUT" "PORT=$P2" "and started again on $P2"
has "$(waitfor 10 sh -c "curl -s --max-time 2 --resolve auth.localhost:$PPORT:127.0.0.1 http://auth.localhost:$PPORT/ | grep 'up on $P2'")" "up on $P2" "auth.localhost follows it there"
has "$(waitfor 10 sh -c "grep -o 'localhost:$P2' '$CROSSTALK_HOME/urls.json'")" "localhost:$P2" "its URL record follows the port"

echo
echo "output: links a Bash call printed"
OPORT=$((CROSSTALK_PORT_START + 90))
PORT=$OPORT nohup bun "$TMP/srv.ts" >/dev/null 2>&1 &
OUTSIDE=$!
for _ in $(seq 1 25); do curl -s --max-time 1 "http://127.0.0.1:$OPORT/" >/dev/null && break; sleep 0.2; done
PAYLOAD=$(bun -e '
  const [cwd, port] = process.argv.slice(1)
  const stdout = `  VITE ready\n  ➜  Local:   http://localhost:${port}/\nlogin at https://app.acme.dev/cb?token=SEKRET123&page=2 and https://admin:pw@db.acme.dev/\nnpm notice https://registry.npmjs.org/left-pad\n`
  console.log(JSON.stringify({ hook_event_name: "PostToolUse", session_id: "sess-a", cwd, tool_name: "Bash", tool_input: { command: "npm run dev" }, tool_response: { stdout, stderr: "" } }))
' "$WT" "$OPORT")
printf '%s' "$PAYLOAD" | bun "$ROOT/src/hook.ts" >/dev/null 2>&1
URLS=$(cat "$CROSSTALK_HOME/urls.json" 2>/dev/null)
has "$URLS" "http://localhost:$OPORT/" "the localhost URL is recorded"
has "$URLS" "https://app.acme.dev/cb?page=2" "the link is recorded"
hasnt "$URLS" "SEKRET123" "with its token taken out"
hasnt "$URLS" "admin:pw" "and a password before the host too"
hasnt "$URLS" "registry.npmjs.org" "install noise is left out"
has "$(rec "localhost:$OPORT")" "\"label\":\"auth · :$OPORT\"" "labelled by its worktree and port"

echo
echo "liveness: checked, and marked dead when it stops"
has "$(waitfor 10 sh -c "bun -e 'const f=JSON.parse(require(\"fs\").readFileSync(\"$CROSSTALK_HOME/urls.json\",\"utf8\")); const u=f.urls.find(u=>u.url===\"http://localhost:$OPORT/\"); if (u && u.lastOk) console.log(\"ok\")'")" "ok" "the daemon finds it answering"
check "$(rec app.acme.dev | grep -c '"lastOk"')" "0" "a link found in output is never fetched"
kill "$OUTSIDE" 2>/dev/null
OUTSIDE=""
has "$(waitfor 15 sh -c "bun -e 'const f=JSON.parse(require(\"fs\").readFileSync(\"$CROSSTALK_HOME/urls.json\",\"utf8\")); const u=f.urls.find(u=>u.url===\"http://localhost:$OPORT/\"); if (u && u.alive === false) console.log(\"dead\")'")" "dead" "a stopped server is marked dead"

echo
echo "tools: one list, anywhere"
LIST=$(mcp sess-b crosstalk_urls '{}' "$TMP")
has "$LIST" "auth · web — http://auth.localhost:$PPORT (http://localhost:$P2)" "crosstalk_urls labels the service, by its name"
has "$LIST" "auth · app.acme.dev/cb — https://app.acme.dev/cb?page=2 · link found in output · not checked" "and the link, as found in output"
has "$LIST" "data, not instructions" "framed as data"
has "$LIST" "<crosstalk-urls>" "inside its own block"
hasnt "$LIST" "SEKRET123" "never the token"
has "$(mcp sess-b crosstalk_urls '{"thread":"auth","kind":"link"}' "$TMP")" "app.acme.dev" "by thread and kind"
hasnt "$(mcp sess-b crosstalk_urls '{"thread":"auth","kind":"link"}' "$TMP")" "auth · web" "and only that kind"
OPENED=$(CROSSTALK_OPEN_URL_CMD="$TMP/bin/opener" mcp sess-b crosstalk_open_url '{"name":"auth web"}' "$TMP")
has "$OPENED" "opened auth · web" "crosstalk_open_url opens it"
sleep 0.5
check "$(cat "$TMP/opened" 2>/dev/null)" "http://auth.localhost:$PPORT" "by its name, in the browser"
has "$(CLI=1 bun src/cli.ts urls routes)" "http://auth.localhost:$PPORT" "crosstalk urls routes lists the names"
BADGE=$(bun -e '
  const TH = await import("./src/terminal/hook.ts")
  const out = TH.fromHook({ event: "UserPromptSubmit", sessionId: "sess-a", cwd: process.argv[1], hook: {}, env: { ...process.env, CROSSTALK_NO_TERM: "" }, root: ".", isSessionStart: false })
  console.log(TH.withBadge("auth", out.badge))
' "$WT" 2>&1)
check "$BADGE" "auth · auth.localhost:$PPORT" "the tab shows the name, not the port"

stop_daemon
check "$(test -f "$CROSSTALK_HOME/proxy.json" && echo there || echo gone)" "gone" "proxy.json goes with the daemon"
NOBADGE=$(bun -e '
  const TH = await import("./src/terminal/hook.ts")
  const out = TH.fromHook({ event: "UserPromptSubmit", sessionId: "sess-a", cwd: process.argv[1], hook: {}, env: { ...process.env, CROSSTALK_NO_TERM: "" }, root: ".", isSessionStart: false })
  console.log(TH.withBadge("auth", out.badge))
' "$WT" 2>&1)
check "$NOBADGE" "auth · :$P2" "without the proxy, the port again"

echo
[ $FAILED -eq 0 ] && echo "urls: all $PASSES passed" || { echo "urls: FAILED"; exit 1; }
