#!/usr/bin/env bash
# PostToolUse hook: warn if extractMarkdown() is used in MCP tool files
# extractMarkdown() shifts offsets relative to the annotation coordinate system.
# Only convert.ts (export-only) is allowed to use it.
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

# Only check server MCP files, skip convert.ts (legitimate use for export)
if [[ -z "$FILE_PATH" ]] || [[ ! "$FILE_PATH" =~ /src/server/ ]] || [[ "$FILE_PATH" =~ convert\.ts$ ]]; then
  exit 0
fi

VIOLATIONS=$(grep -nE "extractMarkdown\(" "$FILE_PATH" 2>/dev/null || true)
if [[ -n "$VIOLATIONS" ]]; then
  echo "⚠ extractMarkdown() in server code shifts annotation offsets. Use extractText() instead."
  echo "  (Only convert.ts may use extractMarkdown for export-only paths)"
  echo "$VIOLATIONS"
fi
