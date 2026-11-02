#!/usr/bin/env bash
# One check against the real Claude Code binary: a background agent's
# permission prompt, relayed by crosstalk's PermissionRequest hook, waits for
# the person's answer and gets it.
#
#   bash test/attention-real.sh            (one model call; skipped without claude)
#
# A real `claude` (CLAUDE_BIN, default /opt/node22/bin/claude) runs in tmux with
# this checkout as --plugin-dir and CROSSTALK_BG_AGENT set, as crosstalk starts
# its background agents, and is asked to run `touch`. Its permission prompt
# must become a crosstalk question, the hook must still be waiting 20 seconds
# later, and the file must appear only after the question is answered Allow.

set -u
cd "$(dirname "$0")/.."
ROOT=$(pwd)
CLAUDE_BIN=${CLAUDE_BIN:-/opt/node22/bin/claude}
[ -x "$CLAUDE_BIN" ] || { echo "attention-real: skipped, no claude at $CLAUDE_BIN"; exit 0; }
TMP=$(mktemp -d)
export CROSSTALK_HOME="$TMP/home" TMUX_TMPDIR="$TMP/tmux"
export CROSSTALK_NO_GATHER=1 CROSSTALK_NO_RESTORE=1 CROSSTALK_NO_TERM=1 CROSSTALK_NO_REPOTRUST=1 CROSSTALK_NO_NOTIFY=1 CROSSTALK_THREADS_NO_PUSH=1
unset TMUX TMUX_PANE CLAUDE_CODE_SESSION_ID CLAUDECODE CLAUDE_CODE_MESSAGING_SOCKET CLAUDE_CODE_ENTRYPOINT
mkdir -p "$CROSSTALK_HOME" "$TMUX_TMPDIR" "$TMP/cfg" "$TMP/work"
FAILED=0
pass() { echo "  PASS  $1"; }
fail() { echo "  FAIL  $1"; FAILED=1; }
cleanup() {
  [ -f "$CROSSTALK_HOME/daemon.lock" ] && kill "$(cat "$CROSSTALK_HOME/daemon.lock")" 2>/dev/null
  tmux -L rb kill-server 2>/dev/null
  sleep 0.5; [ -n "${KEEP:-}" ] && echo "kept $TMP" || rm -rf "$TMP" 2>/dev/null || true
}
trap cleanup EXIT
git -C "$TMP/work" init -q -b main && git -C "$TMP/work" -c user.email=t@t -c user.name=t commit -q --allow-empty -m init
cat >"$TMP/cfg/.claude.json" <<EOF
{ "hasCompletedOnboarding": true, "theme": "dark",
  "projects": { "$TMP/work": { "hasTrustDialogAccepted": true, "hasCompletedProjectOnboarding": true } } }
EOF
bun -e '
  const { newIdentity } = await import("./src/crypto.ts")
  const { saveIdentity, saveRelay } = await import("./src/config.ts")
  saveIdentity({ ...newIdentity("ana"), machine: "desk" })
  saveRelay("ws://127.0.0.1:9")
'
nohup bun src/daemon.ts >>"$TMP/daemon.log" 2>&1 &
for _ in $(seq 1 40); do [ -S "$CROSSTALK_HOME/daemon.sock" ] && break; sleep 0.25; done
# The person's own session, where the question is put.
bun -e '
  const { request } = await import("./src/client.ts")
  await request({ op: "register", sessionId: "me", pid: 1, name: "me", cwd: process.argv[1], socket: "" })
' "$TMP/work"

echo "a real claude $("$CLAUDE_BIN" --version) in the background, asked to run touch"
tmux -L rb new-session -d -s bg -x 200 -y 50 -c "$TMP/work" \
  "env CROSSTALK_BG_AGENT=bgreal CLAUDE_CONFIG_DIR=$TMP/cfg $CLAUDE_BIN --plugin-dir $ROOT --model haiku 'Use the Bash tool to run exactly this command, then stop: touch made-by-bg.txt'"
item() { bun -e 'try { const f = JSON.parse(require("fs").readFileSync(process.argv[1] + "/ui.json", "utf8")); const it = Object.values(f.items).find(i => i.id.startsWith("attn:perm:") && i.state === "pending"); console.log(it ? `${it.id} ${it.sessionId} ${it.question}` : "") } catch { console.log("") }' "$CROSSTALK_HOME"; }
IT=""
for _ in $(seq 1 120); do IT=$(item); [ -n "$IT" ] && break; sleep 1; done
if [ -z "$IT" ]; then
  fail "the permission prompt became a crosstalk question"
  tmux -L rb capture-pane -p -t bg | tail -25
  exit 1
fi
pass "the permission prompt became a crosstalk question: ${IT#* * }"
ID=${IT%% *}
SID=$(echo "$IT" | cut -d' ' -f2)
[ "$SID" = "me" ] && pass "put to the person's session" || fail "put to the person's session (got $SID)"
sleep 20
[ -e "$TMP/work/made-by-bg.txt" ] && fail "nothing ran before the answer" || pass "nothing ran before the answer, 20 s later"
grep -q "attn_permission\|bgreal asks" "$TMP/daemon.log" && pass "the hook is still holding the request" || true
OUT=$(bun -e '
  const { request } = await import("./src/client.ts")
  console.log(JSON.stringify(await request({ op: "ui_act", sessionId: process.argv[1], id: process.argv[2], action: "answer", value: "Allow" })))
' "$SID" "$ID")
case "$OUT" in *'"ok":true'*) pass "answered Allow" ;; *) fail "answered Allow: $OUT" ;; esac
for _ in $(seq 1 90); do [ -e "$TMP/work/made-by-bg.txt" ] && break; sleep 1; done
[ -e "$TMP/work/made-by-bg.txt" ] && pass "the command ran: the decision reached the waiting hook and Claude Code took it" || { fail "the command ran"; tmux -L rb capture-pane -p -t bg | tail -25; }
echo
[ $FAILED -eq 0 ] && echo "attention-real: passed" || echo "attention-real: FAILED"
exit $FAILED
