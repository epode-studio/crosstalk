#!/bin/bash
# Prepares an isolated Claude Code home for one surfaces run and starts it in tmux.
#   spike/mod/surfaces/run/setup.sh <run-dir> <tmux-session> [columns] [CLAUDE_CODE_NO_FLICKER: 0 main screen, 1 fullscreen, empty the default]
# The run dir gets cfg/ (CLAUDE_CONFIG_DIR), xt/ (CROSSTALK_SPIKE_DIR) and work/ (cwd).
# EXTRA="--resume <id>" restarts the run's session without reseeding anything.
set -euo pipefail
RUN=$1 NAME=$2 COLS=${3:-200} FULL=${4:-}
HERE=$(cd "$(dirname "$0")" && pwd)
MOD=$(cd "$HERE/.." && pwd)
mkdir -p "$RUN"
RUN=$(cd "$RUN" && pwd)

if [ -z "${EXTRA:-}" ]; then
rm -rf "$RUN/cfg" "$RUN/xt" "$RUN/work" # a fresh run starts from nothing
mkdir -p "$RUN/cfg" "$RUN/xt" "$RUN/work"
cat >"$RUN/cfg/.claude.json" <<EOF
{ "hasCompletedOnboarding": true, "theme": "dark", "bypassPermissionsModeAccepted": true,
  "projects": { "$RUN/work": { "hasTrustDialogAccepted": true, "hasCompletedProjectOnboarding": true } } }
EOF

# Two messages from other threads, as cards. Only card1 is ever handed over.
cat >"$RUN/xt/surfaces-cards.json" <<'EOF'
{ "cards": [
  { "id": "c1", "from": "marie", "thread": "auth", "age": "2m",
    "text": "xt-card1 MOSS-3301 Token format changed to v2. v1 accepted until 0.2",
    "chip": { "kind": "diff", "label": "src/auth/token.ts xt-chip1 FERN-3302", "size": "+42 −18" } },
  { "id": "c2", "from": "jo", "thread": "billing", "age": "9m",
    "text": "xt-card2 Invoice retries move to 5pm REED-4401",
    "chip": { "kind": "file", "label": "invoices.csv xt-chip2 SEDGE-4402", "size": "2 KB" } }
] }
EOF

cat >"$RUN/xt/surfaces-thread.json" <<'EOF'
{ "name": "auth", "status": "blocked on you",
  "people": [ { "name": "marie", "online": true }, { "name": "jo", "online": false } ],
  "waiting": [ "xt-pane keep the v1 endpoint for one more release? BIRCH-5501" ],
  "decision": "tokens move to v2; v1 stays readable until 0.2",
  "recent": [ { "from": "marie", "age": "2m", "text": "token format changed to v2" },
              { "from": "jo", "age": "1h", "text": "can billing read v2 yet?" } ] }
EOF

# ANSI colour and an OSC 8 link in the status line and in a toast.
printf '◢ auth · tokens   marie \033[32m●\033[0m  jo \033[2m○\033[0m   \033[1;33m2 waiting\033[0m \033]8;;https://example.com/xt\033\\xt-stat link\033]8;;\033\\ TEAL-6601' >"$RUN/xt/surfaces-status.txt"
printf '\033[1;35mxt-toast2 jo joined auth\033[0m \033]8;;https://example.com/jo\033\\profile\033]8;;\033\\ LIME-6602' >"$RUN/xt/surfaces-toast.txt"
rm -f "$RUN/xt/surfaces-ask.json" "$RUN/xt/surfaces-log.jsonl"
fi

FS=""; [ -n "$FULL" ] && FS="CLAUDE_CODE_NO_FLICKER=$FULL"
tmux kill-session -t "$NAME" 2>/dev/null || true
tmux new-session -d -s "$NAME" -x "$COLS" -y 50 \
  "source $MOD/../run/env.sh; cd $RUN/work; $FS CLAUDE_CONFIG_DIR=$RUN/cfg CROSSTALK_SPIKE_DIR=$RUN/xt claude --plugin-dir $MOD --debug ${EXTRA:-}; sleep 600"
echo "started $NAME in $RUN ($COLS columns, fullscreen=$FULL)"
