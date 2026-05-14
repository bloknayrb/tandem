#!/usr/bin/env bash
# PreToolUse hook (Edit|Write).
# Nudges to dispatch adversarial agent review when a plan was written this
# session but no Agent tool has run since. Never blocks; exit 0 always.

set -uo pipefail
trap 'exit 0' ERR

# shellcheck source=_workflow-state.sh
source "$(dirname "$0")/_workflow-state.sh"

INPUT=$(cat)
SESSION_ID=$(_ws_session_id "$INPUT")
STATE_DIR=$(_ws_state_dir "$SESSION_ID")

FILE_PATH=$(printf '%s' "$INPUT" | node -e "
  let d='';
  process.stdin.on('data', c => d += c);
  process.stdin.on('end', () => {
    try {
      const e = JSON.parse(d);
      const fp = ((e.tool_input && e.tool_input.file_path) || '').replace(/\\\\/g, '/');
      process.stdout.write(fp);
    } catch { process.stdout.write(''); }
  });
" 2>/dev/null) || exit 0

_ws_is_source_edit "$FILE_PATH" || exit 0

PLAN_MARK="${STATE_DIR}/${_WS_MARK_PLAN_WRITE}"
AGENT_MARK="${STATE_DIR}/${_WS_MARK_AGENT_CALL}"

[[ -f "$PLAN_MARK" ]] || exit 0
_ws_newer_than "$AGENT_MARK" "$PLAN_MARK" && exit 0

# Suppress repeats per plan file.
PLAN_PATH=$(cat "$PLAN_MARK" 2>/dev/null || printf '')
[[ -z "$PLAN_PATH" ]] && exit 0
PLAN_HASH=$(printf '%s' "$PLAN_PATH" | node -e "
  let d='';
  process.stdin.on('data', c => d += c);
  process.stdin.on('end', () => {
    process.stdout.write(require('crypto').createHash('sha1').update(d).digest('hex').slice(0, 16));
  });
" 2>/dev/null || printf 'unknown')
NUDGE_MARK="${STATE_DIR}/nudged-plan-${PLAN_HASH}"
[[ -f "$NUDGE_MARK" ]] && exit 0
: > "$NUDGE_MARK"

cat >&2 <<'EOF'
⚠ Plan written this session but no Agent tool calls since.
   Per CLAUDE.md workflow: dispatch adversarial agents to review the plan before writing code.
   (One-shot reminder. Run any Agent tool to suppress for this plan.)
EOF

exit 0
