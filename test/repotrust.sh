#!/usr/bin/env bash
# Trust through repository access, with no words, end to end.
#
#   bash test/repotrust.sh
#
# Three crosstalk identities on one machine: ana, ben, and ana's second
# machine. A bare git repository plays GitHub's repo, a stub HTTP server plays
# github.com/<login>.keys, and a local relay carries the messages. Nobody joins
# a room. Each daemon publishes a statement signed with an ed25519 key made by
# ssh-keygen, verifies the others, and they message each other. Then ben's
# crosstalk key rotates, which must be a question and not accepted, and then
# his SSH key is removed from "GitHub", which must revoke him.

set -u
export CROSSTALK_NO_GATHER=1 CROSSTALK_NO_RESTORE=1
cd "$(dirname "$0")/.."
ROOT=$(pwd)
PORT=${PORT:-8893}
TMP=$(mktemp -d)
A="$TMP/a"; B="$TMP/b"; A2="$TMP/a2"; KEYS="$TMP/keys"; SSH="$TMP/ssh"; R="$TMP/repos"
FAILED=0
PASSES=0

pass() { echo "  PASS  $1"; PASSES=$((PASSES+1)); }
fail() { echo "  FAIL  $1"; FAILED=1; }
check() { if [ "$1" = "$2" ]; then pass "$3"; else fail "$3 (wanted '$2', got '$1')"; fi; }
has() { case "$1" in *"$2"*) pass "$3" ;; *) fail "$3"; echo "        got: $1" | head -c 900; echo ;; esac; }
hasnt() { case "$1" in *"$2"*) fail "$3"; echo "        got: $1" | head -c 900; echo ;; *) pass "$3" ;; esac; }

if ! command -v ssh-keygen >/dev/null; then
  echo "  SKIP  ssh-keygen is not installed; trust through the repo needs it"
  exit 0
fi

