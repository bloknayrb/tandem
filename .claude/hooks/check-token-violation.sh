#!/usr/bin/env bash
# PostToolUse hook: warn on raw hex/rgba colors in client code
# Delegates to scripts/check-semantic-tokens.ts for accurate detection
# Exit 0 = no block, just warns

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

# Normalize Windows backslashes
FILE_PATH="${FILE_PATH//\\//}"

# Only check src/client/ .ts and .svelte files
if [[ -z "$FILE_PATH" ]] || [[ ! "$FILE_PATH" =~ /src/client/ ]] || [[ ! "$FILE_PATH" =~ \.(ts|svelte)$ ]]; then
  exit 0
fi

RC=0
npx tsx scripts/check-semantic-tokens.ts "$FILE_PATH" 2>&1 || RC=$?
if [[ $RC -ge 2 ]]; then
  echo "⚠ Token scanner failed (exit $RC) — check skipped for this edit."
fi
