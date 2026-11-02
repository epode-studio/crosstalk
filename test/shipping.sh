#!/usr/bin/env bash
# Shipping without reading code, through a real daemon, real git and real tmux.
#
#   bash test/shipping.sh
#
# One repo with a bare remote, `.crosstalk/ship` (push: direct, a stub test
# command) and `.crosstalk/risk` (src/auth/**). Stub `claude` and `codex`
# reviewers write canned verdicts. Two agent sessions, each in its own
# worktree, registered in pull mode so what they were told is read back.
#
#   1. everyday   ready → one claude reviewer → approve → green → merged into
#                 main and pushed, signed off in the thread, its copy gone
#   2. risky      by path; codex asks for changes, the author hears it and
#                 answers; round 2 approves; evidence is asked for, a diff
#                 refused; the merge is a question no agent can answer, and it
#                 merges only on a person's yes; its flag starts off in
#                 .crosstalk/flags and ramps by questions, one through the
#                 mod's picker path
#   3. incident   naming the flag turns it off at once and reopens the thread;
#                 an unclear one starts an incident thread
#   4. lowering   making it everyday again is a question; the risk holds
#
# A second repo, a shop, for the rest (time moves on a test clock):
#
#   5. preview    a risky branch is deployed by `preview:` with its flag forced
#                 on, the URL is captured, `preview_check:` runs against it, and
#                 both become evidence; merged, `preview_teardown:` takes it down
#   6. dark       the first flag step is dark; shadow mismatches reported with
#                 `crosstalk incident --source shadow` are counted, never a
#                 kill, and after the dwell the mismatch rate is the evidence
#                 the step to internal is asked on
#   7. regression metrics worse than the baseline turn the flag off by
#                 themselves and reopen the thread
#   8. everyday   a flagged everyday feature goes internal on merge and to
#                 everyone by itself once its metrics hold for the dwell
#   9. providers  Unleash, GrowthBook and Statsig, against local mocks of their APIs
#
# Answering a question from another person's machine is test/shipping-peers.sh.

set -u
export CROSSTALK_NO_GATHER=1 CROSSTALK_NO_RESTORE=1
export CROSSTALK_THREAD_SETTLE_MS=300 CROSSTALK_THREAD_SYNC_MS=600000 CROSSTALK_THREADS_NO_PUSH=1
cd "$(dirname "$0")/.."
ROOT=$(pwd)
TMP=$(mktemp -d)
export CROSSTALK_HOME="$TMP/home"
export TMUX_TMPDIR="$TMP/tmux"
export GIT_AUTHOR_NAME=t GIT_AUTHOR_EMAIL=t@t GIT_COMMITTER_NAME=t GIT_COMMITTER_EMAIL=t@t
export CROSSTALK_BIN="bun $ROOT/src/cli.ts"
unset TMUX TMUX_PANE CLAUDE_CODE_SESSION_ID CLAUDECODE CLAUDE_CODE_MESSAGING_SOCKET
mkdir -p "$CROSSTALK_HOME" "$TMUX_TMPDIR" "$TMP/bin"
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
}
MOCK_PID=""
cleanup() { stop_daemon; [ -n "$MOCK_PID" ] && kill "$MOCK_PID" 2>/dev/null; tmux -L crosstalk kill-server 2>/dev/null; rm -rf "$TMP"; }
trap cleanup EXIT
rpc() { bun -e '
  const { request } = await import("./src/client.ts")
  console.log(JSON.stringify(await request(JSON.parse(process.argv[1]), 60000)))
' "$1" 2>&1; }
field() { echo "$1" | bun -e 'const r = JSON.parse(await Bun.stdin.text()); const v = (0, eval)("(r) => " + process.argv[1])(r); console.log(typeof v === "string" ? v : JSON.stringify(v ?? null))' "$2"; }
ct() { bun "$ROOT/src/cli.ts" "$@"; }
# wait_for <seconds> <command...>: until it prints something other than empty or null.
wait_for() {
  local n=$1; shift
  for _ in $(seq 1 $((n * 4))); do
    v=$("$@" 2>/dev/null)
    [ -n "$v" ] && [ "$v" != "null" ] && { echo "$v"; return; }
    sleep 0.25
  done
  echo ""
}

echo "state in $TMP"

# --- stub reviewers ------------------------------------------------------------------
# claude -p "<prompt>" [--model m] ...: approves, unless a file says otherwise.
cat >"$TMP/bin/claude" <<EOF
#!/bin/sh
prompt=\$2
kind=review
case "\$prompt" in *"security pass"*) kind=security ;; *"adversarial reviewer"*) kind=adversarial ;; esac
echo "claude|\$kind|\$(pwd)|\$*" | cut -c1-300 >>"$TMP/calls"
env >"$TMP/reviewer-env"
# A reviewer that takes its time, while the test tries to answer in its place.
while [ -f "$TMP/hang" ]; do sleep 0.2; done
printf 'Read the change.\nVERDICT: approve\nFINDINGS:\nnone\n'
EOF
# codex exec --skip-git-repo-check --output-last-message FILE "<prompt>": changes once, then approves.
cat >"$TMP/bin/codex" <<EOF
#!/bin/sh
out=\$4
n=\$(cat "$TMP/codex-count" 2>/dev/null || echo 0); n=\$((n+1)); echo \$n >"$TMP/codex-count"
echo "codex|\$n|\$(pwd)" >>"$TMP/calls"
case "\$5" in *"empty passwords"*) seen=yes ;; *) seen=no ;; esac
echo "codex-saw-round1:\$seen" >>"$TMP/calls"
if [ \$n -eq 1 ]; then
  printf 'VERDICT: changes\nFINDINGS:\nlogin accepts empty passwords\n' >"\$out"
