#!/usr/bin/env bash
# PreToolUse hook: block E2E test commands that kill the dev server
# freePort() in Playwright config kills :3478/:3479
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
    } catch { process.exit(0); }
  });
" 2>/dev/null) || exit 0

# Only match commands that actually execute playwright or E2E tests
# Require the keyword at a word boundary after a command prefix (npx, npm, node, etc.)
if [[ -n "$COMMAND" && "$COMMAND" =~ (npx[[:space:]]+playwright|npm[[:space:]]+run[[:space:]]+test:e2e|node.*playwright) ]]; then
  echo "⛔ E2E tests kill running dev server on :3478/:3479 via freePort()."
  echo "Before running, confirm with the user that no dev server is in use."
  echo "Check: curl -sf http://127.0.0.1:3479/health || echo 'no server running'"
  exit 2
fi
