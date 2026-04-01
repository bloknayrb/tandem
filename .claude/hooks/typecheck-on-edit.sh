#!/usr/bin/env bash
# PostToolUse hook: run TypeScript typecheck after editing .ts/.tsx files
# Uses the appropriate tsconfig based on file path:
#   src/server/*, src/shared/*, src/channel/* → tsconfig.server.json (no DOM, faster)
#   src/client/*                              → tsconfig.client.json (DOM, narrower scope)
#   anything else                             → tsconfig.server.json (safe default)
# Non-blocking: always exits 0, surfaces errors as output

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

# Only typecheck TypeScript files, skip non-source paths
if [[ -z "$FILE_PATH" || ! "$FILE_PATH" =~ \.(ts|tsx)$ ]]; then
  exit 0
fi
if [[ "$FILE_PATH" =~ (node_modules|dist) ]]; then
  exit 0
fi

# Select tsconfig based on file path
if [[ "$FILE_PATH" =~ src/client/ ]]; then
  TSCONFIG="tsconfig.client.json"
else
  TSCONFIG="tsconfig.server.json"
fi

echo "Typechecking with $TSCONFIG..."
npx tsc -p "$TSCONFIG" --noEmit 2>&1 || true