else
  printf 'VERDICT: approve\nFINDINGS:\nnone\n' >"\$out"
fi
echo done
EOF
chmod +x "$TMP/bin/claude" "$TMP/bin/codex"
export PATH="$TMP/bin:$PATH"

# --- the repo -----------------------------------------------------------------------------
g() { git -C "$1" "${@:2}"; }
git init -q --bare -b main "$TMP/remote.git"
git clone -q "$TMP/remote.git" "$TMP/code/app" 2>/dev/null
APP="$TMP/code/app"
g "$APP" checkout -q -b main
mkdir -p "$APP/.crosstalk" "$APP/src/auth"
echo "# app" >"$APP/README.md"
printf 'test: sh check.sh\npush: direct\nrounds: 3\nramp: internal 10%% on\n' >"$APP/.crosstalk/ship"
printf 'high: src/auth/**\n' >"$APP/.crosstalk/risk"
printf 'test ! -f BROKEN && env >%s/check-env\n' "$TMP" >"$APP/check.sh"
echo "export const login = () => 1" >"$APP/src/auth/login.ts"
g "$APP" add -A && g "$APP" commit -qm init && g "$APP" push -q -u origin main 2>/dev/null && g "$APP" remote set-head origin main

g "$APP" worktree add -q -b crosstalk/guide "$TMP/code/wt-guide"
mkdir -p "$TMP/code/wt-guide/docs" && echo "how to log in" >"$TMP/code/wt-guide/docs/guide.md"
g "$TMP/code/wt-guide" add -A && g "$TMP/code/wt-guide" commit -qm "user guide"
g "$APP" worktree add -q -b crosstalk/login "$TMP/code/wt-login"
echo "export const login = (p) => check(p)" >"$TMP/code/wt-login/src/auth/login.ts"
g "$TMP/code/wt-login" add -A && g "$TMP/code/wt-login" commit -qm "login v2"

# --- the rest of shipping: a shop with previews, dark launches and metrics -------------------
# Its .crosstalk/ship names scripts in $TMP: the preview prints a URL and
# writes down the env it saw, the check writes down PREVIEW_URL, the teardown
# too, and metrics print $TMP/metrics-<flag>.json.
git init -q --bare -b main "$TMP/shop.git"
git clone -q "$TMP/shop.git" "$TMP/code/shop" 2>/dev/null
SHOP="$TMP/code/shop"
g "$SHOP" checkout -q -b main
mkdir -p "$SHOP/.crosstalk" "$SHOP/src/pay"
cat >"$TMP/preview.sh" <<EOF
#!/bin/sh
echo "CROSSTALK_FLAGS=\$CROSSTALK_FLAGS" >"$TMP/preview-env"
echo "building \$1"
echo "Deployed: https://shop-\$1.preview.test"
EOF
printf '#!/bin/sh\necho "$PREVIEW_URL" >"%s/preview-checked"\necho "checkout e2e: 7 passed"\n' "$TMP" >"$TMP/preview-check.sh"
printf '#!/bin/sh\necho "$PREVIEW_URL" >"%s/preview-down"\n' "$TMP" >"$TMP/preview-down.sh"
printf '#!/bin/sh\ncat "%s/metrics-$CROSSTALK_FLAG.json" 2>/dev/null || echo "{}"\n' "$TMP" >"$TMP/metrics.sh"
cat >"$SHOP/.crosstalk/ship" <<EOF
test: true
push: local
ramp: dark internal on
preview: sh $TMP/preview.sh {branch}
preview_check: sh $TMP/preview-check.sh
preview_teardown: sh $TMP/preview-down.sh
metrics: sh $TMP/metrics.sh
regress: errors:+50% shadow_mismatch_rate:>0.05
dwell: 1h
EOF
printf 'high: src/pay/**\n' >"$SHOP/.crosstalk/risk"
echo "export const charge = 1" >"$SHOP/src/pay/charge.ts"
g "$SHOP" add -A && g "$SHOP" commit -qm init && g "$SHOP" push -q -u origin main 2>/dev/null && g "$SHOP" remote set-head origin main
g "$SHOP" worktree add -q -b crosstalk/pay "$TMP/code/wt-pay"
echo "export const charge = 2" >"$TMP/code/wt-pay/src/pay/charge.ts"
g "$TMP/code/wt-pay" add -A && g "$TMP/code/wt-pay" commit -qm "pay v2"
g "$SHOP" worktree add -q -b crosstalk/banner "$TMP/code/wt-banner"
echo "sale" >"$TMP/code/wt-banner/banner.txt"
g "$TMP/code/wt-banner" add -A && g "$TMP/code/wt-banner" commit -qm "banner"
echo '{"errors": 2, "latency_p95": 110}' >"$TMP/metrics-pay-v2.json"
echo '{"errors": 1, "latency_p95": 90}' >"$TMP/metrics-banner.json"

