#!/usr/bin/env bash
# PostToolUse hook: auto-format edited files with Biome
# Receives tool event JSON on stdin

set -euo pipefail

INPUT=$(cat)
FILE_PATH=$(echo "$INPUT" | node -e "
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

# Only format files Biome handles
if [[ -n "$FILE_PATH" && "$FILE_PATH" =~ \.(ts|tsx|json)$ && ! "$FILE_PATH" =~ (node_modules|dist|package-lock) ]]; then
  npx @biomejs/biome format --write "$FILE_PATH" 2>/dev/null || true
fi