stop_daemon() {
  if [ -f "$1/daemon.lock" ]; then
    P=$(cat "$1/daemon.lock")
    kill "$P" 2>/dev/null
    for _ in $(seq 1 30); do kill -0 "$P" 2>/dev/null || break; sleep 0.2; done
    kill -0 "$P" 2>/dev/null && kill -9 "$P" 2>/dev/null
  fi
  rm -f "$1/daemon.sock" "$1/daemon.lock"
}
rpc() { CROSSTALK_HOME="$1" bun -e '
  const { request } = await import("./src/client.ts")
  console.log(JSON.stringify(await request(JSON.parse(process.argv[1]), 60000)))
' "$2" 2>&1; }
RELAY_PID=""; STUB_PID=""
cleanup() {
  stop_daemon "$A"; stop_daemon "$B"; stop_daemon "$A2"
  [ -n "$RELAY_PID" ] && kill "$RELAY_PID" 2>/dev/null
  [ -n "$STUB_PID" ] && kill "$STUB_PID" 2>/dev/null
  rm -rf "$TMP"
}
trap cleanup EXIT

mkdir -p "$TMP/relay" "$A" "$B" "$A2" "$KEYS" "$SSH" "$R"
echo "state in $TMP"

# --- GitHub, played by a bare repo and a key server ------------------------------
git init -q --bare "$R/remote.git"
for who in ana ben; do
  ssh-keygen -q -t ed25519 -N '' -C "$who@test" -f "$SSH/$who"
  cp "$SSH/$who.pub" "$KEYS/$who.keys"
done
for c in ca cb ca2; do git clone -q "$R/remote.git" "$R/$c" 2>/dev/null; done

STUB_PORT=$((PORT+1))
(exec bun -e '
  const [dir, port] = process.argv.slice(1)
  const fs = require("fs")
  Bun.serve({ port: Number(port), hostname: "127.0.0.1", fetch(req) {
    const m = new URL(req.url).pathname.match(/^\/([a-z0-9-]+)\.keys$/)
    if (!m) return new Response("nope", { status: 404 })
    let body = ""
    try { body = fs.readFileSync(`${dir}/${m[1]}.keys`, "utf8") } catch { return new Response("Not Found", { status: 404 }) }
    const etag = `"${Bun.hash(body)}"`
    if (req.headers.get("if-none-match") === etag) return new Response(null, { status: 304, headers: { etag } })
    return new Response(body, { headers: { etag } })
  } })
' "$KEYS" "$STUB_PORT" >"$TMP/stub.log" 2>&1) &
STUB_PID=$!

(cd "$TMP/relay" && exec bun "$ROOT/relay/relay.ts" --host 127.0.0.1 --port "$PORT" >"$TMP/relay.log" 2>&1) &
RELAY_PID=$!
for _ in $(seq 1 30); do curl -sf -m 1 "http://127.0.0.1:$PORT/health" >/dev/null && break; sleep 0.3; done
for _ in $(seq 1 30); do curl -sf -m 1 "http://127.0.0.1:$STUB_PORT/ana.keys" >/dev/null && break; sleep 0.3; done
has "$(curl -s "http://127.0.0.1:$STUB_PORT/ana.keys")" "ssh-ed25519" "the key server serves ana's key"

# --- three identities, no rooms ----------------------------------------------------
identity() { CROSSTALK_HOME="$1" bun -e '
  const { newIdentity } = await import("./src/crypto.ts")
  const { saveIdentity, saveRelay } = await import("./src/config.ts")
  saveIdentity({ ...newIdentity(process.argv[1]), machine: process.argv[2] })
  saveRelay(process.argv[3])
' "$2" "$3" "ws://127.0.0.1:$PORT"; }
identity "$A" ana desk
identity "$B" ben desk
identity "$A2" ana laptop
fp() { bun -e 'const {fingerprint}=await import("./src/crypto.ts");const fs=require("fs");console.log(fingerprint(JSON.parse(fs.readFileSync(process.argv[1]+"/identity.json","utf8")).ed.pub))' "$1"; }
FA=$(fp "$A"); FB=$(fp "$B"); FA2=$(fp "$A2")

start() { # home login machine key
  (unset SSH_AUTH_SOCK; CROSSTALK_HOME="$1" CROSSTALK_GITHUB_URL="http://127.0.0.1:$STUB_PORT" \
    CROSSTALK_GITHUB_LOGIN="$2" CROSSTALK_MACHINE="$3" CROSSTALK_SSH_KEY="$4" \
    CROSSTALK_REPOTRUST_ANY_REMOTE=1 CROSSTALK_REPOTRUST_AUTO=1 CROSSTALK_KEYS_MIN_MS=0 CROSSTALK_REPOTRUST_MIN_MS=0 \
    exec nohup bun src/daemon.ts >>"$1/daemon.log" 2>&1) &
  for _ in $(seq 1 40); do [ -S "$1/daemon.sock" ] && break; sleep 0.2; done
}
start "$A" ana desk "$SSH/ana"
start "$B" ben desk "$SSH/ben"
start "$A2" ana laptop "$SSH/ana"
sleep 2

echo
echo "publishing and verifying, with no words"
rpc "$A"  "{\"op\":\"register\",\"sessionId\":\"sa\",\"pid\":1,\"name\":\"ana-web\",\"cwd\":\"$R/ca\",\"socket\":\"\"}" >/dev/null
rpc "$B"  "{\"op\":\"register\",\"sessionId\":\"sb\",\"pid\":2,\"name\":\"ben-api\",\"cwd\":\"$R/cb\",\"socket\":\"\"}" >/dev/null
rpc "$A2" "{\"op\":\"register\",\"sessionId\":\"sa2\",\"pid\":3,\"name\":\"ana-laptop\",\"cwd\":\"$R/ca2\",\"socket\":\"\"}" >/dev/null
team() { rpc "$1" "{\"op\":\"team\",\"cwd\":\"$2\",\"refresh\":true}"; }
# Two rounds: whoever published first saw nobody else yet.
for _ in 1 2; do team "$A" "$R/ca" >/dev/null; team "$B" "$R/cb" >/dev/null; team "$A2" "$R/ca2" >/dev/null; done

REFS=$(git -C "$R/remote.git" for-each-ref --format='%(refname)' refs/crosstalk/)
has "$REFS" "refs/crosstalk/keys/ana/desk" "ana's statement is on the repo's ref"
has "$REFS" "refs/crosstalk/keys/ben/desk" "ben's statement is on the repo's ref"
has "$REFS" "refs/crosstalk/keys/ana/laptop" "ana's laptop is on the ref too"
check "$(git -C "$R/remote.git" for-each-ref refs/heads | wc -l | tr -d ' ')" "0" "no branch was created on the remote"
check "$(git -C "$R/ca" status --porcelain | wc -l | tr -d ' ')" "0" "ana's working tree is untouched"
has "$(git -C "$R/ca" config --get-all remote.origin.fetch)" "+refs/crosstalk/keys/*:refs/crosstalk/remote/keys/*" "the refspec was added quietly"
has "$(git -C "$R/remote.git" cat-file blob refs/crosstalk/keys/ben/desk:statement.sig)" "BEGIN SSH SIGNATURE" "the statement carries an SSH signature"

TA=$(team "$A" "$R/ca")
has "$TA" "\"who\":\"ben\"" "ana trusts ben through the repo"
has "$TA" "$FB" "with ben's fingerprint"
has "$TA" "\"who\":\"ana-laptop\"" "ana's laptop is hers"
has "$TA" "\"yours\":true" "and marked as her own machine"
has "$TA" "published as ana on desk" "ana says what became of her own statement"
TB=$(team "$B" "$R/cb")
has "$TB" "\"who\":\"ana\"" "ben trusts ana through the repo"
has "$TB" "\"who\":\"ana-laptop\"" "and ana's laptop, as a second machine of hers"
has "$(cat "$A/peers.json")" "\"via\": \"repo\"" "the peer is recorded as trusted via the repo"

echo
echo "messages, over the relay, with no room joined"
check "$(test -f "$A/rooms.json" && echo yes || echo no)" "no" "no room exists on ana's side"
SENT=$(rpc "$B" '{"op":"send","sessionId":"sb","to":"ana","text":"hello through the repo","intent":"fyi"}')
has "$SENT" '"ok":true' "ben sent ana a message"
GOT=""
for _ in $(seq 1 20); do GOT=$(rpc "$A" '{"op":"read","sessionId":"sa","all":true}'); case "$GOT" in *"hello through the repo"*) break ;; esac; sleep 0.5; done
has "$GOT" "hello through the repo" "ana received it"
GOT2=""
for _ in $(seq 1 20); do GOT2=$(rpc "$A2" '{"op":"read","sessionId":"sa2","all":true}'); case "$GOT2" in *"hello through the repo"*) break ;; esac; sleep 0.5; done
has "$GOT2" "hello through the repo" "and so did her laptop: a message to ana reaches whichever machine she is at"
BACK=$(rpc "$A" '{"op":"send","sessionId":"sa","to":"ben","text":"got it","intent":"fyi"}')
has "$BACK" '"ok":true' "ana answered"
for _ in $(seq 1 20); do GOTB=$(rpc "$B" '{"op":"read","sessionId":"sb","all":true}'); case "$GOTB" in *"got it"*) break ;; esac; sleep 0.5; done
has "$GOTB" "got it" "ben received it"