# GrowthBook and Statsig: one repo each, against local mocks of their APIs.
bun test/flag-mocks.ts "$TMP/mockport" >"$TMP/mock.log" 2>&1 &
MOCK_PID=$!
for _ in $(seq 1 40); do [ -s "$TMP/mockport" ] && break; sleep 0.25; done
MOCK="http://127.0.0.1:$(cat "$TMP/mockport")"
export GROWTHBOOK_API_KEY=secret_gb GROWTHBOOK_API_HOST="$MOCK" GROWTHBOOK_INTERNAL_EMAIL_DOMAIN=shop.test
export STATSIG_CONSOLE_API_KEY=console-ss STATSIG_API_URL="$MOCK/console/v1" STATSIG_INTERNAL_SEGMENT=employees
flagrepo() { # name provider flag-branch
  git init -q --bare -b main "$TMP/$1.git"
  git clone -q "$TMP/$1.git" "$TMP/code/$1" 2>/dev/null
  g "$TMP/code/$1" checkout -q -b main
  mkdir -p "$TMP/code/$1/.crosstalk"
  printf 'test: true\npush: local\nflags: %s\n' "$2" >"$TMP/code/$1/.crosstalk/ship"
  echo "$1" >"$TMP/code/$1/README.md"
  g "$TMP/code/$1" add -A && g "$TMP/code/$1" commit -qm init && g "$TMP/code/$1" push -q -u origin main 2>/dev/null && g "$TMP/code/$1" remote set-head origin main
  g "$TMP/code/$1" worktree add -q -b "crosstalk/$3" "$TMP/code/wt-$1"
  echo "$3" >"$TMP/code/wt-$1/$3.txt"
  g "$TMP/code/wt-$1" add -A && g "$TMP/code/wt-$1" commit -qm "$3"
}
export UNLEASH_URL="$MOCK" UNLEASH_ADMIN_TOKEN="user:unleash-admin-token" UNLEASH_INTERNAL_CONSTRAINT="email ENDS_WITH @shop.test"
flagrepo ul unleash ul-pricing
flagrepo gb growthbook gb-search
flagrepo ss statsig ss-nav
export CROSSTALK_SHIP_CLOCK="$TMP/clock"
# The test clock: ms since the epoch, from now, plus an offset in minutes.
BASE=""
later() { [ -n "$BASE" ] || BASE=$(( $(date +%s) * 1000 )); echo $(( BASE + $1 * 60000 )) >"$TMP/clock"; }

# --- a daemon with an identity, no room ------------------------------------------------------
bun -e '
  const { newIdentity } = await import("./src/crypto.ts")
  const { saveIdentity, saveRelay } = await import("./src/config.ts")
  saveIdentity({ ...newIdentity("ana"), machine: "desk" })
  saveRelay("ws://127.0.0.1:9")
