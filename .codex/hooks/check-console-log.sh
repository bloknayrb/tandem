#!/usr/bin/env bash
# PostToolUse hook: warn if console.log() is used in server code
# stdout is reserved for MCP wire (Critical Rule #3)
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

# Normalize Windows backslashes
FILE_PATH="${FILE_PATH//\\//}"

# Only check src/server/ .ts files, skip index.ts (where the redirect lives)
if [[ -z "$FILE_PATH" ]] || [[ ! "$FILE_PATH" =~ /src/server/ ]] || [[ ! "$FILE_PATH" =~ \.ts$ ]] || [[ "$FILE_PATH" =~ /src/server/index\.ts$ ]]; then
  exit 0
fi

VIOLATIONS=$(grep -nE "console\.log\(" "$FILE_PATH" 2>/dev/null || true)
if [[ -n "$VIOLATIONS" ]]; then
  echo "⚠ console.log() in server code corrupts MCP stdio wire. Use console.error() or console.warn() instead:"
  echo "$VIOLATIONS"
fi
