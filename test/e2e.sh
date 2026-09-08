#!/usr/bin/env bash
# Every feature, two identities, one real relay.
#
#   bash test/e2e.sh
#
# Runs two separate crosstalk installations on this machine, pairs them through
# whichever relay is configured, and exercises the whole surface: pairing,
# messages, slices, presence, questions, the trust ladder, rooms, facts, tasks,
# unprompted sending, local posts, the attention budget, device linking and the
# hook contracts for all three clients.
#
# Two rules learned the hard way and worth keeping: never read an exit code
# through a pipe, because it belongs to the last command, and resolve a process
# by what it is listening on rather than by $!, which in a backgrounded compound
# is the subshell.

set -u
cd "$(dirname "$0")/.."
ROOT=$(pwd)
A=$(mktemp -d)/a
B=$(mktemp -d)/b
mkdir -p "$A" "$B"
PASS=0
FAIL=0

ok()   { echo "  PASS  $1"; PASS=$((PASS+1)); }
bad()  { echo "  FAIL  $1"; FAIL=$((FAIL+1)); }
check() { if [ "$1" = "$2" ]; then ok "$3"; else bad "$3 (wanted '$2', got '$1')"; fi; }
has()  { if echo "$1" | grep -q "$2"; then ok "$3"; else bad "$3"; fi; }