'
nohup bun src/daemon.ts >>"$TMP/daemon.log" 2>&1 &
for _ in $(seq 1 40); do [ -S "$CROSSTALK_HOME/daemon.sock" ] && break; sleep 0.25; done
reg() { rpc "{\"op\":\"register\",\"sessionId\":\"$1\",\"pid\":1,\"name\":\"$1\",\"cwd\":\"$2\",\"socket\":\"\",\"touched\":[]}" >/dev/null; }
reg s-guide "$TMP/code/wt-guide"
reg s-login "$TMP/code/wt-login"
sleep 0.5
ship() { rpc "{\"op\":\"ship\",\"sessionId\":\"$1\",\"cwd\":\"$2\",$3}"; }
state_of() { field "$(rpc '{"op":"ship","action":"status"}')" "r.threads.flatMap(t => t.features).find(f => f.name === '$1')?.state"; }
until_state() { local want=$2; for _ in $(seq 1 120); do [ "$(state_of "$1")" = "$want" ] && { echo "$want"; return; }; sleep 0.25; done; state_of "$1"; }
told() { rpc "{\"op\":\"read\",\"sessionId\":\"$1\",\"all\":true}"; }
ship_items() { field "$(rpc "{\"op\":\"ui\",\"sessionId\":\"$1\"}")" "r.items.filter(i => i.kind === 'ship' && i.state === 'pending').map(i => i.id).join(' ')"; }
questions() { field "$(rpc '{"op":"ship","action":"questions"}')" "r.questions.filter(q => q.kind === '$1').map(q => q.id).join(' ')"; }
flags_on_remote() { git -C "$TMP/remote.git" show main:.crosstalk/flags 2>/dev/null; }
# A person allows a repo's commands once: the first feature of each repo asks.
allow_cmds() { local q; q=$(wait_for 15 questions commands); [ -n "$q" ] && ct ship answer "$q" "Run them" >/dev/null 2>&1; }

# --- 1. everyday -----------------------------------------------------------------------------
echo
echo "an everyday feature"
F1=$(ship s-guide "$TMP/code/wt-guide" '"action":"feature","name":"user guide"')
check "$(field "$F1" 'r.risk')" "everyday" "declared everyday"
R1=$(ship s-guide "$TMP/code/wt-guide" '"action":"ready","feature":"user guide"')
has "$R1" "review (claude)" "ready starts one claude reviewer"
has "$(tmux -L crosstalk ls 2>/dev/null || cat "$TMP/calls" 2>/dev/null)" "review" "it runs in crosstalk's background tmux"
# The repo's own commands (check.sh) run only once a person has said yes, once for the repo.
CQ=$(wait_for 15 questions commands)
[ -n "$CQ" ] && pass "running the repo's commands is a question first" || fail "running the repo's commands is a question first"
has "$(field "$(rpc '{"op":"ship","action":"questions"}')" "r.questions.find(q => q.kind === 'commands')?.text")" "test: sh check.sh" "naming the commands"
check "$(state_of "user guide")" "approved" "signed off, and nothing run yet"
[ -f "$TMP/check-env" ] && fail "check.sh did not run before the yes" || pass "check.sh did not run before the yes"
CAG=$(CLAUDECODE=1 ct ship answer "$CQ" "Run them" 2>&1)
has "$CAG" "for a person" "an agent cannot allow them"
ct ship answer "$CQ" "Run them" >/dev/null 2>&1
check "$(until_state "user guide" merged)" "merged" "approved, green, merged by itself"
hasnt "$(cat "$TMP/check-env" 2>/dev/null)" "UNLEASH_ADMIN_TOKEN" "the repo's test command does not see the provider's admin token"
hasnt "$(cat "$TMP/check-env" 2>/dev/null)" "GROWTHBOOK_API_KEY" "nor any other provider's key"
hasnt "$(cat "$TMP/reviewer-env" 2>/dev/null)" "UNLEASH_ADMIN_TOKEN" "and neither does a reviewer"
[ -s "$TMP/check-env" ] && [ -s "$TMP/reviewer-env" ] && pass "(both ran)" || fail "(both ran)"
check "$(git -C "$TMP/remote.git" rev-parse main)" "$(g "$APP" rev-parse crosstalk/guide)" "fast-forwarded and pushed to the remote"
has "$(cat "$TMP/calls")" "claude|review|$CROSSTALK_HOME/shipping/reviews/" "the reviewer ran in its own copy of the branch"
T1=$(rpc '{"op":"thread_read","sessionId":"s-guide"}')
has "$(field "$T1" 'r.threads[0].decisions.map(d => d.text).join(";")')" "Reviewers signed off on user guide: review by claude" "sign-off recorded in the thread"
has "$(field "$T1" 'r.threads[0].facts.map(d => d.text).join(";")')" "Checks pass on crosstalk/guide (sh check.sh)" "the repo's test command ran"
check "$(field "$T1" 'r.threads[0].status')" "done" "the thread is done once its feature is in"
check "$(ls "$CROSSTALK_HOME/shipping/reviews/"*/copy 2>/dev/null | wc -l | tr -d ' ')" "0" "the reviewer's copy is gone"
has "$(told s-guide)" "user guide merged into main" "the author is told"
# A verdict comes only from the reviewer: the author can read the run id from
# `git worktree list`, and still cannot approve its own work with it.
g "$APP" worktree add -q -b crosstalk/sneak "$TMP/code/wt-sneak"
echo "sneaky" >"$TMP/code/wt-sneak/sneak.txt"; g "$TMP/code/wt-sneak" add -A; g "$TMP/code/wt-sneak" commit -qm sneak
reg s-sneak "$TMP/code/wt-sneak"; sleep 0.3
touch "$TMP/hang"
ship s-sneak "$TMP/code/wt-sneak" '"action":"feature","name":"sneak"' >/dev/null
ship s-sneak "$TMP/code/wt-sneak" '"action":"ready","feature":"sneak"' >/dev/null
run_of() { git -C "$TMP/code/wt-sneak" worktree list | grep -o 'reviews/r[0-9a-f]*' | head -1 | cut -d/ -f2; }
RUN=$(wait_for 10 run_of)
SA=$(ship s-sneak "$TMP/code/wt-sneak" "\"action\":\"review\",\"run\":\"$RUN\",\"verdict\":\"approve\",\"findings\":\"none\"")
has "$(field "$SA" 'r.text')" "only the reviewer crosstalk started" "the author's own approval, by run id, is refused"
SO=$(ct review --run "$RUN" --output "$CROSSTALK_HOME/shipping.json" 2>&1)
has "$SO" "only the reviewer crosstalk started" "and so is a wrapper's call without the run's secret"
check "$(state_of sneak)" "reviewing" "it is still with its reviewer"
rm -f "$TMP/hang"
check "$(until_state sneak merged)" "merged" "the reviewer's own wrapper hands its verdict in, with the run's secret"

# --- 2. risky ---------------------------------------------------------------------------------
echo
echo "a risky feature"
F2=$(ship s-login "$TMP/code/wt-login" '"action":"feature","name":"login v2"')
check "$(field "$F2" 'r.risk')" "risky" "risky because it touches src/auth/**"
check "$(field "$F2" 'r.flag')" "login-v2" "and given a flag"
R2=$(ship s-login "$TMP/code/wt-login" '"action":"ready","feature":"login v2"')
has "$R2" "adversarial (codex)" "an adversarial reviewer on codex"
has "$R2" "security (claude)" "and a security pass"
check "$(until_state "login v2" changes)" "changes" "codex asked for changes"
has "$(told s-login)" "login accepts empty passwords" "the findings reached the author as a message"
ship s-login "$TMP/code/wt-login" '"action":"ready","feature":"login v2","response":"empty passwords are rejected now"' >/dev/null
check "$(until_state "login v2" needs-evidence)" "needs-evidence" "round 2 signs off; evidence is needed before a merge"
has "$(cat "$TMP/calls")" "codex-saw-round1:yes" "the round-2 reviewer saw round 1's findings"
has "$(told s-login)" 'crosstalk_ship action \"evidence\"' "the author is asked for evidence"
BAD=$(ship s-login "$TMP/code/wt-login" '"action":"evidence","feature":"login v2","summary":"diff --git a/x b/x\n@@ -1 +1 @@\n-a\n+b"')
has "$BAD" "reads as a diff" "a diff is refused as evidence"
EV=$(ship s-login "$TMP/code/wt-login" '"action":"evidence","feature":"login v2","summary":"Login rejects empty passwords and still accepts good ones.","tests":["login.test: 6 pass"]')
Q=$(field "$EV" 'r.question')
[ -n "$Q" ] && [ "$Q" != "null" ] && pass "the merge is a question" || fail "the merge is a question ($EV)"
has "$(field "$(rpc '{"op":"ui","sessionId":"s-login"}')" "r.items.find(i => i.kind === 'ship')?.question")" "Login rejects empty passwords" "the picker shows the evidence"
check "$(g "$APP" merge-base --is-ancestor crosstalk/login main && echo in || echo out)" "out" "not merged before the answer"
AG=$(rpc "{\"op\":\"thread\",\"sessionId\":\"s-login\",\"cwd\":\"$TMP/code/wt-login\",\"answer\":{\"id\":\"$Q\",\"text\":\"Merge it\"}}")
has "$AG" "a person answers it" "an agent's crosstalk_thread answer is refused"
AC=$(CLAUDECODE=1 ct ship answer "$Q" "Merge it" 2>&1)
has "$AC" "for a person" "so is the command run from inside an agent"
YES=$(ct ship answer "$Q" "Merge it" 2>&1)
has "$YES" "merged into main" "a person's yes merges it"
has "$(g "$TMP/remote.git" show main:src/auth/login.ts)" "check(p)" "rebased onto the main the guide moved, and pushed"
check "$(g "$APP" rev-parse crosstalk/login)" "$(g "$TMP/code/wt-login" rev-parse HEAD)" "the author's branch itself was not rewritten"
has "$(flags_on_remote)" "login-v2: off" "its flag is in .crosstalk/flags, off"
RQ=$(wait_for 5 questions ramp)
[ -n "$RQ" ] && pass "the first flag step is a question" || fail "the first flag step is a question"
has "$(field "$(rpc '{"op":"ship","action":"questions"}')" "r.questions.find(q => q.kind === 'ramp')?.text")" "up from off to internal" "with the merge evidence"
has "$(ct ship answer "$RQ" "Turn it up to internal" 2>&1)" "internal" "yes turns it up"
has "$(flags_on_remote)" "login-v2: internal" ".crosstalk/flags says internal, committed and pushed"
check "$(questions ramp)" "" "the next step waits for evidence at internal"
ship s-login "$TMP/code/wt-login" '"action":"evidence","feature":"login v2","stage":"internal","summary":"Internal accounts logged in 30 times with no errors.","evals":["login error rate 0%"]' >/dev/null
ITEM=$(wait_for 5 ship_items s-login)
[ -n "$ITEM" ] && pass "evidence at internal brings the next step's picker" || fail "evidence at internal brings the next step's picker"
UAG=$(CLAUDECODE=1 ct ui act --session s-login --id "$ITEM" --action answer --value "Turn it up to 10%" 2>&1)
has "$UAG" "for a person" "an agent's shell cannot press the picker (ui act) for a person"
hasnt "$(flags_on_remote)" "login-v2: 10%" "and the flag did not move"
UA=$(ct ui act --session s-login --id "$ITEM" --action answer --value "Turn it up to 10%" 2>&1)
has "$UA" "10%" "answered through the mod's picker path"
has "$(flags_on_remote)" "login-v2: 10%" "now at 10%"
UP=$(ship s-login "$TMP/code/wt-login" '"action":"flag","flag":"login-v2","stage":"on"')
hasnt "$(flags_on_remote)" "login-v2: on" "an agent cannot turn a risky flag up by itself"

# --- 3. incidents ----------------------------------------------------------------------------
echo
echo "production"
INC=$(ct incident --source sentry --title "500s on login" --details "TypeError in login.ts" --flag login-v2 2>&1)
has "$INC" "turned login-v2 off at once" "an incident with the flag turns it off"
has "$INC" "reopened" "and reopens the thread that shipped it"
has "$(flags_on_remote)" "login-v2: off" "off in .crosstalk/flags"
T2=$(rpc '{"op":"thread_read","sessionId":"s-login"}')
check "$(field "$T2" 'r.threads[0].status')" "active" "the thread is active again"
has "$(field "$T2" 'r.threads[0].tasks.map(t => t.text).join(";")')" "500s on login" "with a task to find the cause"
has "$(told s-login)" "crosstalk-incident" "its agent is told, as data"
UNC=$(ct incident --source pagerduty --title "disk full on db-3" --files "infra/disk.sh" 2>&1)
has "$UNC" "started incident-disk-full" "an unclear incident starts its own thread"

# --- 4. lowering ------------------------------------------------------------------------------
echo
echo "lowering risk"
LO=$(ship s-login "$TMP/code/wt-login" '"action":"feature","name":"login v2","risk":"everyday","why":"small"')
has "$(field "$LO" 'r.text')" "question for a person" "making it everyday is a question"
check "$(field "$(rpc '{"op":"ship","action":"status"}')" "r.threads.flatMap(t => t.features).find(f => f.name === 'login v2').risk")" "risky" "and it stays risky meanwhile"
LT=$(rpc "{\"op\":\"thread\",\"sessionId\":\"s-login\",\"cwd\":\"$TMP/code/wt-login\",\"feature\":{\"name\":\"login v2\",\"risk\":\"everyday\"}}")
has "$LT" "question for a person" "crosstalk_thread cannot lower it either"
risk_now() { field "$(rpc '{"op":"ship","action":"status"}')" "r.threads.flatMap(t => t.features).find(f => f.name.toLowerCase() === 'login v2')?.risk"; }
LC=$(rpc "{\"op\":\"thread\",\"sessionId\":\"s-login\",\"cwd\":\"$TMP/code/wt-login\",\"feature\":{\"name\":\"Login V2\",\"risk\":\"everyday\"}}")
has "$LC" "question for a person" "nor by another spelling of its name"
rpc "{\"op\":\"thread\",\"sessionId\":\"s-login\",\"cwd\":\"$TMP/code/wt-login\",\"feature\":{\"name\":\"login v2\",\"flag\":\"login-v2\"}}" >/dev/null
check "$(risk_now)" "risky" "an edit that leaves risk out keeps it risky"
rpc "{\"op\":\"thread\",\"sessionId\":\"s-login\",\"cwd\":\"$TMP/code/wt-login\",\"feature\":{\"name\":\"login v2\",\"remove\":true}}" >/dev/null
rpc "{\"op\":\"thread\",\"sessionId\":\"s-login\",\"cwd\":\"$TMP/code/wt-login\",\"feature\":{\"name\":\"login v2\",\"flag\":\"login-v2\"}}" >/dev/null
check "$(risk_now)" "risky" "removed and added again, it is still risky"
ship s-login "$TMP/code/wt-login" '"action":"flag","flag":"login-v2","stage":"on"' >/dev/null
hasnt "$(flags_on_remote)" "login-v2: on" "and its flag still goes up only on a person's yes"

# --- 5. preview per thread ----------------------------------------------------------------------
echo
echo "a preview per thread"
reg s-pay "$TMP/code/wt-pay"
reg s-banner "$TMP/code/wt-banner"
reg s-gb "$TMP/code/wt-gb"
reg s-ul "$TMP/code/wt-ul"
reg s-ss "$TMP/code/wt-ss"
sleep 0.5
shop_flags() { git -C "$SHOP" show main:.crosstalk/flags 2>/dev/null; }
feat() { field "$(rpc '{"op":"ship","action":"status"}')" "r.threads.flatMap(t => t.features).find(f => f.name === '$1')$2"; }
F5=$(ship s-pay "$TMP/code/wt-pay" '"action":"feature","name":"pay v2"')
check "$(field "$F5" 'r.flag')" "pay-v2" "pay v2 is risky, behind pay-v2"
ship s-pay "$TMP/code/wt-pay" '"action":"ready","feature":"pay v2"' >/dev/null
allow_cmds
check "$(until_state "pay v2" needs-evidence)" "needs-evidence" "signed off, green, and previewed"
check "$(cat "$TMP/preview-env" 2>/dev/null)" "CROSSTALK_FLAGS=pay-v2=on" "the preview ran with its flag forced on"
check "$(feat "pay v2" '.preview?.url')" "https://shop-crosstalk-pay.preview.test" "the URL it printed is captured"
check "$(cat "$TMP/preview-checked" 2>/dev/null)" "https://shop-crosstalk-pay.preview.test" "the check ran against PREVIEW_URL"
has "$(feat "pay v2" '.evidence.join(";")')" "preview: A preview of pay v2 is up at https://shop-crosstalk-pay.preview.test" "and the result is evidence"
EV5=$(ship s-pay "$TMP/code/wt-pay" '"action":"evidence","feature":"pay v2","summary":"Charges retry once on a timeout.","tests":["charge.test: 5 pass"]')
Q5=$(field "$EV5" 'r.question')
has "$(field "$(rpc '{"op":"ship","action":"questions"}')" "r.questions.find(q => q.id === '$Q5')?.text")" "checkout e2e: 7 passed" "the merge question shows the preview's check"
has "$(ct ship answer "$Q5" "Merge it" 2>&1)" "merged into main" "a person merges it"
check "$(cat "$TMP/preview-down" 2>/dev/null)" "https://shop-crosstalk-pay.preview.test" "merged, the preview is taken down"

# --- 6. dark launch -----------------------------------------------------------------------------
echo
echo "a dark launch"
RQ6=$(wait_for 5 questions ramp)
has "$(field "$(rpc '{"op":"ship","action":"questions"}')" "r.questions.find(q => q.kind === 'ramp')?.text")" "up from off to dark" "the first flag step is dark"
has "$(ct ship answer "$RQ6" yes 2>&1)" "dark" "yes takes it dark"
has "$(shop_flags)" "pay-v2: dark" ".crosstalk/flags says dark"
SH1=$(ct incident --source shadow --flag pay-v2 --title "amount differs" --details "calls=400 mismatches=1" 2>&1)
has "$SH1" "1 mismatch in 400 calls" "a shadow mismatch is counted"
hasnt "$SH1" "turned pay-v2 off" "and is no kill"
ct incident --source shadow --flag pay-v2 --title "amount differs" --details "calls=400 mismatches=2" >/dev/null 2>&1
has "$(shop_flags)" "pay-v2: dark" "still dark"
check "$(questions ramp)" "" "no next step before the dwell"
later 120
W6=$(ct ship watch 2>&1)
RQ7=$(questions ramp)
[ -n "$RQ7" ] && pass "after the dwell the step to internal is asked" || fail "after the dwell the step to internal is asked ($W6)"
Q7T=$(field "$(rpc '{"op":"ship","action":"questions"}')" "r.questions.find(q => q.kind === 'ramp')?.text")
has "$Q7T" "up from dark to internal" "from dark to internal"
has "$Q7T" "shadow_mismatches 2" "with the mismatches as evidence"
has "$Q7T" "shadow_mismatch_rate 0.005" "and their rate"

# --- 7. a regression turns it off ---------------------------------------------------------------
echo
echo "a regression"
has "$(ct ship answer "$RQ7" yes 2>&1)" "internal" "internal, on a person's yes"
has "$(shop_flags)" "pay-v2: internal" ".crosstalk/flags says internal"
has "$(feat "pay v2" '.watching?.stage')" "internal" "and its metrics are watched"
rpc '{"op":"thread_read","sessionId":"s-pay"}' >/dev/null
echo '{"errors": 9, "latency_p95": 110}' >"$TMP/metrics-pay-v2.json"
later 125
W7=$(ct ship watch 2>&1)
has "$W7" "errors went from 2 to 9" "errors went up past the threshold"
has "$(shop_flags)" "pay-v2: off" "so the flag is off"
T7=$(rpc '{"op":"thread_read","sessionId":"s-pay"}')
check "$(field "$T7" 'r.threads[0].status')" "active" "the thread is reopened"
has "$(field "$T7" 'r.threads[0].tasks.map(t => t.text).join(";")')" "regressed at internal" "with a task to find out why"
has "$(field "$T7" 'r.threads[0].facts.map(t => t.text).join(";")')" "crosstalk turned pay-v2 off" "and the fact recorded for everyone"
has "$(told s-pay)" "crosstalk-metrics" "its agent is told, as data"

# --- 8. everyday auto-ramp -------------------------------------------------------------------------
echo
echo "an everyday flag ramps itself"
ship s-banner "$TMP/code/wt-banner" '"action":"feature","name":"sale banner","flag":"banner"' >/dev/null
ship s-banner "$TMP/code/wt-banner" '"action":"ready","feature":"sale banner"' >/dev/null
check "$(until_state "sale banner" merged)" "merged" "merged by itself"
banner_internal() { shop_flags | grep -o "banner: internal"; }
check "$(wait_for 10 banner_internal)" "banner: internal" "its flag goes internal by itself"
later 170
ct ship watch >/dev/null 2>&1
has "$(shop_flags)" "banner: internal" "not before the dwell"
later 200
W8=$(ct ship watch 2>&1)
has "$W8" "banner internal → on" "once its metrics have held for an hour"
has "$(shop_flags)" "banner: on" "it is on for everyone"
check "$(state_of "sale banner")" "shipped" "and shipped"

# --- 9. Unleash, GrowthBook and Statsig --------------------------------------------------------------
echo
echo "Unleash, GrowthBook and Statsig"
mock() { curl -s "$MOCK/__state"; }
ulp() { field "$(mock)" "(() => { const e = r.unleash.features['ul-pricing']?.environments.find(e => e.name === 'production'); return e ? e.enabled + ' ' + e.strategies.map(s => s.title + ':' + s.parameters.rollout + ':' + (s.constraints ?? []).map(c => c.contextName + ' ' + c.operator + ' ' + c.values).join()).join(',') : 'none' })()"; }
ship s-ul "$TMP/code/wt-ul" '"action":"feature","name":"ul pricing","flag":"ul-pricing"' >/dev/null
ship s-ul "$TMP/code/wt-ul" '"action":"ready","feature":"ul pricing"' >/dev/null
allow_cmds
check "$(until_state "ul pricing" merged)" "merged" "an Unleash repo's feature merges"
ul_internal() { case "$(ulp)" in true*internal*) ulp ;; esac; }
check "$(wait_for 10 ul_internal)" "true crosstalk: internal:100:email STR_ENDS_WITH @shop.test" "its toggle is created and internal is a flexibleRollout on the constraint"
ship s-ul "$TMP/code/wt-ul" '"action":"flag","flag":"ul-pricing","stage":"30%"' >/dev/null
check "$(ulp)" "true crosstalk: internal:100:email STR_ENDS_WITH @shop.test,crosstalk: 30% of everyone:30:" "N% adds a flexibleRollout at N"
ship s-ul "$TMP/code/wt-ul" '"action":"flag","flag":"ul-pricing","stage":"on"' >/dev/null
check "$(ulp)" "true crosstalk: everyone:100:" "on is the default strategy for everyone"
ship s-ul "$TMP/code/wt-ul" '"action":"flag","flag":"ul-pricing","stage":"off"' >/dev/null
check "$(ulp)" "false crosstalk: everyone:100:" "off disables the environment: the instant kill"
ship s-gb "$TMP/code/wt-gb" '"action":"feature","name":"gb search","flag":"gb-search"' >/dev/null
ship s-gb "$TMP/code/wt-gb" '"action":"ready","feature":"gb search"' >/dev/null
allow_cmds
check "$(until_state "gb search" merged)" "merged" "a GrowthBook repo's feature merges"
check "$(field "$(mock)" "r.features['gb-search'].environments.production.rules.map(x => x.description + ' ' + x.condition).join()")" 'crosstalk: internal {"email":{"$regex":"@shop\\.test$"}}' "its feature is created and internal is the email domain"
ship s-gb "$TMP/code/wt-gb" '"action":"flag","flag":"gb-search","stage":"on"' >/dev/null
check "$(field "$(mock)" "r.features['gb-search'].environments.production.rules.map(x => x.type + ':' + x.value + ':' + (x.condition ?? '')).join()")" "force:true:" "on is a force rule for everyone"
ship s-gb "$TMP/code/wt-gb" '"action":"flag","flag":"gb-search","stage":"off"' >/dev/null
check "$(field "$(mock)" "r.features['gb-search'].environments.production.enabled")" "false" "off disables it"
ship s-ss "$TMP/code/wt-ss" '"action":"feature","name":"ss nav","flag":"ss-nav"' >/dev/null
ship s-ss "$TMP/code/wt-ss" '"action":"ready","feature":"ss nav"' >/dev/null
allow_cmds
check "$(until_state "ss nav" merged)" "merged" "a Statsig repo's feature merges"
check "$(field "$(mock)" "r.gates['ss-nav'].isEnabled + ' ' + r.gates['ss-nav'].rules.map(x => x.name + ':' + x.conditions[0].type + ':' + x.passPercentage).join()")" "true crosstalk: internal:passes_segment:100" "its gate is created and internal is the segment"
ship s-ss "$TMP/code/wt-ss" '"action":"flag","flag":"ss-nav","stage":"on"' >/dev/null
check "$(field "$(mock)" "r.gates['ss-nav'].rules.map(x => x.conditions[0].type + ':' + x.passPercentage).join()")" "public:100" "on passes everyone"
INC9=$(ct incident --source sentry --title "nav broken" --flag ss-nav 2>&1)
check "$(field "$(mock)" "r.gates['ss-nav'].isEnabled")" "true" "an everyday flag is not killed by an incident (only a risky one is)"
ship s-ss "$TMP/code/wt-ss" '"action":"flag","flag":"ss-nav","stage":"off"' >/dev/null
check "$(field "$(mock)" "r.gates['ss-nav'].isEnabled")" "false" "off disables the gate"

echo
if [ "$FAILED" = 0 ]; then echo "shipping: all $PASSES passed"; else echo "shipping: FAILED ($PASSES passed)"; tail -30 "$TMP/daemon.log"; fi
exit $FAILED
