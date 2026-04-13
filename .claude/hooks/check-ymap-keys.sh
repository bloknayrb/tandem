#!/usr/bin/env bash
# PostToolUse hook: warn if raw Y.Map key strings are used in getMap() calls
# Checks src/ files (excluding constants.ts definitions and test files)
# Exit 0 = no block, just warns via stderr

set -euo pipefail
trap 'exit 0' ERR

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

# Normalize Windows backslashes so /src/ regexes match
FILE_PATH="${FILE_PATH//\\//}"

# Only check src/ files, skip constants.ts and test files
if [[ -z "$FILE_PATH" ]] || [[ ! "$FILE_PATH" =~ /src/ ]] || [[ "$FILE_PATH" =~ constants\.ts$ ]] || [[ "$FILE_PATH" =~ \.test\.ts$ ]] || [[ "$FILE_PATH" =~ \.spec\.ts$ ]]; then
  exit 0
fi

# Look for raw Y.Map key strings: getMap('...') or getMap("...")
# These should use constants from shared/constants.ts
VIOLATIONS=$(grep -nE "getMap\(['\"]" "$FILE_PATH" 2>/dev/null || true)
if [[ -n "$VIOLATIONS" ]]; then
  echo "⚠ Raw Y.Map key string detected (use constants from shared/constants.ts):"
  echo "$VIOLATIONS"
fi
