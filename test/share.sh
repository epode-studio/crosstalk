#!/usr/bin/env bash
# Sharing a running server with a teammate, end to end (docs/urls.md, "Sharing").
#
#   bash test/share.sh
#
# Three identities on one local relay: ana (the owner) has a direct channel
# with ben and with cat. ana runs a bun HTTP and websocket server with
# crosstalk_serve and shares it with ben alone:
#
#   share       ben's curl through his own proxy name, auth.ana.localhost,
#               gets ana's page; a 2 MB response arrives whole; a websocket
#               echoes; it is in ben's crosstalk_urls as shared, as data, and
#               in ana's as shared with ben
#   not named   cat has no such name, and a request she makes on the share's id
#               by hand is refused by ana's daemon
#   no SSRF     an absolute-form request for another port on ana's machine
#               reaches only the shared server; one as a frame path is refused
#   unshare     cuts ben off; sharing it again reaches him at once (his proxy
#               routes it as the offer is taken); a short share expires by itself
#
# Every process, tmux server and file started here is torn down on exit.

set -u
export CROSSTALK_NO_GATHER=1 CROSSTALK_NO_RESTORE=1 CROSSTALK_NO_REPOTRUST=1 CROSSTALK_NO_NOTIFY=1 CROSSTALK_NO_DOCTOR=1 CROSSTALK_NO_OPEN=1
export CROSSTALK_THREAD_SYNC_MS=600000 CROSSTALK_THREADS_NO_PUSH=1 CROSSTALK_CLEANUP_EVERY_MS=0 CROSSTALK_NO_EXTRAS_TICK=1
export CROSSTALK_PORT_START=${CROSSTALK_PORT_START:-48600}
export CROSSTALK_URL_TICK_MS=300 CROSSTALK_URL_SYNC_MS=300 CROSSTALK_SHARE_TICK_MS=300
export CROSSTALK_SHARE_TEST=1
cd "$(dirname "$0")/.."
ROOT=$(pwd)
PORT=${SHARE_RELAY_PORT:-8893}
# Below Linux's ephemeral range (32768-60999): an outgoing socket that happened to get a fixed port
# there would leave a daemon with no proxy at all.
PA=${SHARE_PROXY_A:-28651}
PB=${SHARE_PROXY_B:-28652}
PC=${SHARE_PROXY_C:-28653}
TMP=$(mktemp -d)
A="$TMP/a"; B="$TMP/b"; C="$TMP/c"
export HOME="$TMP/user"
export TMUX_TMPDIR="$TMP/tmux"
export GIT_AUTHOR_NAME=t GIT_AUTHOR_EMAIL=t@t GIT_COMMITTER_NAME=t GIT_COMMITTER_EMAIL=t@t
unset TMUX TMUX_PANE TERM_PROGRAM CLAUDE_CODE_MESSAGING_SOCKET CLAUDE_CODE_SESSION_ID CROSSTALK_BG_AGENT CLAUDECODE
mkdir -p "$HOME/.claude/sessions" "$A" "$B" "$C" "$TMUX_TMPDIR" "$TMP/relay"
FAILED=0
PASSES=0
pass() { echo "  PASS  $1"; PASSES=$((PASSES+1)); }
fail() { echo "  FAIL  $1"; FAILED=1; }
check() { if [ "$1" = "$2" ]; then pass "$3"; else fail "$3 (wanted '$2', got '$1')"; fi; }
has() { case "$1" in *"$2"*) pass "$3" ;; *) fail "$3"; echo "        got: $1" | head -c 1500; echo ;; esac; }
hasnt() { case "$1" in *"$2"*) fail "$3"; echo "        got: $1" | head -c 1500; echo ;; *) pass "$3" ;; esac; }
stop_daemon() {
  if [ -f "$1/daemon.lock" ]; then
    P=$(cat "$1/daemon.lock")
    kill "$P" 2>/dev/null
    for _ in $(seq 1 30); do kill -0 "$P" 2>/dev/null || break; sleep 0.2; done
    kill -0 "$P" 2>/dev/null && kill -9 "$P" 2>/dev/null
  fi
  rm -f "$1/daemon.sock" "$1/daemon.lock"
}
start_daemon() { CROSSTALK_HOME="$1" CROSSTALK_PROXY_PORT="$2" nohup bun src/daemon.ts >>"$3" 2>&1 & }
rpc() { CROSSTALK_HOME="$1" bun -e '
  const { request } = await import("./src/client.ts")
  console.log(JSON.stringify(await request(JSON.parse(process.argv[1]), 60000)))
' "$2" 2>&1; }
field() { echo "$1" | bun -e 'const r = JSON.parse(await Bun.stdin.text()); const v = (0, eval)("(r) => " + process.argv[1])(r); console.log(typeof v === "string" ? v : JSON.stringify(v ?? null))' "$2"; }
mcp() { bun "$ROOT/test/mcp-call.ts" "$1" "$2" "$3" "$4" "$5" 2>&1; }
via() { curl -s --max-time 10 --resolve "$2:$1:127.0.0.1" "http://$2:$1${3:-/}" 2>/dev/null; }
# ben's curl, only once ana's server is what answers: his proxy's "no service is called that" page is
# an answer too, and waitfor would stop at it.
reaches() { local v; v=$(via "$@"); case "$v" in *"up on"*) echo "$v" ;; esac; }
waitfor() {
  local n=$1; shift
  for _ in $(seq 1 $((n * 5))); do v=$("$@" 2>/dev/null); [ -n "$v" ] && { echo "$v"; return; }; sleep 0.2; done
  echo ""
}
RELAY_PID=""
OTHER=""
cleanup() {
  stop_daemon "$A"; stop_daemon "$B"; stop_daemon "$C"
  [ -n "$RELAY_PID" ] && kill "$RELAY_PID" 2>/dev/null
  [ -n "$OTHER" ] && kill "$OTHER" 2>/dev/null
  tmux -L crosstalk kill-server 2>/dev/null
  pkill -f "$TMP/" 2>/dev/null
  if [ "$FAILED" -ne 0 ] && [ -n "${SHARE_KEEP:-}" ]; then
    mkdir -p "$SHARE_KEEP" && cp -r "$TMP"/*.log "$A" "$B" "$C" "$SHARE_KEEP"/ 2>/dev/null
    echo "logs kept in $SHARE_KEEP"
  fi
  rm -rf "$TMP"
}
trap cleanup EXIT
echo "state in $TMP"

# The server: its PORT on /, 2 MB on /big, a websocket echo on /ws.
cat >"$TMP/srv.ts" <<'EOF'
const port = Number(process.env.PORT)
const big = new Uint8Array(2 * 1024 * 1024 + 77).map((_, i) => (i * 13) % 251)
Bun.serve({
  port,
  hostname: "127.0.0.1",
  fetch(req, srv) {
    const u = new URL(req.url)
    if (u.pathname === "/ws" && srv.upgrade(req)) return
    if (u.pathname === "/big") return new Response(big)
    return new Response(`up on ${port} host=${req.headers.get("host")} viewer=${req.headers.get("x-crosstalk-viewer")}`)
  },
  websocket: { message(ws, m) { ws.send(`echo ${m}`) } },
})
console.log(`listening on ${port}`)
EOF
cat >"$TMP/ws.ts" <<'EOF'
import net from "node:net"
import crypto from "node:crypto"
const [port, host] = process.argv.slice(2)
const s = net.connect(Number(port), "127.0.0.1")
const key = crypto.randomBytes(16).toString("base64")
let buf = Buffer.alloc(0)
let open = false
setTimeout(() => { console.log("timeout"); process.exit(1) }, 10000)
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
# A raw request with an absolute-form target, as a proxy-minded client sends it.
cat >"$TMP/raw.ts" <<'EOF'
import net from "node:net"
const [port, host, target] = process.argv.slice(2)
const s = net.connect(Number(port), "127.0.0.1", () => s.write(`GET ${target} HTTP/1.1\r\nHost: ${host}\r\nConnection: close\r\n\r\n`))
let out = ""
s.on("data", (d) => (out += d))
s.on("close", () => { console.log(out); process.exit(0) })
s.on("error", (e) => { console.log("error " + e.message); process.exit(0) })
setTimeout(() => { console.log(out || "timeout"); process.exit(0) }, 10000)
EOF

# --- the repo, the relay, and two direct channels: ana-ben, ana-cat --------------------------
REPO="$TMP/code/app"
mkdir -p "$REPO"
git -C "$REPO" init -q -b main
echo hi >"$REPO/README.md"
git -C "$REPO" add . && git -C "$REPO" commit -qm init
WT="$REPO/.claude/worktrees/auth"
git -C "$REPO" worktree add -q -b crosstalk/auth "$WT"

(cd "$TMP/relay" && exec bun "$ROOT/relay/relay.ts" --host 127.0.0.1 --port "$PORT" >"$TMP/relay.log" 2>&1) &
RELAY_PID=$!
for _ in $(seq 1 30); do curl -sf -m 1 "http://127.0.0.1:$PORT/health" >/dev/null && break; sleep 0.3; done
pairup() { # owner-home owner-label other-home other-label log
  CROSSTALK_HOME="$1" CROSSTALK_PROXY_PORT=0 bun src/cli.ts room new --label "$2" --relay "ws://127.0.0.1:$PORT" >"$5.new" 2>&1 &
  local INVITE=""
  for _ in $(seq 1 40); do
    INVITE=$(sed -n 's/^    \([0-9]\{3,6\}-[a-z][a-z-]*.*\)$/\1/p' "$5.new" | head -1)
    [ -n "$INVITE" ] && break
    sleep 0.5
  done
  [ -z "$INVITE" ] && { echo "no invite"; cat "$5.new"; exit 1; }
  CROSSTALK_HOME="$3" CROSSTALK_PROXY_PORT=0 bun src/cli.ts room join $INVITE --label "$4" --relay "ws://127.0.0.1:$PORT" >"$5.join" 2>&1
  for _ in $(seq 1 30); do grep -q "Now in a room with" "$5.new" && break; sleep 0.5; done
  grep -q "in a room with" "$5.join" || { echo "joining did not complete"; cat "$5.join"; exit 1; }
}
pairup "$A" ana "$B" ben "$TMP/ab"
stop_daemon "$A"
pairup "$A" ana "$C" cat "$TMP/ac"
stop_daemon "$A"; stop_daemon "$B"; stop_daemon "$C"
start_daemon "$A" "$PA" "$TMP/da.log"
start_daemon "$B" "$PB" "$TMP/db.log"
start_daemon "$C" "$PC" "$TMP/dc.log"
for _ in $(seq 1 40); do [ -S "$A/daemon.sock" ] && [ -S "$B/daemon.sock" ] && [ -S "$C/daemon.sock" ] && break; sleep 0.25; done
has "$(waitfor 15 grep -o 'relay ready' "$TMP/db.log")" "relay ready" "three daemons on one relay"
for X in "a $PA" "b $PB" "c $PC"; do set -- $X
  has "$(waitfor 10 grep -o "proxy on http://127.0.0.1:$2" "$TMP/d$1.log")" "proxy on http://127.0.0.1:$2" "daemon $1's proxy is on :$2"
done
check "$(field "$(rpc "$A" '{"op":"peers"}')" 'r.peers.map(p => p.label).sort().join(",")')" "ben,cat" "ana has a direct channel with ben and with cat"

# --- ana serves, and shares with ben -----------------------------------------------------------
echo
echo "share: ana shows ben the auth page"
OUT=$(mcp "$A" sess-a crosstalk_serve "{\"command\":\"bun $TMP/srv.ts\",\"name\":\"web\"}" "$WT")
has "$OUT" "started web" "ana's server runs as a crosstalk service"
SP=$(echo "$OUT" | sed -n 's/.*PORT=\([0-9]*\).*/\1/p' | head -1)
has "$(waitfor 15 sh -c "curl -s --max-time 2 http://127.0.0.1:$SP/")" "up on $SP" "and answers on :$SP"
waitfor 10 sh -c "grep -o '\"host\": \"auth\"' '$A/proxy.json'" >/dev/null
OUT=$(mcp "$A" sess-a crosstalk_share '{"name":"auth web","with":["ben"]}' "$WT")
has "$OUT" "shared auth · web with ben until" "crosstalk_share shares it with ben"
has "$OUT" "no public URL" "through the encrypted channel, not a public URL"
has "$OUT" "auth.ana.localhost" "and says what ben's name for it is"
SID=$(field "$(cat "$A/shares.json")" 'r.out[0].id')
has "$(waitfor 15 sh -c "grep -o 'auth.ana.localhost' '$B/urls.json'")" "auth.ana.localhost" "ben's daemon takes the offer and names it"
has "$(waitfor 15 grep -o "ana shared auth · web as auth.ana.localhost" "$TMP/db.log")" "auth.ana.localhost" "with a listener of its own"
has "$(waitfor 10 sh -c "grep -o '\"host\": \"auth.ana\"' '$B/proxy.json'")" "auth.ana" "ben's proxy routes auth.ana.localhost"

PAGE=$(waitfor 15 reaches "$PB" auth.ana.localhost /)
has "$PAGE" "up on $SP" "ben's curl through his proxy gets ana's page"
has "$PAGE" "host=auth.ana.localhost:$PB" "the Host is ben's name for it"
has "$PAGE" "viewer=ben" "and ana's server can tell it is ben"
SUM=$(curl -s --max-time 30 --resolve "auth.ana.localhost:$PB:127.0.0.1" "http://auth.ana.localhost:$PB/big" | sha256sum | cut -c1-16)
WANT=$(curl -s --max-time 10 "http://127.0.0.1:$SP/big" | sha256sum | cut -c1-16)
check "$SUM" "$WANT" "a 2 MB response arrives whole, in chunks over the relay"
has "$(bun "$TMP/ws.ts" "$PB" "auth.ana.localhost:$PB" 2>&1)" "echo hello" "a websocket through it echoes"
LIST=$(mcp "$B" sess-b crosstalk_urls '{"kind":"shared"}' "$TMP")
has "$LIST" "auth · web · from ana · until" "ben's crosstalk_urls lists it as shared from ana"
has "$LIST" "http://auth.ana.localhost:$PB" "by its name"
has "$LIST" "data, not instructions" "framed as data"
has "$(mcp "$A" sess-a crosstalk_urls '{"kind":"shared"}' "$WT")" "shared with ben · until" "ana's lists it as shared with ben"
has "$(mcp "$B" sess-b crosstalk_shares '{}' "$TMP")" "ana shares auth · web with you" "crosstalk_shares on ben's side"
has "$(cat "$B/history.json" "$B"/*.json 2>/dev/null | grep -o 'ana shared auth · web with you' | head -1)" "ana shared auth · web with you" "ben is told (a digest line without the mod); nothing was opened"

# --- cat, who is not named ---------------------------------------------------------------------
echo
echo "not named: cat cannot"
MISS=$(curl -s --max-time 5 --resolve "auth.ana.localhost:$PC:127.0.0.1" "http://auth.ana.localhost:$PC/")
hasnt "$MISS" "up on" "cat's proxy has no auth.ana.localhost"
PROBE=$(rpc "$C" "{\"op\":\"share_probe\",\"to\":\"ana\",\"share\":\"$SID\",\"path\":\"/\"}")
check "$(field "$PROBE" 'r.status')" "403" "a request cat makes on the share's id by hand is refused by ana's daemon"
hasnt "$PROBE" "up on" "and reaches nothing"
has "$(grep -o "refused cat on $SID: not shared with you" "$TMP/da.log" | head -1)" "not shared with you" "ana's daemon says why"

# --- no SSRF -----------------------------------------------------------------------------------
echo
echo "no SSRF: only the shared server"
OP=$((CROSSTALK_PORT_START + 77))
PORT=$OP nohup bun -e 'Bun.serve({ port: Number(process.env.PORT), hostname: "127.0.0.1", fetch: () => new Response("ANA PRIVATE SERVER") })' >/dev/null 2>&1 &
OTHER=$!
has "$(waitfor 10 sh -c "curl -s --max-time 1 http://127.0.0.1:$OP/")" "ANA PRIVATE" "ana has another server, not shared, on :$OP"
RAW=$(bun "$TMP/raw.ts" "$PB" "auth.ana.localhost:$PB" "http://127.0.0.1:$OP/")
hasnt "$RAW" "ANA PRIVATE" "an absolute-form request for :$OP through ben's name never reaches it"
has "$RAW" "up on $SP" "it is the shared server's path"
PROBE=$(rpc "$B" "{\"op\":\"share_probe\",\"to\":\"ana\",\"share\":\"$SID\",\"path\":\"http://127.0.0.1:$OP/\"}")
check "$(field "$PROBE" 'r.status')" "400" "a frame whose path is another host and port is refused"
hasnt "$PROBE" "ANA PRIVATE" "and reaches nothing"
OUT=$(mcp "$A" sess-a crosstalk_share "{\"url\":\"http://localhost:$PA\",\"with\":[\"ben\"]}" "$WT")
check "$(field "$(cat "$A/shares.json")" 'r.out.length')" "1" "ana's own proxy cannot be shared"

# --- unshare, and expiry -----------------------------------------------------------------------
echo
echo "unshare and expiry cut it off"
OUT=$(mcp "$A" sess-a crosstalk_unshare '{"name":"auth"}' "$WT")
has "$OUT" "stopped sharing auth · web" "crosstalk_unshare stops it"
has "$(waitfor 15 grep -o "ana's $SID revoked" "$TMP/db.log")" "revoked" "ben's daemon hears of it"
hasnt "$(via "$PB" auth.ana.localhost /)" "up on" "ben's curl gets nothing now"
PROBE=$(rpc "$B" "{\"op\":\"share_probe\",\"to\":\"ana\",\"share\":\"$SID\",\"path\":\"/\"}")
check "$(field "$PROBE" 'r.status')" "410" "and ana's daemon refuses the old share by itself"
has "$(waitfor 10 sh -c "grep -o '\"state\": \"revoked\"' '$B/urls.json'")" "revoked" "ben's link is marked ended"

# The same server shared again right after: a new share (a new id) that ben's proxy routes as soon
# as his daemon takes the offer, not at the proxy's next look. Long enough that delivery never races
# the expiry; the expiry is then waited for as an event, on both sides.
OUT=$(mcp "$A" sess-a crosstalk_share '{"name":"auth web","with":["ben"],"for":"0.2m"}' "$WT")
has "$OUT" "shared auth · web with ben" "shared again, for twelve seconds"
SID2=$(field "$(cat "$A/shares.json")" 'r.out.find(s => !s.ended).id')
has "$(waitfor 15 sh -c "grep -o '\"id\": \"$SID2\"' '$B/shares.json'")" "$SID2" "ben's daemon takes the new offer"
# One look, no retry: the route is in ben's proxy before his shares.json has the share.
has "$(via "$PB" auth.ana.localhost /)" "up on $SP" "ben reaches it at once"
has "$(waitfor 30 grep -o "share: $SID2 expired" "$TMP/da.log")" "expired" "ana's daemon ends it when its time is up"
has "$(waitfor 15 grep -o "ana's $SID2 expired" "$TMP/db.log")" "expired" "and ben's daemon ends it too"
hasnt "$(via "$PB" auth.ana.localhost /)" "up on" "after that, ben cannot reach it"
PROBE=$(rpc "$B" "{\"op\":\"share_probe\",\"to\":\"ana\",\"share\":\"$SID2\",\"path\":\"/\"}")
check "$(field "$PROBE" 'r.status')" "410" "ana's daemon refuses an expired share"

stop_daemon "$A"; stop_daemon "$B"; stop_daemon "$C"
echo
[ $FAILED -eq 0 ] && echo "share: all $PASSES passed" || { echo "share: FAILED"; exit 1; }