a() { CROSSTALK_HOME="$A" bun src/cli.ts "$@" 2>&1; }
b() { CROSSTALK_HOME="$B" bun src/cli.ts "$@" 2>&1; }
rpc() { CROSSTALK_HOME="$1" bun -e '
  const { request } = await import("./src/client.ts")
  console.log(JSON.stringify(await request(JSON.parse(process.argv[1]))))
' "$2" 2>&1; }
stop() { [ -f "$1/daemon.lock" ] && kill "$(cat "$1/daemon.lock")" 2>/dev/null; rm -f "$1/daemon.sock" "$1/daemon.lock"; }

cleanup() { stop "$A"; stop "$B"; pkill -f "src/cli.ts pair" 2>/dev/null; rm -rf "$A" "$B"; }
trap cleanup EXIT

echo "state in $A and $B"
echo

# --- pairing -------------------------------------------------------------------
echo "pairing"
CROSSTALK_HOME="$A" bun src/cli.ts pair --label ana >"$A/pair.log" 2>&1 &
for _ in $(seq 1 60); do
  INVITE=$(sed -n 's/^    \([0-9]\{3,6\}-[a-z][a-z-]*\)$/\1/p' "$A/pair.log" | head -1)
  [ -n "$INVITE" ] && break
  sleep 0.5
done
if [ -z "$INVITE" ]; then bad "an invite was printed"; cat "$A/pair.log"; exit 1; fi
has "$INVITE" '^[0-9]' "invite leads with a public slot"
check "$(echo "$INVITE" | tr -cd - | wc -c | tr -d ' ')" "4" "four secret words after it"

JOIN=$(b pair "$INVITE" --label ben)
has "$JOIN" 'Paired with "ana"' "the joining side paired"
for _ in $(seq 1 40); do grep -q "Paired with" "$A/pair.log" && break; sleep 0.5; done
has "$(cat "$A/pair.log")" 'Paired with "ben"' "the inviting side paired"

FA=$(bun -e 'const {fingerprint}=await import("./src/crypto.ts");const fs=require("fs");console.log(fingerprint(JSON.parse(fs.readFileSync(process.argv[1]+"/identity.json","utf8")).ed.pub))' "$A")
has "$JOIN" "$FA" "the fingerprints match across the two sides"

# --- daemons -------------------------------------------------------------------
echo
echo "daemons and presence"
# Pairing already starts a daemon, and a second one on the same state directory
# now stands down rather than taking the socket over, so ask each side what its
# own daemon is doing instead of reading the log of a process that may have
# correctly refused to run.
CROSSTALK_HOME="$A" nohup bun src/daemon.ts >>"$A/daemon.log" 2>&1 &
CROSSTALK_HOME="$B" nohup bun src/daemon.ts >>"$B/daemon.log" 2>&1 &
sleep 4
has "$(a status)" "relay connected" "ana's daemon linked to the relay"
has "$(b status)" "relay connected" "ben's daemon linked to the relay"

rpc "$A" '{"op":"register","sessionId":"sa","pid":1,"name":"ana-web","cwd":"/tmp/web","socket":""}' >/dev/null
rpc "$B" '{"op":"register","sessionId":"sb","pid":2,"name":"ben-api","cwd":"/tmp/api","socket":""}' >/dev/null
sleep 3
has "$(a peers)" "ben" "ana sees ben"

# --- messages ------------------------------------------------------------------
echo
echo "messages"
SENT=$(rpc "$B" '{"op":"send","sessionId":"sb","to":"ana","text":"the tenant column is gone","intent":"fyi"}')
has "$SENT" '"ok":true' "ben sent a message"
sleep 3
READ=$(rpc "$A" '{"op":"read","sessionId":"sa","all":true}')
has "$READ" "tenant column is gone" "ana received it"

# --- the trust ladder ----------------------------------------------------------
echo
echo "the trust ladder"
a trust ben notify >/dev/null
ASKED=$(rpc "$B" '{"op":"ask","sessionId":"sb","to":"ana","text":"is the schema frozen?","timeoutMs":8000}')
has "$ASKED" "Refused" "a question is refused when they are only at notify"
a trust ben ask >/dev/null
sleep 1
ASK2=$(rpc "$B" '{"op":"ask","sessionId":"sb","to":"ana","text":"is the schema frozen?","timeoutMs":6000}')
has "$ASK2" "no answer" "at ask it goes through and waits for a reply"

# --- unprompted sending --------------------------------------------------------
echo
echo "what an agent may send on its own"
NOREASON=$(rpc "$B" '{"op":"send","sessionId":"sb","to":"ana","text":"x","intent":"fyi","unprompted":true}')
has "$NOREASON" "why it affects them" "unprompted without a reason is refused"
WITH=$(rpc "$B" '{"op":"send","sessionId":"sb","to":"ana","text":"x","intent":"fyi","unprompted":true,"because":"their query uses it"}')
has "$WITH" '"ok":true' "unprompted with a reason goes"
for i in 1 2 3 4 5; do rpc "$B" '{"op":"send","sessionId":"sb","to":"ana","text":"n","intent":"fyi","unprompted":true,"because":"why"}' >/dev/null; done
OVER=$(rpc "$B" '{"op":"send","sessionId":"sb","to":"ana","text":"n","intent":"fyi","unprompted":true,"because":"why"}')
has "$OVER" "unprompted messages" "the ration runs out"

# --- facts ---------------------------------------------------------------------
echo
echo "what the room remembers"
a facts add "the API returns snake_case" >/dev/null
a facts add "uploads chunk at 4KB" --in palpable-fw >/dev/null
sleep 3
has "$(b facts)" "snake_case" "a fact ana wrote reached ben"
DIGEST=$(CROSSTALK_HOME="$B" bun -e '
  const { request } = await import("./src/client.ts")
  console.log((await request({op:"facts",cwd:"/tmp/anything"})).digest ?? "")' 2>&1)
has "$DIGEST" "snake_case" "an untagged fact is offered everywhere"
if echo "$DIGEST" | grep -q "4KB"; then bad "a tagged fact stays out of an unrelated repo"; else ok "a tagged fact stays out of an unrelated repo"; fi

FID=$(CROSSTALK_HOME="$B" bun -e '
  const { request } = await import("./src/client.ts")
  const r = await request({op:"facts"})
  const f = Object.values(r.facts).flat().find(x => x.text.includes("snake_case"))
  console.log(f ? f.id : "")' 2>&1)
b facts confirm "$FID" >/dev/null
sleep 2
has "$(a facts)" "ben" "ben's confirmation reached ana, so the fact has two names on it"

# --- tasks ---------------------------------------------------------------------
echo
echo "what the room has agreed to do"
a tasks add "wire the upload retry" >/dev/null
sleep 3
has "$(b tasks)" "upload retry" "a task ana added reached ben"
TID=$(CROSSTALK_HOME="$B" bun -e '
  const { request } = await import("./src/client.ts")
  const r = await request({op:"tasks"})
  const t = Object.values(r.tasks).flat()[0]
  console.log(t ? t.id : "")' 2>&1)
has "$(b tasks claim "$TID")" "claim" "ben claimed it"
sleep 3
CLASH=$(a tasks claim "$TID")
has "$CLASH" "somebody else" "ana cannot claim what ben already has"
has "$(b tasks done "$TID" "landed with backoff")" "done" "ben finished it"

# --- rooms ---------------------------------------------------------------------
echo
echo "rooms"
has "$(a room)" "ben" "pairing shows as a room of two"
a room create beta >/dev/null
has "$(a room invite beta ben)" "invited" "ana invited ben to a bigger room"
sleep 3
has "$(b room)" "INVITATION" "ben sees an invitation rather than membership"
b room accept beta >/dev/null
sleep 2
has "$(b room)" "#beta" "ben is in it after accepting"

# --- local sources and the attention budget ------------------------------------
echo
echo "things that are not people"
has "$(a post 'build failed on main' --intent blocking --source ci)" "posted as ci" "a script posted without pairing"
sleep 1
has "$(a attention)" "ci" "the attention view shows what spent it"

# --- hooks, for all three clients ----------------------------------------------
echo
echo "hook contracts"
for shape in \
  '{"session_id":"h1","cwd":"/tmp","hook_event_name":"SessionStart"}' \
  '{"session_id":"h2","cwd":"/tmp","hook_event_name":"SessionStart","thread_name":"codex"}' \
  '{"session_id":"h3","cwd":"/tmp","event_name":"SessionStart"}'
do
  OUT=$(echo "$shape" | env -u CLAUDE_CODE_MESSAGING_SOCKET CROSSTALK_HOME="$A" bun src/hook.ts 2>&1)
  has "$OUT" '"continue":true' "hook accepts $(echo "$shape" | grep -o '"h[0-9]"')"
done
sleep 1
DELIVER=$(echo '{"session_id":"h1","cwd":"/tmp","hook_event_name":"PostToolUse"}' | env -u CLAUDE_CODE_MESSAGING_SOCKET CROSSTALK_HOME="$A" bun src/hook.ts 2>&1)
has "$DELIVER" "continue" "a delivery event answers cleanly"

# agy speaks a different dialect on both sides: camelCase protojson in, steps
# out, and no event name in the payload, so hooks.json passes it as an argument.
# The working set is handed over once per session, on the first event that can
# carry it, so the fact has to exist before that event rather than after.
a facts add "the agy probe ran" >/dev/null 2>&1
AGY_IN='{"conversationId":"agy1","workspacePaths":["/tmp"],"invocationNum":0,"modelName":"gemini-3.8-flash-high"}'
AGY=$(echo "$AGY_IN" | env -u CLAUDE_CODE_MESSAGING_SOCKET CROSSTALK_HOME="$A" bun src/hook.ts PreInvocation 2>&1)
case "$AGY" in
  *continue*|*hookSpecificOutput*) bad "agy gets steps, not Claude Code's shape" ;;
  *) ok "agy gets steps, not Claude Code's shape" ;;
esac
has "$AGY" "injectSteps" "agy start injects the working set"
has "$AGY" "ephemeralMessage" "agy injection uses an ephemeral step"
AGY3=$(echo "$AGY_IN" | env -u CLAUDE_CODE_MESSAGING_SOCKET CROSSTALK_HOME="$A" bun src/hook.ts PreInvocation 2>&1)
check "$AGY3" "{}" "the working set is handed over once, not every turn"

# Codex parses each event against its own schema with deny_unknown_fields, so a
# stray key does not get ignored, it throws away the whole object. These are the
# only top-level fields it allows, and Stop allows no hookSpecificOutput at all.
strict() {
  echo "$1" | bun -e '
    const seen = JSON.parse(await new Response(Bun.stdin).text())
    const top = new Set(["continue","stopReason","suppressOutput","systemMessage","hookSpecificOutput"])
    const inner = new Set(["hookEventName","additionalContext"])
    const bad = [
      ...Object.keys(seen).filter((k) => !top.has(k)),
      ...Object.keys(seen.hookSpecificOutput ?? {}).filter((k) => !inner.has(k)),
    ]
    console.log(bad.length ? bad.join(",") : "ok")
  '
}
for ev in SessionStart UserPromptSubmit PostToolUse Stop SessionEnd; do
  OUT=$(echo "{\"session_id\":\"h1\",\"cwd\":\"/tmp\",\"hook_event_name\":\"$ev\"}" \
    | env -u CLAUDE_CODE_MESSAGING_SOCKET CROSSTALK_HOME="$A" bun src/hook.ts 2>&1)
  check "$(strict "$OUT")" "ok" "$ev output has only fields codex allows"
done
STOP=$(echo '{"session_id":"h1","cwd":"/tmp","hook_event_name":"Stop"}' | env -u CLAUDE_CODE_MESSAGING_SOCKET CROSSTALK_HOME="$A" bun src/hook.ts 2>&1)
case "$STOP" in
  *hookSpecificOutput*) bad "Stop carries no hookSpecificOutput" ;;
  *) ok "Stop carries no hookSpecificOutput" ;;
