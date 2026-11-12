#!/bin/bash
# The same plugin with no mod: every surface has to fall back to the classic hooks.
#
#   test/canary/drive-nomod.sh <run-dir> <tmux-session>
#
# The session loads a copy of the plugin whose hooks/hooks.json has no
# "modules" key: exactly what a Claude Code without mods (older, -p, the SDK,
# or mods switched off) runs, the classic hooks alone. (allowManagedModsOnly
# would do the same, but it counts only in machine-wide managed settings,
# /etc/claude-code/managed-settings.json, which a test should not write.)
# Checks: the restore offer is the SessionStart systemMessage, no picker comes
# up, "restore them" reopens the sessions through crosstalk_sessions action "restore", and a
# peer's message arrives as the classic notice, none of its words in it.
set -uo pipefail
RUN=$1 T=$2
HERE=$(cd "$(dirname "$0")" && pwd)
ROOT=$(cd "$HERE/../.." && pwd)
TYPE="$ROOT/spike/mod/run/type.sh"
mkdir -p "$RUN"; RUN=$(cd "$RUN" && pwd)
cap() { tmux capture-pane -p -t "$T" >"$RUN/screen-$1.txt"; }
waitfor() { for _ in $(seq 1 $(($2 * 4))); do tmux capture-pane -p -t "$T" | grep -qF -- "$1" && return 0; sleep 0.25; done; echo "  (timed out waiting for: $1)"; return 1; }
note() { echo "$(date +%T) $*" | tee -a "$RUN/drive.log"; }
: >"$RUN/drive.log"

rm -rf "$RUN/plugin"; mkdir -p "$RUN/plugin"
(cd "$ROOT" && tar --exclude=.git --exclude=./test --exclude=./spike --exclude=./research_notes -cf - .) | tar -C "$RUN/plugin" -xf -
bun -e 'const f = process.argv[1]; const j = JSON.parse(await Bun.file(f).text()); delete j.modules; await Bun.write(f, JSON.stringify(j, null, 2))' "$RUN/plugin/hooks/hooks.json"
PLUGIN="$RUN/plugin" PORT=8901 "$HERE/setup.sh" "$RUN" "$T" 200 >>"$RUN/drive.log" 2>&1 </dev/null

note "1. the restore offer, as a systemMessage"
waitfor "restore them" 40; sleep 3; cap 1-start
SID=$(jq -r .sessionId "$RUN"/cfg/sessions/*.json | head -1)
tmux capture-pane -p -t "$T" | grep -q "Enter to select" && note "  FAIL a picker is up without the mod" || note "  ok: no picker"
tmux capture-pane -p -t "$T" | grep -F "SessionStart:startup says" >>"$RUN/drive.log"
grep -h "hooks module crosstalk" "$RUN"/cfg/debug/*.txt | head -2 >>"$RUN/drive.log"

note "2. restore them, in plain words"
"$TYPE" "$T" "restore them" 5
for _ in $(seq 1 160); do [ "$(wc -l <"$RUN/restored.txt" 2>/dev/null || echo 0)" -ge 3 ] && break; sleep 0.5; done
sleep 15; cap 2-restored
note "  reopened: $(wc -l <"$RUN/restored.txt" 2>/dev/null || echo 0)"

note "3. a peer message: the classic notice"
"$HERE/rpc.sh" "$RUN/ben" "{\"op\":\"send\",\"sessionId\":\"ben-api\",\"cwd\":\"$RUN/repos/ben-api\",\"to\":\"ana\",\"text\":\"classic GORSE-8801 token format changed\",\"intent\":\"question\"}" >>"$RUN/drive.log"
sleep 40; cap 3-notice
grep -h "inbound\|held for" "$RUN/ana/daemon.log" | tail -2 >>"$RUN/drive.log"
F=$(ls "$RUN"/cfg/projects/*/*.jsonl | head -1)
note "  rows naming the waiting message: $(grep -c 'waiting from ben' "$F")"
note "  GORSE-8801 sent to the API before anyone read it: $(jq -c 'select(.type=="api-request-blob")' "$F" | grep -c GORSE-8801)"
tmux kill-session -t "$T"
note "done"
