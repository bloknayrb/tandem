#!/usr/bin/env bash
# PostToolUse hook: run matching vitest file after editing source
# Maps src/{area}/ to tests/{area}/ via basename matching
# Skips if no match or multiple matches (ambiguous)
# Exit 0 = no block

set -euo pipefail
trap 'exit 0' ERR

# Opt-out via environment variable
if [[ -n "${TANDEM_SKIP_RELATED_TEST:-}" ]]; then
  exit 0
fi

INPUT=$(cat)
FILE_PATH=$(printf '%s' "$INPUT" | node -e "
  let d='';
  process.stdin.on('data', c => d += c);
  process.stdin.on('end', () => {
    try {
      const e = JSON.parse(d);
      const f = e.tool_input?.file_path || '';
      process.stdout.write(f);
    } catch { process.exit(0); }
  });
")

# Normalize Windows backslashes
FILE_PATH="${FILE_PATH//\\//}"

# Only process .ts files in src/ (skip .svelte, .css, etc.)
if [[ -z "$FILE_PATH" ]] || [[ ! "$FILE_PATH" =~ /src/ ]] || [[ ! "$FILE_PATH" =~ \.ts$ ]]; then
  exit 0
fi

# Skip test files themselves
if [[ "$FILE_PATH" =~ \.(test|spec)\.ts$ ]]; then
  exit 0
fi

# Determine test area from source path
AREA=""
if [[ "$FILE_PATH" =~ /src/server/ ]]; then
  AREA="server"
elif [[ "$FILE_PATH" =~ /src/client/ ]]; then
  AREA="client"
elif [[ "$FILE_PATH" =~ /src/shared/ ]]; then
  AREA="shared"
elif [[ "$FILE_PATH" =~ /src/channel/ ]]; then
  AREA="channel"
elif [[ "$FILE_PATH" =~ /src/cli/ ]]; then
  AREA="cli"
else
  exit 0
fi

# Extract basename without extension
BASENAME=$(basename "$FILE_PATH" .ts)

# Find matching test file(s)
TEST_DIR="tests/$AREA"
if [[ ! -d "$TEST_DIR" ]]; then
  exit 0
fi

mapfile -t MATCH_ARR < <(find "$TEST_DIR" -name "${BASENAME}.test.ts" 2>/dev/null)

# `basename foo.svelte.ts .ts` leaves "foo.svelte", so a Svelte-5 rune module
# only matched a suite named `foo.svelte.test.ts`. Both naming conventions are
# in the tree — 5 modules use that name, 19 use plain `foo.test.ts` and matched
# nothing at all, exiting 0 silently (#1408). A quiet hook reads as a green
# hook. Fallback runs ONLY on an empty result, so nothing that already matched
# changes behaviour.
#
# Note the semantics this encodes: one convention wins, rather than both being
# valid. If a module ever grows BOTH `X.svelte.test.ts` and `X.test.ts`, the
# first lookup is non-empty, the fallback never fires, and the plain suite
# silently never runs — the same silent-zero class #1408 was filed for, one
# level down. Unreachable today (no such collision exists in the tree); if one
# appears, union the two results and let the >1 ambiguity warning below speak.
if [[ "${#MATCH_ARR[@]}" -eq 0 && "$BASENAME" == *.svelte ]]; then
  mapfile -t MATCH_ARR < <(find "$TEST_DIR" -name "${BASENAME%.svelte}.test.ts" 2>/dev/null)
fi

MATCH_COUNT=${#MATCH_ARR[@]}

if [[ "$MATCH_COUNT" -eq 0 ]]; then
  exit 0
elif [[ "$MATCH_COUNT" -gt 1 ]]; then
  echo "⚠ Ambiguous test mapping for $BASENAME ($MATCH_COUNT candidates), skipping."
  exit 0
fi

TEST_FILE="${MATCH_ARR[0]}"
echo "Running related test: $TEST_FILE"
# Call vitest's entry directly rather than through `npx`. Measured on Windows,
# `npx` spends 2.4-3.8s resolving the bin before vitest starts — roughly half
# the wall time of a one-file run (7.0s -> 3.7s). Pre-existing, but the #1408
# fallback above arms this path on 19 more modules, so it now costs 19x more
# often. Same reason `playwright.config.ts` invokes the tsx CLI by path.
node node_modules/vitest/vitest.mjs run --reporter=dot --bail=1 "$TEST_FILE" 2>&1 || true
