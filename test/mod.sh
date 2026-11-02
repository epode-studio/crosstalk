#!/usr/bin/env bash
# crosstalk's mod, checked the way Claude Code reads it.
#
#   bash test/mod.sh
#
#   1. `claude plugin validate .` accepts the plugin and its hooks module
#   2. the module type-checks against the engine's own types, when this
#      machine has them (CLAUDE_CODE_TYPES, or found under the skill cache)
#   3. `claude plugin test` runs mod/*.test.tsx: the pane, the four-option
#      card picker and More…, an @ shortcut taken before it is a prompt
#
# `claude plugin test` runs every *.test.ts under the folder it is given, and
# the repository's own tests are bun's, so the mod is copied to a folder of
# its own first. Skipped, and says so, where there is no `claude`.

set -u
cd "$(dirname "$0")/.."
ROOT=$(pwd)
FAILED=0
pass() { echo "  PASS  $1"; }
fail() { echo "  FAIL  $1"; FAILED=1; }

if ! command -v claude >/dev/null 2>&1; then
  echo "  SKIP  no claude on PATH"
  exit 0
fi
TMP=$(mktemp -d)
trap 'rm -rf "$TMP"' EXIT

OUT=$(claude plugin validate "$ROOT" 2>&1)
if echo "$OUT" | grep -q "Validation passed"; then pass "claude plugin validate accepts the plugin"; else fail "claude plugin validate"; echo "$OUT" | tail -20; fi
echo "$OUT" | grep -q "ui.render{component=Pane, requestId=thread}" && pass "the module draws the thread pane" || fail "no Pane render hook"

TYPES=${CLAUDE_CODE_TYPES:-$(ls -t /tmp/claude-*/bundled-skills/*/*/plugin-authoring/types/claude-code.d.ts 2>/dev/null | head -1)}
if [ -n "$TYPES" ] && [ -f "$TYPES" ]; then
  cat >"$TMP/tsconfig.json" <<EOF
{
  "compilerOptions": {
    "target": "es2023", "lib": ["es2023"], "types": [],
    "module": "esnext", "moduleResolution": "bundler",
    "strict": true, "noUncheckedIndexedAccess": true,
    "noEmit": true, "skipLibCheck": true, "allowImportingTsExtensions": true,
    "jsx": "react", "jsxFactory": "h", "jsxFragmentFactory": "Fragment"
  },
  "include": ["$TYPES", "$ROOT/mod/register.tsx", "$ROOT/mod/draw.tsx", "$ROOT/mod/types/index.d.ts", "$ROOT/src/ui-extra/pure.ts"]
}
EOF
  if TC=$("$ROOT/node_modules/.bin/tsc" -p "$TMP/tsconfig.json" 2>&1); then pass "the mod type-checks against the engine's types"; else fail "the mod does not type-check"; echo "$TC" | head -20; fi
else
  echo "  SKIP  no engine types on this machine (set CLAUDE_CODE_TYPES)"
fi

P="$TMP/plugin"
mkdir -p "$P/.claude-plugin" "$P/hooks" "$P/mod/types" "$P/src/ui-extra"
cp "$ROOT/.claude-plugin/plugin.json" "$P/.claude-plugin/"
echo '{ "modules": ["../mod/register.tsx"] }' >"$P/hooks/hooks.json"
cp "$ROOT/mod/register.tsx" "$ROOT/mod/draw.tsx" "$ROOT/mod/register.test.tsx" "$P/mod/"
cp "$ROOT/mod/types/index.d.ts" "$P/mod/types/"
cp "$ROOT/src/ui-extra/pure.ts" "$P/src/ui-extra/"
RES=$(cd "$P" && timeout 300 claude plugin test . 2>&1)
echo "$RES" | grep -E "^\((pass|fail)\)" | sed 's/^/        /'
if echo "$RES" | grep -qE "^ *[1-9][0-9]* pass" && ! echo "$RES" | grep -qE "^ *[1-9][0-9]* fail"; then pass "claude plugin test: the mod's tests"; else fail "claude plugin test"; echo "$RES" | tail -30; fi

[ $FAILED -eq 0 ] && echo "mod: all passed" || { echo "mod: FAILED"; exit 1; }
