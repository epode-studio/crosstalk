#!/usr/bin/env bash
# Try crosstalk's restore on a Mac, without touching your other sessions.
#
#   bash scripts/try-restore-mac.sh          run the whole test
#   bash scripts/try-restore-mac.sh --clean  remove the test folders afterwards
#
# What it does:
#   1. Opens three Terminal windows, each running a test Claude session in its
#      own folder under ~/crosstalk-restore-test, with crosstalk loaded from this
#      checkout only for those sessions (--plugin-dir). Nothing is installed.
#   2. Waits until each has answered one short prompt.
#   3. Kills exactly those three Claude processes, so they die the way a crash
#      would. It checks each pid is a Claude it started before killing it.
#   4. Shows what restore would open (--dry-run).
#   5. Opens one more window with a new session that is told "restore them".
#
# Your own sessions are never offered: restore skips anything still running.

set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
TEST="$HOME/crosstalk-restore-test"
NAMES=(alpha beta gamma)
PROMPT="This is a crosstalk restore test. Reply with the single word: ready"
SESSIONS="$HOME/.claude/sessions"

say() { printf '\n\033[1m◢ %s\033[0m\n' "$*"; }
die() { printf '\n\033[31m✗ %s\033[0m\n' "$*" >&2; exit 1; }

if [[ "${1:-}" == "--clean" ]]; then
  rm -rf "$TEST"
  say "Removed $TEST"
  exit 0
fi

[[ "$(uname)" == "Darwin" ]] || die "This script is for macOS Terminal."
command -v claude >/dev/null || die "claude is not on your PATH."
command -v osascript >/dev/null || die "osascript is missing."
RUN=""
if command -v bun >/dev/null; then RUN=bun; elif command -v node >/dev/null; then RUN=node; else
  die "crosstalk needs bun or node on your PATH."
fi
[[ -x "$ROOT/bin/crosstalk" ]] || die "Run this from a crosstalk checkout (bin/crosstalk not found)."

if claude plugin list 2>/dev/null | grep -qi crosstalk; then
  say "Note: you also have crosstalk installed. The test sessions load this checkout"
  echo "  as well, so you may see messages from both. Your other sessions are unaffected."
fi

# AppleScript string: escape backslashes and double quotes.
as_str() { local s=${1//\\/\\\\}; s=${s//\"/\\\"}; printf '"%s"' "$s"; }
# Shell word: single-quote, with embedded single quotes closed and reopened.
sh_q() { printf "'%s'" "${1//\'/\'\\\'\'}"; }

open_window() { # $1 dir, $2 command
  osascript -e "tell application \"Terminal\" to do script $(as_str "cd $(sh_q "$1") && $2")" >/dev/null
}

# The pid of the Claude session whose working directory is $1, from Claude
# Code's own registry (~/.claude/sessions/<pid>.json).
pid_for() {
  "$RUN" -e '
    const fs = require("fs"), path = require("path")
    const [dir, want] = process.argv.slice(1)
    let best = null
    for (const f of fs.readdirSync(dir)) {
      if (!f.endsWith(".json")) continue
      try {
        const e = JSON.parse(fs.readFileSync(path.join(dir, f), "utf8"))
        e.pid = Number(f.slice(0, -5))
        try { process.kill(e.pid, 0) } catch { continue }
        if (e.cwd === want && (!best || (e.updatedAt ?? 0) > (best.updatedAt ?? 0))) best = e
      } catch {}
    }
    if (best) console.log(`${best.pid} ${best.status ?? ""}`)
  ' "$SESSIONS" "$1" 2>/dev/null || true
}

say "Opening three test sessions"
mkdir -p "$TEST"
for n in "${NAMES[@]}"; do
  mkdir -p "$TEST/$n"
  open_window "$TEST/$n" "claude --plugin-dir $(sh_q "$ROOT") $(sh_q "$PROMPT")"
  echo "  $TEST/$n"
done
echo "  The first time, macOS may ask whether this terminal may control Terminal. Allow it."

say "Waiting for each to answer (up to 3 minutes)"
PIDS=() # macOS ships bash 3.2: no associative arrays
deadline=$((SECONDS + 180))
for n in "${NAMES[@]}"; do
  while :; do
    p=""; status=""
    read -r p status <<<"$(pid_for "$TEST/$n")" || true
    if [[ -n "$p" && "$status" == "idle" ]]; then PIDS+=("$p"); echo "  $n ready (pid $p)"; break; fi
    (( SECONDS < deadline )) || die "$n did not become ready. Check its window (trust the folder if Claude asks)."
    sleep 2
  done
done
sleep 3 # let the end-of-turn hook record each tab's position

say "Killing exactly those three sessions, as a crash would"
for i in "${!NAMES[@]}"; do
  n=${NAMES[$i]}; p=${PIDS[$i]}
  comm=$(ps -o comm= -p "$p" 2>/dev/null || true)
  cwd=$(lsof -a -p "$p" -d cwd -Fn 2>/dev/null | sed -n 's/^n//p' || true)
  if [[ "$comm" != *claude* && "$comm" != *node* ]] || [[ -n "$cwd" && "$cwd" != "$TEST/$n" ]]; then
    die "pid $p is not the test session for $n ($comm in ${cwd:-?}); not killing it."
  fi
  kill -9 "$p"
  echo "  killed $n (pid $p)"
done
sleep 2

say "What restore would open"
"$ROOT/bin/crosstalk" restore --dry-run || true

say "Opening a new session and asking it to restore"
open_window "$TEST" "claude --plugin-dir $(sh_q "$ROOT") 'restore them'"
cat <<EOF
  A new Terminal window opens and asks crosstalk to restore the three sessions.

  If macOS asks whether Terminal may control System Events, click Allow.
  If System Settings opens on Accessibility, turn on Terminal; the tabs then
  open by themselves.

  What to check:
  - did the three sessions come back, each in $TEST/<name>, with its conversation?
  - did they open as tabs or as separate windows?
  - did any permission prompt appear before you asked to restore?

  The killed windows stay open showing "[Process completed]"; close them.
  When you are done:  bash $(sh_q "$ROOT/scripts/try-restore-mac.sh") --clean
EOF