esac

# Kimi's payload is indistinguishable from Claude Code's, so its config names
# it. UserPromptSubmit is the only event it renders a hook result for, so its
# SessionStart registers and stays quiet.
K=$(echo '{"session_id":"km1","cwd":"/tmp","hook_event_name":"SessionStart"}' | env -u CLAUDE_CODE_MESSAGING_SOCKET CROSSTALK_HOME="$A" bun src/hook.ts --client kimi 2>&1)
check "$K" "{}" "kimi session start registers and says nothing"
KIMI=$(echo '{"session_id":"km1","cwd":"/tmp","hook_event_name":"UserPromptSubmit"}' | env -u CLAUDE_CODE_MESSAGING_SOCKET CROSSTALK_HOME="$A" bun src/hook.ts --client kimi 2>&1)
has "$KIMI" '"message"' "kimi delivers on UserPromptSubmit"
case "$KIMI" in
  *hookSpecificOutput*|*continue*) bad "kimi gets message and nothing else" ;;
  *) ok "kimi gets message and nothing else" ;;
esac

# Codex will not run a hook it has not been told to trust, and says nothing when
# it skips one, so `crosstalk doctor` has to notice. Trust is keyed by file,
# event and the handler's index within that file.
CX=$(mktemp -d)
mkdir -p "$CX/.codex"
cat > "$CX/.codex/hooks.json" <<'JSON'
{"hooks":{"SessionStart":[{"hooks":[{"type":"command","command":"/other/notify.sh"}]},
                          {"hooks":[{"type":"command","command":"/x/bin/crosstalk hook"}]}]}}