echo
echo "ben's crosstalk key changes: a question, not accepted"
stop_daemon "$B"
mv "$B/identity.json" "$TMP/ben-old-identity.json"
identity "$B" ben desk
FB2=$(fp "$B")
start "$B" ben desk "$SSH/ben"
rpc "$B" "{\"op\":\"register\",\"sessionId\":\"sb\",\"pid\":2,\"name\":\"ben-api\",\"cwd\":\"$R/cb\",\"socket\":\"\"}" >/dev/null
team "$B" "$R/cb" >/dev/null
TA=$(team "$A" "$R/ca")
has "$TA" "\"pending\":[{" "ana has a question waiting"
has "$TA" "ben's crosstalk key on desk changed" "it says ben's key changed, in plain words"
has "$TA" "$FB2" "naming the new fingerprint"
check "$(bun -e 'console.log(JSON.parse(require("fs").readFileSync(process.argv[1],"utf8")).ben.fingerprint)' "$A/peers.json")" "$FB" "ben's old key is still the trusted one"
SAY=$(rpc "$A" "{\"op\":\"register\",\"sessionId\":\"sa\",\"pid\":1,\"name\":\"ana-web\",\"cwd\":\"$R/ca\",\"socket\":\"\"}")
has "$SAY" "systemMessage" "without the mod, the question reaches ana as a systemMessage"
SAY2=$(rpc "$A" "{\"op\":\"register\",\"sessionId\":\"sa\",\"pid\":1,\"name\":\"ana-web\",\"cwd\":\"$R/ca\",\"socket\":\"\"}")
hasnt "$SAY2" "systemMessage" "once, not every turn"
UI=$(rpc "$A" '{"op":"ui","sessionId":"sa"}')
has "$UI" '"kind":"team"' "with the mod, it is a picker item"
has "$UI" "Trust it" "offering to trust it"
rpc "$B" '{"op":"send","sessionId":"sb","to":"ana","text":"from the new key","intent":"fyi"}' >/dev/null
sleep 2
hasnt "$(rpc "$A" '{"op":"read","sessionId":"sa","all":true}')" "from the new key" "a message from the new key is not accepted meanwhile"

