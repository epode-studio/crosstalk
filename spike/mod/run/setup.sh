#!/bin/bash
# Prepares an isolated Claude Code home for one spike run and starts it in tmux.
#   spike/mod/run/setup.sh <run-dir> <tmux-session>
# The run dir gets cfg/ (CLAUDE_CONFIG_DIR), xt/ (CROSSTALK_SPIKE_DIR) and work/ (cwd).
set -euo pipefail
RUN=$1 NAME=$2
MOD=$(cd "$(dirname "$0")/.." && pwd)
mkdir -p "$RUN/cfg" "$RUN/xt" "$RUN/work"
RUN=$(cd "$RUN" && pwd)

if [ -z "${EXTRA:-}" ]; then # a --resume run keeps the run's files as they are

# Skip onboarding and the trust dialog for the work dir.
cat >"$RUN/cfg/.claude.json" <<EOF
{ "hasCompletedOnboarding": true, "theme": "dark", "bypassPermissionsModeAccepted": true,
  "projects": { "$RUN/work": { "hasTrustDialogAccepted": true, "hasCompletedProjectOnboarding": true } } }
EOF

# The fallback for when mods are off: a classic UserPromptSubmit block on `%xt`.
cat >"$RUN/cfg/settings.json" <<EOF
{ "hooks": { "UserPromptSubmit": [ { "hooks": [ { "type": "command", "command": "bun $MOD/run/block-hook.ts" } ] } ] } }
EOF

# What the daemon would publish: three questions from other threads, a status note.
cat >"$RUN/xt/spike-questions.json" <<'EOF'
{ "questions": [
  { "id": "q1", "thread": "auth", "text": "xt-band rotate the signing key now? BISON-2048", "toast": "xt-toast auth is waiting on you CORAL-3301" },
  { "id": "q2", "thread": "billing", "text": "xt-band2 retry the failed invoices? FALCON-6603" },
  { "id": "q3", "thread": "infra", "text": "xt-band3 drain node 4? JADE-9936" }
] }
EOF
printf 'xt-status AMBER-1017' >"$RUN/xt/spike-status.txt"
rm -f "$RUN/xt/spike-answers.json" "$RUN/xt/spike-received.json"
fi

tmux kill-session -t "$NAME" 2>/dev/null || true
tmux new-session -d -s "$NAME" -x 160 -y 50 \
  "source $(dirname "$0")/env.sh; cd $RUN/work; CLAUDE_CONFIG_DIR=$RUN/cfg CROSSTALK_SPIKE_DIR=$RUN/xt claude --plugin-dir $MOD --debug ${EXTRA:-}; sleep 600"
echo "started $NAME in $RUN"