JSON
: > "$CX/.codex/config.toml"
OUT=$(HOME="$CX" a doctor 2>&1)
has "$OUT" "not trusted yet" "doctor spots an untrusted codex hook"
printf '[hooks.state."%s/.codex/hooks.json:session_start:1:0"]\ntrusted_hash = "sha256:abc"\n' "$CX" > "$CX/.codex/config.toml"
OUT=$(HOME="$CX" a doctor 2>&1)
case "$OUT" in
  *"not trusted yet"*) bad "doctor stops warning once the hook is trusted" ;;
  *) ok "doctor stops warning once the hook is trusted" ;;
esac
rm -rf "$CX"

# Cursor sends hook_event_name like Claude Code but names steps in camelCase and
# reads a flat snake_case answer. It also throws away any context over 10k
# rather than shortening it, so crosstalk shortens it first.
CUR='{"hook_event_name":"sessionStart","session_id":"cu1","conversation_id":"cu1","cursor_version":"2026.08.11","workspace_roots":["/tmp"]}'
OUT=$(echo "$CUR" | env -u CLAUDE_CODE_MESSAGING_SOCKET CROSSTALK_HOME="$A" bun src/hook.ts 2>&1)
has "$OUT" '"additional_context"' "cursor gets flat additional_context"
case "$OUT" in
  *hookSpecificOutput*|*continue*|*decision*) bad "cursor gets additional_context and nothing else" ;;
  *) ok "cursor gets additional_context and nothing else" ;;
esac
OUT=$(echo '{"hook_event_name":"afterAgentThought","session_id":"cu1","cursor_version":"x","workspace_roots":["/tmp"]}' \
  | env -u CLAUDE_CODE_MESSAGING_SOCKET CROSSTALK_HOME="$A" bun src/hook.ts 2>&1)
check "$OUT" "{}" "a cursor step that cannot deliver stays quiet"
BIG=$(bun -e 'console.log("x".repeat(60000))')
for i in 1 2 3; do a facts add "$BIG" >/dev/null 2>&1; done
OUT=$(echo "$CUR" | env -u CLAUDE_CODE_MESSAGING_SOCKET CROSSTALK_HOME="$A" bun src/hook.ts 2>&1)
LEN=$(echo "$OUT" | bun -e 'const o=JSON.parse(await new Response(Bun.stdin).text());console.log((o.additional_context??"").length)')
[ "$LEN" -le 10000 ] && ok "cursor context is trimmed to fit ($LEN chars)" || bad "cursor context is $LEN chars, over the 10000 limit"

