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
MATCH_COUNT=${#MATCH_ARR[@]}

if [[ "$MATCH_COUNT" -eq 0 ]]; then
  exit 0
elif [[ "$MATCH_COUNT" -gt 1 ]]; then
  echo "⚠ Ambiguous test mapping for $BASENAME ($MATCH_COUNT candidates), skipping."
  exit 0
fi

TEST_FILE="${MATCH_ARR[0]}"
echo "Running related test: $TEST_FILE"
npx vitest run --reporter=dot --bail=1 "$TEST_FILE" 2>&1 || true
