#!/usr/bin/env bash
# PreToolUse hook: block edits to .env and lock files
# Exit code 2 = block the tool call

set -euo pipefail

INPUT=$(cat)
FILE_PATH=$(echo "$INPUT" | node -e "
  let d='';
  process.stdin.on('data', c => d += c);
  process.stdin.on('end', () => {
    try {
      const e = JSON.parse(d);
      const f = e.tool_input?.file_path || e.tool_input?.command || '';
      process.stdout.write(f);
    } catch { process.exit(0); }
  });
")

if [[ -n "$FILE_PATH" && "$FILE_PATH" =~ (\.env|package-lock\.json)$ ]]; then
  echo "Blocked: refusing to edit sensitive/generated file: $FILE_PATH"
  exit 2
fi
