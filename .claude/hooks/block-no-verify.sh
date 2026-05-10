#!/usr/bin/env bash
# PreToolUse hook: block Bash commands that skip Husky hooks
# Exit code 2 = block the tool call

set -uo pipefail

INPUT=$(cat)
COMMAND=$(printf '%s' "$INPUT" | node -e "
  let d='';
  process.stdin.on('data', c => d += c);
  process.stdin.on('end', () => {
    try {
      const e = JSON.parse(d);
      const c = e.tool_input?.command || '';
      process.stdout.write(c);
    } catch {
      process.stderr.write('Hook: failed to parse tool input\n');
      process.exit(1);
    }
  });
" 2>/dev/null) || {
  echo "⚠ Could not parse tool input — blocking as a precaution."
  exit 2
}

if [[ -n "$COMMAND" && "$COMMAND" =~ --no-verify ]]; then
  echo "Blocked: --no-verify skips Husky hooks. If a hook fails, fix the underlying issue instead of bypassing it."
  exit 2
fi
