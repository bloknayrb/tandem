#!/usr/bin/env bash
# PostToolUse hook: warn on raw hex/rgba colors in client code
# Delegates to scripts/check-semantic-tokens.ts for accurate detection
# Exit 2 + continueOnBlock = Claude self-corrects the violation; exit 0 = clean

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
# Scanner writes all output (per-violation file:line: token + summary) to stderr.
# On PostToolUse exit 2, Claude Code shows stderr to Claude as feedback and
# ignores stdout — so the BLOCKED framing below MUST also go to stderr,
# otherwise Claude self-correct (continueOnBlock) has only the generic message
# and not the actionable file:line details.
npx tsx scripts/check-semantic-tokens.ts "$FILE_PATH" || RC=$?
if [[ $RC -eq 1 ]]; then
  echo "BLOCKED: Raw hex/rgba color tokens in client code — use semantic --tandem-* CSS variables." >&2
  echo "Fix: Replace raw color values with var(--tandem-*) tokens or import from src/client/utils/colors.ts." >&2
  exit 2
elif [[ $RC -ge 2 ]]; then
  echo "⚠ Token scanner failed (exit $RC) — check skipped for this edit." >&2
fi
