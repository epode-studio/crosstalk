#!/usr/bin/env bash
# Screenshots as evidence and servers that look after themselves, end to end
# (docs/urls.md): a real daemon, a real bun HTTP server run as a crosstalk
# service in tmux, the real hook, MCP server and CLI, and a real headless
# browser (Playwright when it resolves, else Chrome; skipped with a note when
# neither is here).
#
#   bash test/shots.sh
#
#   capture     crosstalk_screenshot makes a PNG of the thread's server
#   turn        an edit (PostToolUse) then Stop makes an after, paired with
#               the capture before it
#   evidence    a risky feature's evidence in that thread carries both
#   crash       the server exiting with status 3 is restarted once by
#               itself, and its agent gets a heads-up with its log
#   again       crashing again: not restarted, the tab is "broken", the agent
#               told; the agent's own restart that crashes too tells the
#               person once, and nothing is restarted after that
#
# Every process and tmux server started here is torn down on exit.

set -u
export CROSSTALK_NO_GATHER=1 CROSSTALK_NO_RESTORE=1 CROSSTALK_NO_REPOTRUST=1 CROSSTALK_NO_NOTIFY=1 CROSSTALK_NO_DOCTOR=1 CROSSTALK_NO_PROXY=1
export CROSSTALK_THREAD_SYNC_MS=600000 CROSSTALK_THREADS_NO_PUSH=1 CROSSTALK_CLEANUP_EVERY_MS=0
export CROSSTALK_PORT_START=${CROSSTALK_PORT_START:-48500}
export CROSSTALK_URL_TICK_MS=300 CROSSTALK_URL_SYNC_MS=300 CROSSTALK_URL_CHECK_MS=500
export CROSSTALK_HEALTH_TICK_MS=400 CROSSTALK_HEALTH_BACKOFF_MS=300 CROSSTALK_NO_SHOT_BASELINE=1
export CROSSTALK_SHOTS_SETTLE_MS=300 CROSSTALK_SHOTS_TURN_GAP_MS=0 CROSSTALK_TERM_SYNC=1
# The history's drain (src/urls/history/) waits, so what a capture appended can be read here.
export CROSSTALK_HISTORY_MS=600000
cd "$(dirname "$0")/.."
ROOT=$(pwd)
TMP=$(mktemp -d)
export REAL_HOME="$HOME"
export HOME="$TMP/user"
export CROSSTALK_HOME="$TMP/ct"
export TMUX_TMPDIR="$TMP/tmux"
export GIT_AUTHOR_NAME=t GIT_AUTHOR_EMAIL=t@t GIT_COMMITTER_NAME=t GIT_COMMITTER_EMAIL=t@t
unset TMUX TMUX_PANE TERM_PROGRAM CLAUDE_CODE_MESSAGING_SOCKET CLAUDE_CODE_SESSION_ID CROSSTALK_BG_AGENT CLAUDECODE
mkdir -p "$HOME/.claude/sessions" "$CROSSTALK_HOME" "$TMUX_TMPDIR"
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
    kill -0 "$P" 2>/dev/null && kill -9 "$P" 2>/dev/null
  fi
  rm -f "$CROSSTALK_HOME/daemon.sock" "$CROSSTALK_HOME/daemon.lock"
}
cleanup() {
  stop_daemon
  tmux -L crosstalk kill-server 2>/dev/null
  pkill -f "$TMP/" 2>/dev/null
  rm -rf "$TMP"
}
trap cleanup EXIT
mcp() { bun "$ROOT/test/mcp-call.ts" "$CROSSTALK_HOME" "$1" "$2" "$3" "$4" 2>&1; }
rpc() { bun -e '
  const { request } = await import("./src/client.ts")
  console.log(JSON.stringify(await request(JSON.parse(process.argv[1]), 30000)))
' "$1" 2>&1; }
js() { bun -e "$1" "${@:2}" 2>&1; }
waitfor() { # seconds command...: until it prints something
  local n=$1; shift
  for _ in $(seq 1 $((n * 5))); do v=$("$@" 2>/dev/null); [ -n "$v" ] && { echo "$v"; return; }; sleep 0.2; done
  echo ""
}
hook() { printf '%s' "$1" | bun "$ROOT/src/hook.ts" >/dev/null 2>&1; }
health() { js 'const f = JSON.parse(require("fs").readFileSync(process.env.CROSSTALK_HOME + "/health.json", "utf8")); const h = Object.values(f.services).find(h => h.name === "web"); console.log(h ? (0, eval)("(h) => " + process.argv[1])(h) : "")' "$1"; }
held() { rpc '{"op":"read","sessionId":"sess-a","all":true}'; }

ENGINE=$(bun src/cli.ts shots engine --cwd "$ROOT")
case "$ENGINE" in
  *"no headless browser"*) echo "shots: SKIPPED, no headless browser here: $ENGINE"; exit 0 ;;