ANS=$(rpc "$A" '{"op":"team_answer","id":"ben","trust":true}')
has "$ANS" "trusted now" "ana says yes"
check "$(bun -e 'console.log(JSON.parse(require("fs").readFileSync(process.argv[1],"utf8")).ben.fingerprint)' "$A/peers.json")" "$FB2" "ben's new key is the trusted one"
has "$(rpc "$A" '{"op":"ui","sessionId":"sa"}')" '"items":[]' "the picker item is settled"
rpc "$B" '{"op":"send","sessionId":"sb","to":"ana","text":"new key, accepted","intent":"fyi"}' >/dev/null
for _ in $(seq 1 20); do GOT=$(rpc "$A" '{"op":"read","sessionId":"sa","all":true}'); case "$GOT" in *"new key, accepted"*) break ;; esac; sleep 0.5; done
has "$GOT" "new key, accepted" "and his messages arrive again"

echo
echo "ben's SSH key is removed from GitHub: revoked"
: >"$KEYS/ben.keys"
TA=$(team "$A" "$R/ca")
hasnt "$TA" "\"who\":\"ben\"" "ana no longer trusts ben"
has "$TA" "ben on desk is no longer trusted" "and says why"
hasnt "$(cat "$A/peers.json")" "$FB2" "ben is gone from ana's peers"

echo
echo "a statement removed from the ref: revoked"
git -C "$R/remote.git" update-ref -d refs/crosstalk/keys/ana/laptop
TB=$(team "$B" "$R/cb")
hasnt "$TB" "\"who\":\"ana-laptop\"" "ben no longer trusts ana's laptop"
has "$TB" "\"who\":\"ana\"" "but still trusts ana's desk"

echo
[ $FAILED -eq 0 ] && echo "repotrust: all $PASSES passed" || { echo "repotrust: failures above"; echo "--- ana's daemon log"; tail -30 "$A/daemon.log"; echo "--- ben's daemon log"; tail -30 "$B/daemon.log"; }
exit $FAILED
