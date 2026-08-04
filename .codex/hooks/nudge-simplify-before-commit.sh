#!/usr/bin/env bash
# PreToolUse hook (Bash).
# Nudges to run /simplify when source edits have happened since the last
# /simplify run. Never blocks; exit 0 always.

set -uo pipefail
trap 'exit 0' ERR

# shellcheck source=_workflow-state.sh
source "$(dirname "$0")/_workflow-state.sh"

INPUT=$(cat)
SESSION_ID=$(_ws_session_id "$INPUT")
STATE_DIR=$(_ws_state_dir "$SESSION_ID")

COMMAND=$(printf '%s' "$INPUT" | node -e "
  let d='';
  process.stdin.on('data', c => d += c);
  process.stdin.on('end', () => {
    try {
      const e = JSON.parse(d);
      process.stdout.write((e.tool_input && e.tool_input.command) || '');
    } catch { process.stdout.write(''); }
  });
" 2>/dev/null) || exit 0

_ws_is_git_commit "$COMMAND" || exit 0

EDIT_MARK="${STATE_DIR}/${_WS_MARK_SOURCE_EDIT}"
SIMPLIFY_MARK="${STATE_DIR}/${_WS_MARK_SIMPLIFY}"

[[ -f "$EDIT_MARK" ]] || exit 0
_ws_newer_than "$SIMPLIFY_MARK" "$EDIT_MARK" && exit 0

# Suppress repeat firings for the same edit (retried commit after hook fail).
EDIT_TS=$(_ws_mtime "$EDIT_MARK")
NUDGE_MARK="${STATE_DIR}/nudged-simplify-${EDIT_TS}"
[[ -f "$NUDGE_MARK" ]] && exit 0
: > "$NUDGE_MARK"

cat >&2 <<'EOF'
⚠ Source edits since last /simplify run. Consider /simplify before committing.
   This is a one-shot reminder; the commit will proceed.
EOF

exit 0
