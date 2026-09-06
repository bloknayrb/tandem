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

# Worktree guard (open-issues sweep, docs/plans/2026-09-06-open-issues-sweep.md):
# an edit inside a git worktree under .claude/worktrees/ (or anywhere outside
# $CLAUDE_PROJECT_DIR) is checked here against the MAIN checkout, which does
# not contain the edit — the result is noise at best and a wrong verdict at
# worst, and it burns CPU the worktree's own verify stage needs. Skip; the
# worktree runs its own typecheck/format/tests before pushing. Backslashes are
# normalised FIRST so a Windows path cannot slip past the segment match.
FILE_PATH="${FILE_PATH//\\//}"
case "$FILE_PATH" in */.claude/worktrees/*) exit 0 ;; esac
_PROJECT_DIR="${CLAUDE_PROJECT_DIR:-}"; _PROJECT_DIR="${_PROJECT_DIR//\\//}"; _PROJECT_DIR="${_PROJECT_DIR%/}"
if [[ -n "$_PROJECT_DIR" && "$FILE_PATH" == /* && "$FILE_PATH" != "$_PROJECT_DIR"/* ]]; then
  exit 0
fi

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
