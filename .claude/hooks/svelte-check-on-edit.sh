#!/usr/bin/env bash
# PostToolUse hook: run svelte-check after editing .svelte files
# Complements typecheck-on-edit.sh which only handles .ts/.tsx
# Non-blocking: always exits 0, surfaces errors as output

set -euo pipefail

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

# Normalize Windows backslashes before any path checks
FILE_PATH="${FILE_PATH//\\//}"

# Only check .svelte files in src/client/
if [[ -z "$FILE_PATH" || ! "$FILE_PATH" =~ \.svelte$ ]]; then
  exit 0
fi

if [[ ! "$FILE_PATH" =~ src/client/ ]]; then
  exit 0
fi

echo "Running svelte-check..."
npx svelte-check --tsconfig tsconfig.client.json 2>&1 || true