esac
echo "engine: $(echo "$ENGINE" | head -1)"

# The server: page.html from its folder on /, /die?code=N exits with N, and with crashy present it dies a second after it starts.
cat >"$TMP/srv.ts" <<'EOF'
import fs from "node:fs"
const port = Number(process.env.PORT)
if (fs.existsSync("crashy")) setTimeout(() => { console.log("crashy: going down"); process.exit(4) }, 1200)
Bun.serve({
  port,
  hostname: "127.0.0.1",
  fetch(req) {
    const u = new URL(req.url)
    if (u.pathname === "/die") { const code = Number(u.searchParams.get("code") ?? 1); console.log(`dying with ${code}`); setTimeout(() => process.exit(code), 50); return new Response("bye") }
    return new Response(fs.readFileSync("page.html", "utf8"), { headers: { "content-type": "text/html" } })
  },
})
console.log(`listening on ${port}`)
EOF

echo "state in $TMP"
REPO="$TMP/code/app"
mkdir -p "$REPO"
git -C "$REPO" init -q -b main
echo hi >"$REPO/README.md"
git -C "$REPO" add . && git -C "$REPO" commit -qm init
WT="$REPO/.claude/worktrees/auth"
git -C "$REPO" worktree add -q -b crosstalk/auth "$WT"
cp "$TMP/srv.ts" "$WT/srv.ts"
echo '<body style="background:#fff"><h1>Sign in</h1></body>' >"$WT/page.html"

js '
  const { newIdentity } = await import("./src/crypto.ts")
  const { saveIdentity, saveRelay } = await import("./src/config.ts")
  saveIdentity({ ...newIdentity("ana"), machine: "desk" })
  saveRelay("ws://127.0.0.1:9")
' >/dev/null
nohup bun src/daemon.ts >>"$TMP/daemon.log" 2>&1 &
for _ in $(seq 1 40); do [ -S "$CROSSTALK_HOME/daemon.sock" ] && break; sleep 0.25; done
# The history's first drain runs two seconds after the daemon starts; after it, nothing drains here.
sleep 3
rpc "{\"op\":\"register\",\"sessionId\":\"sess-a\",\"pid\":$$,\"name\":\"auth\",\"cwd\":\"$WT\",\"socket\":\"\"}" >/dev/null

