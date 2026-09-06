#!/usr/bin/env bash
# PostToolUse hook: run svelte-check after editing .svelte files
# Complements typecheck-on-edit.sh which only handles .ts/.tsx
# Non-blocking: always exits 0, surfaces errors as output

set -euo pipefail
trap 'exit 0' ERR

# Opt-out via environment variable
if [[ -n "${TANDEM_SKIP_SVELTE_CHECK:-}" ]]; then
  exit 0
fi

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
