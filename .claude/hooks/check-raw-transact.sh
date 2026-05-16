#!/usr/bin/env bash
# PostToolUse hook: warn when raw `*.transact(` calls appear outside the
# ADR-031 helpers' file (src/shared/origins.ts) and the existing test fixtures.
# Direct doc.transact / ydoc.transact / ctrlDoc.transact callsites bypass the
# origin matrix that channel / durable-sync / tombstone observers rely on.
#
# Allowlist:
#   - src/shared/origins.ts            (the helpers themselves)
#   - **/*.test.ts, **/*.spec.ts        (test fixtures may need a raw transact)
#   - tests/helpers/                    (test factories may need raw transact)
#
# Exit 0 = no block, just warns via stderr.

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

# Only check src/ files
if [[ -z "$FILE_PATH" ]] || [[ ! "$FILE_PATH" =~ /src/ ]]; then
  exit 0
fi

# Skip the helpers file itself
if [[ "$FILE_PATH" =~ /src/shared/origins\.ts$ ]]; then
  exit 0
fi

# Skip test files (allowlist)
if [[ "$FILE_PATH" =~ \.test\.ts$ ]] || [[ "$FILE_PATH" =~ \.spec\.ts$ ]]; then
  exit 0
fi

# Search for raw transact callsites. Match:
#   - <expr>.transact(
# but not:
#   - // doc.transact(...)  (comments)
#   - /* doc.transact(...)  (block comments — heuristic)
# We strip lines that look like doc-comment lines (/^\s*\*/) and `//` lines.
VIOLATIONS=$(grep -nE "\b[A-Za-z_][A-Za-z0-9_.]*\.transact\(" "$FILE_PATH" 2>/dev/null \
  | grep -vE "^\s*[0-9]+:\s*(\*|//|\* )" \
  || true)

if [[ -n "$VIOLATIONS" ]]; then
  echo "⚠ Raw .transact() detected (ADR-031: use withMcp / withFileSync / withInternal / withReload / withBrowser from src/shared/origins.ts):"
  echo "$VIOLATIONS"
fi