echo
echo "capture: a PNG of the thread's server"
OUT=$(mcp sess-a crosstalk_serve '{"command":"bun srv.ts","name":"web"}' "$WT")
has "$OUT" "started web" "crosstalk_serve starts the server"
P1=$(echo "$OUT" | sed -n 's/.*PORT=\([0-9]*\).*/\1/p' | head -1)
up() { js 'const f = JSON.parse(require("fs").readFileSync(process.env.CROSSTALK_HOME + "/urls.json", "utf8")); const u = f.urls.find(u => u.service === "web" && u.alive && u.lastOk > Number(process.argv[1])); if (u) console.log("up")' "$1"; }
check "$(waitfor 15 up 0)" "up" "its URL is recorded and answers"
SHOT=$(mcp sess-a crosstalk_screenshot '{}' "$WT")
has "$SHOT" "captured 1 of auth's URL" "crosstalk_screenshot captures it"
F1=$(echo "$SHOT" | grep -o '/[^ ]*\.png' | head -1)
check "$(head -c 8 "$F1" 2>/dev/null | od -An -tx1 | tr -d ' \n')" "89504e470d0a1a0a" "a real PNG, under the crosstalk home"
has "$F1" "$CROSSTALK_HOME/shots/auth/" "filed under the thread"
has "$(cat "$CROSSTALK_HOME/shots/index.json")" "\"reason\": \"demand\"" "with its metadata in shots/index.json"
has "$(cat "$CROSSTALK_HOME/history-shots.jsonl" 2>/dev/null)" "\"path\":\"$F1\"" "and noted for the thread's history"
if CROSSTALK_SHOTS_ENGINE=chrome bun src/cli.ts shots engine | grep -q '^chrome'; then
  CH=$(CROSSTALK_SHOTS_ENGINE=chrome bun src/cli.ts shots capture --session sess-a --cwd "$WT" --path /chrome --json)
  has "$CH" '"engine":"chrome"' "without Playwright, an installed Chrome takes it (DevTools over a pipe)"
  has "$(head -c 8 "$(echo "$CH" | grep -o '"file":"[^"]*' | head -1 | cut -d'"' -f4)" | od -An -tx1 | tr -d ' \n')" "89504e470d0a1a0a" "a PNG too"
else
  echo "  (no Chrome here: the Chrome path is not run)"
fi
NOPE=$(mcp sess-a crosstalk_screenshot '{"path":"https://evil.example/"}' "$WT")
has "$NOPE" "a path is the part after the host" "a path cannot point elsewhere"

