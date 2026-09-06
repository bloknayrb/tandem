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

# Only format files Biome handles
if [[ -n "$FILE_PATH" && "$FILE_PATH" =~ \.(ts|tsx|svelte|css|html|md|yml|yaml|mjs|json)$ && ! "$FILE_PATH" =~ (node_modules|dist|package-lock) ]]; then
  npx @biomejs/biome format --write "$FILE_PATH" 2>/dev/null || true
fi