# Goose is the mirror image of the others: it never adds context, but a Stop
# hook that refuses to let the turn end has its reason put in front of the
# model. An object it cannot find a decision in counts as the hook failing, so
# saying nothing has to be said as "allow".
GOOSE_START='{"event":"SessionStart","session_id":"gs1","working_dir":"/tmp"}'
GOOSE_STOP='{"event":"Stop","session_id":"gs1","working_dir":"/tmp"}'
OUT=$(echo "$GOOSE_START" | env -u CLAUDE_CODE_MESSAGING_SOCKET CROSSTALK_HOME="$A" bun src/hook.ts 2>&1)
check "$OUT" '{"decision":"allow"}' "goose session start allows and says nothing"
rpc "$A" '{"op":"post","text":"a goose message","intent":"fyi","source":"ci"}' >/dev/null
sleep 1
OUT=$(echo "$GOOSE_STOP" | env -u CLAUDE_CODE_MESSAGING_SOCKET CROSSTALK_HOME="$A" bun src/hook.ts 2>&1)
has "$OUT" '"decision":"block"' "goose delivers by refusing to stop"
has "$OUT" '"reason"' "goose carries the notice as the reason"
case "$OUT" in
  *hookSpecificOutput*|*additionalContext*|*continue*) bad "goose gets a decision and nothing else" ;;
  *) ok "goose gets a decision and nothing else" ;;
esac

# Hermes names events in snake_case, reads back a `context` string, and reads it
# on pre_llm_call only. Asking for a notice consumes it, so on_session_start
# must stay silent or it swallows one into an answer nobody reads.
HRM_START='{"hook_event_name":"on_session_start","session_id":"hrm1","cwd":"/tmp"}'
HRM_TURN='{"hook_event_name":"pre_llm_call","session_id":"hrm1","cwd":"/tmp","extra":{"is_first_turn":true}}'
OUT=$(echo "$HRM_START" | env -u CLAUDE_CODE_MESSAGING_SOCKET CROSSTALK_HOME="$A" bun src/hook.ts on_session_start 2>&1)
check "$OUT" "{}" "hermes session start says nothing"
OUT=$(echo "$HRM_TURN" | env -u CLAUDE_CODE_MESSAGING_SOCKET CROSSTALK_HOME="$A" bun src/hook.ts pre_llm_call 2>&1)
has "$OUT" '"context"' "hermes first turn injects as context"
case "$OUT" in
  *additionalContext*|*injectSteps*) bad "hermes gets context and nothing else" ;;
  *) ok "hermes gets context and nothing else" ;;
esac

# --- the label a person actually sees ------------------------------------------
#
# Claude Code renders from-name to the user and shows the same string to the
# model, so it carries the brand and the fact that this came from someone else.
echo
echo "the arriving-message label"
LBL=$(bun -e '
  const net = await import("node:net")
  const fs = await import("node:fs")
  const os = await import("node:os")
  const path = await import("node:path")
  const sock = path.join(os.tmpdir(), `ct-label-${process.pid}.sock`)
  const got = new Promise((res) => {
    const srv = net.createServer((c) => {
      let buf = ""
      c.on("data", (d) => (buf += d))
      c.on("end", () => { res(buf); srv.close() })
    })
    srv.listen(sock)
  })
  const { injectNotice } = await import("./src/inject.ts")
  await injectNotice({ socket: sock, fromName: "crosstalk \u25e2 marie/api" },
    { count: 1, peer: "marie", peerSession: "api", intent: "fyi", kind: "message" })
  const raw = await got
  try { fs.unlinkSync(sock) } catch {}
  console.log(JSON.parse(raw.trim().split("\n").pop()).message.content)
' 2>&1)
has "$LBL" 'from-name="crosstalk ◢ marie/api"' "the label carries the mark and the name"
has "$LBL" 'cross-session-message' "it is still the framing Claude Code expects"
case "$LBL" in
  *"marie</"*|*"<marie"*) bad "a peer name cannot break out of the attribute" ;;
  *) ok "a peer name cannot break out of the attribute" ;;
esac

# --- the MCP server ------------------------------------------------------------
#
# For a client with no hook this is the whole of crosstalk, so it is checked
# against the protocol rather than against any one client.
echo
echo "mcp server"
bun test/mcp.ts "$A" > "$A/mcp.log" 2>&1
cat "$A/mcp.log"
PASS=$((PASS + $(grep -c '  PASS  ' "$A/mcp.log")))
FAIL=$((FAIL + $(grep -c '  FAIL  ' "$A/mcp.log")))

# --- cost ----------------------------------------------------------------------
echo
echo "cost"
has "$(a cost)" "ben" "traffic is accounted per person"

echo
echo "─────────────────────────────"
echo "  $PASS passed, $FAIL failed"
[ "$FAIL" = "0" ] && echo "  all good" || echo "  something above needs looking at"
exit "$FAIL"