echo
echo "turn: an edit and Stop make an after"
echo '<body style="background:#1d4ed8;color:#fff"><h1>Sign in with a passkey</h1></body>' >"$WT/page.html"
hook "{\"hook_event_name\":\"PostToolUse\",\"session_id\":\"sess-a\",\"cwd\":\"$WT\",\"tool_name\":\"Edit\",\"tool_input\":{\"file_path\":\"$WT/page.html\",\"old_string\":\"Sign in\",\"new_string\":\"Sign in with a passkey\"},\"tool_response\":{}}"
has "$(cat "$CROSSTALK_HOME/shots/turns/sess-a.json" 2>/dev/null)" "firstEdit" "the edit is noted"
CROSSTALK_SHOTS_SYNC=1 hook "{\"hook_event_name\":\"Stop\",\"session_id\":\"sess-a\",\"cwd\":\"$WT\"}"
PAIRS=$(bun src/cli.ts shots --thread auth --json)
pair() { echo "$PAIRS" | bun -e 'const r = JSON.parse(await Bun.stdin.text()); const p = r.pairs.find(p => !p.path); console.log((0, eval)("(p) => " + process.argv[1])(p))' "$1"; }
check "$(pair 'p.after.reason')" "turn" "Stop captured an after"
check "$(pair 'p.before.file')" "$F1" "paired with the capture before the change"
check "$(pair 'p.after.changeAt < p.after.at && p.before.at < p.after.changeAt')" "true" "the before is from before the turn's first edit"
F2=$(pair 'p.after.file')
check "$(cmp -s "$F1" "$F2" && echo same || echo differs)" "differs" "and the after shows the change"
AGAIN=$(CROSSTALK_SHOTS_SYNC=1 hook "{\"hook_event_name\":\"Stop\",\"session_id\":\"sess-a\",\"cwd\":\"$WT\"}"; bun src/cli.ts shots --thread auth --json | grep -o '"reason":"turn"' | wc -l | tr -d ' ')
check "$AGAIN" "1" "a turn with no new edit captures nothing"
hook "{\"hook_event_name\":\"PostToolUse\",\"session_id\":\"sess-a\",\"cwd\":\"$WT\",\"tool_name\":\"Write\",\"tool_input\":{\"file_path\":\"$WT/page.html\"},\"tool_response\":{}}"
hook "{\"hook_event_name\":\"Stop\",\"session_id\":\"sess-a\",\"cwd\":\"$WT\"}"
turns() { n=$(bun src/cli.ts shots --thread auth --json 2>/dev/null | grep -o '"reason":"turn"' | wc -l | tr -d ' '); [ "$n" -ge 2 ] && echo "$n"; }
check "$(waitfor 30 turns)" "2" "without waiting, Stop starts the capture detached (bin/crosstalk shots turn)"
PAIRS=$(bun src/cli.ts shots --thread auth --json)
check "$(pair 'p.before.file')" "$F2" "its before is the last turn's after"
F1=$(pair 'p.before.file')
F2=$(pair 'p.after.file')
LIST=$(mcp sess-a crosstalk_screenshots '{"name":"auth web"}' "$WT")
has "$LIST" "before $F1" "crosstalk_screenshots lists the before"
has "$LIST" "after $F2" "and the after"
cat >"$TMP/opener" <<EOF
#!/bin/sh
echo "\$@" >>"$TMP/opened"
EOF
chmod +x "$TMP/opener"
OPENED=$(CROSSTALK_OPEN_FILE_CMD="$TMP/opener" mcp sess-a crosstalk_screenshots '{"name":"auth web","open":true}' "$WT")
has "$OPENED" "before" "\"show me the auth page before and after\" opens them"
sleep 0.5
check "$(sort "$TMP/opened" 2>/dev/null | tr '\n' ' ')" "$(printf '%s\n%s\n' "$F1" "$F2" | sort | tr '\n' ' ')" "both images, in the viewer"
PANE=$(js '
  const S = await import("./src/urls/shots/index.ts")
  const P = await import("./src/ui-extra/pure.ts")
  console.log(S.paneShots({ thread: "auth" }).map(s => [P.shotLine(s, Date.now()), P.fileLink(s.after.file)].join(" ")).join("\n"))
')
has "$PANE" "auth · web · before" "the pane's before / after line"
has "$PANE" "file://$CROSSTALK_HOME/shots/auth/" "with a file link"

echo
echo "evidence: a risky feature in that thread carries both"
EV=$(js '
  const M = await import("./src/threads/model.ts")
  const { ShipEngine } = await import("./src/shipping/engine.ts")
  const wt = process.argv[1]
  const threads = new Map()
  const port = {
    me: "fp", label: "ana",
    get: (id) => threads.get(id), find: (_s, n) => [...threads.values()].find((t) => !n || t.meta.value.name === n), all: () => [...threads.values()],
    mutate: (id, fn) => fn(threads.get(id), "fp", Date.now()), notify: () => {},
    open: (o) => { const t = M.create({ name: o.name, repo: "r", by: "fp", label: "ana" }); threads.set(t.id, t); return t },
    sessionsIn: () => ["sess-a"], session: () => ({ sessionId: "sess-a", name: "auth", cwd: wt, root: wt }), rootFor: () => wt,
  }
  const e = new ShipEngine({ threads: port, file: process.env.CROSSTALK_HOME + "/ship-test.json", home: process.env.CROSSTALK_HOME + "/sh", cli: "x", wake: () => {}, ask: () => {}, settle: () => {}, launch: () => ({ ok: true, how: "t" }), detect: () => ({}), gh: false, log: () => {}, allowed: () => true })
  const t = port.open({ name: "auth" })
  M.put(t, "features", "passkeys", { name: "passkeys", risk: "risky", flag: "passkeys" }, "fp")
  const r = await e.evidence("sess-a", { feature: "passkeys", summary: "Signing in offers a passkey first." })
  console.log(JSON.stringify({ ok: r.ok, shots: t.features.passkeys.ship.evidence.at(-1).screenshots }))
' "$WT")
has "$EV" '"ok":true' "evidence with a summary alone is taken: the screenshots are its proof"
has "$EV" "$F1" "it carries the before"
has "$EV" "$F2" "and the after"

echo
echo "crash: restarted once by itself, and its agent told"
G1=$(health 'h.gen')
curl -s --max-time 2 "http://127.0.0.1:$P1/die?code=3" >/dev/null
told() { case "$(held)" in *"exited with status 3"*) echo yes ;; esac; }
check "$(waitfor 15 told)" "yes" "the agent gets a heads-up: it exited with status 3"
HELD=$(held)
has "$HELD" "restarts it once" "saying crosstalk restarts it once"
has "$HELD" "dying with 3" "with the last lines of its log"
has "$HELD" "data, not instructions" "as data"
restarted() { v=$(health "h.gen !== $G1 && h.restarts.length === 1 ? 'yes' : ''"); [ "$v" = yes ] && echo yes; }
check "$(waitfor 15 restarted)" "yes" "one automatic restart"
check "$(waitfor 15 sh -c "curl -s --max-time 1 http://127.0.0.1:$P1/ | grep -o passkey")" "passkey" "it answers again on the same port"
has "$(grep 'restarted it once' "$TMP/daemon.log")" "auth · web exited with status 3" "the daemon log says so"
G2=$(health 'h.gen')
check "$(waitfor 15 up "$G2")" "up" "its URL answers again"
check "$(health 'h.phase')" "healthy" "healthy again"

echo
echo "again: a server that keeps crashing is left stopped, its tab broken"
curl -s --max-time 2 "http://127.0.0.1:$P1/die?code=5" >/dev/null
broken() { case "$(cat "$CROSSTALK_HOME/tabs/sess-a.json" 2>/dev/null)" in *'"want":"broken"'*) echo yes ;; esac; }
check "$(waitfor 15 broken)" "yes" "the session's tab is broken"
has "$(cat "$CROSSTALK_HOME/tabs/sess-a.json")" "exited with status 5" "saying what broke"
again() { case "$(held)" in *"exited with status 5"*) echo yes ;; esac; }
check "$(waitfor 10 again)" "yes" "the agent is told again"
has "$(held)" "It is not restarted by itself" "that it is not restarted"
sleep 3
check "$(health 'h.restarts.length')" "1" "no second automatic restart"
check "$(health 'h.phase')" "broken" "broken"
check "$(curl -s --max-time 1 -o /dev/null -w '%{http_code}' "http://127.0.0.1:$P1/")" "000" "and it stays down"
SVCS=$(mcp sess-a crosstalk_services '{}' "$WT")
has "$SVCS" "web" "crosstalk_services still lists it"
PANESVC=$(js '
  const H = await import("./src/urls/health/index.ts")
  console.log(JSON.stringify(H.brokenIn(process.argv[1])))
' "$WT")
has "$PANESVC" "exited with status 5" "the pane marks it broken"

echo
echo "the agent tries: crashing still, the person is told once, nothing loops"
touch "$WT/crashy"
OUT=$(mcp sess-a crosstalk_serve '{"command":"bun srv.ts","name":"web"}' "$WT")
has "$OUT" "started web" "the agent's crosstalk_serve with the same name starts it again"
gaveup() { [ "$(health 'h.phase')" = gave-up ] && echo yes; }
check "$(waitfor 15 gaveup)" "yes" "it crashes again: given up"
check "$(health 'h.personTold')" "true" "the person is told"
has "$(grep 'the person is told' "$TMP/daemon.log")" "auth · web stays broken" "once"
sleep 3
check "$(health 'h.restarts.length')" "1" "still no restart of crosstalk's own"
check "$(grep -c 'the person is told' "$TMP/daemon.log")" "1" "and the person is not told twice"
check "$(broken)" "yes" "the tab stays broken"

echo
echo "healed: fixed and started again, the tab clears"
rm -f "$WT/crashy"
mcp sess-a crosstalk_serve '{"command":"bun srv.ts","name":"web"}' "$WT" >/dev/null
cleared() { case "$(cat "$CROSSTALK_HOME/tabs/sess-a.json" 2>/dev/null)" in *'"want":"broken"'*) ;; *) echo yes ;; esac; }
check "$(waitfor 20 cleared)" "yes" "healthy again: the tab is not broken any more"
mcp sess-a crosstalk_stop '{"name":"web"}' "$WT" >/dev/null
gone() { [ -z "$(health 'h.name')" ] && echo yes; }
check "$(waitfor 10 gone)" "yes" "crosstalk_stop: forgotten"

echo
[ $FAILED -eq 0 ] && echo "shots: all $PASSES passed" || { echo "shots: FAILED"; tail -30 "$TMP/daemon.log"; exit 1; }
