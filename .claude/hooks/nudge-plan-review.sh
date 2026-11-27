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

# ADR-057 review tiers: a Tier A edit (anything off the Tier B allowlist in
# .claude/review-tiers.json) in a session that has written no plan gets one
# warning per session. Never blocks. Files this session creates are recorded,
# so a new test file stays Tier B when it is edited again.
if [[ -n "$FILE_PATH" ]]; then
  EXISTED=1
  [[ -e "$FILE_PATH" ]] || EXISTED=0
  CREATED_LIST="${STATE_DIR}/created-files"
  # Only a Write creates a file; an Edit of a missing path fails. (A Write the
  # user then denies is still recorded: accepted, ADR-057.)
  if [[ "$EXISTED" == "0" ]] && printf '%s' "$INPUT" | grep -q '"tool_name"[[:space:]]*:[[:space:]]*"Write"'; then
    printf '%s\n' "$FILE_PATH" >> "$CREATED_LIST" 2>/dev/null || true
  fi
  TIER_MARK="${STATE_DIR}/nudged-tier-a"
  if [[ ! -f "${STATE_DIR}/${_WS_MARK_PLAN_WRITE}" && ! -f "$TIER_MARK" ]] \
    && _ws_is_tier_a_edit "$FILE_PATH" "$EXISTED" "$CREATED_LIST"; then
    : > "$TIER_MARK"
    REMINDER="Tier A edit with no plan this session: ${FILE_PATH}. Per CLAUDE.md's workflow (ADR-057), a change touching anything off the Tier B allowlist in .claude/review-tiers.json gets a plan and adversarial agent review before code. (One-shot reminder for this session.)"
    # As real context for the model (hookSpecificOutput.additionalContext on
    # stdout), not stderr, which Claude Code does not show the model on exit 0.
    # Same pattern and jq fallback as stop-cycle-check.sh.
    if command -v jq >/dev/null 2>&1 \
      && jq -n --arg ctx "$REMINDER" \
        '{hookSpecificOutput:{hookEventName:"PreToolUse",additionalContext:$ctx}}'; then
      :
    else
      printf '%s\n' "$REMINDER" >&2
    fi
  fi
fi

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
" 2>/dev/null || printf 'unknown-%s' "$$")
NUDGE_MARK="${STATE_DIR}/nudged-plan-${PLAN_HASH}"
[[ -f "$NUDGE_MARK" ]] && exit 0
: > "$NUDGE_MARK"

cat >&2 <<'EOF'
⚠ Plan written this session but no Agent tool calls since.
   Per CLAUDE.md workflow: dispatch adversarial agents to review the plan before writing code.
   (One-shot reminder. Run any Agent tool to suppress for this plan.)
EOF

exit 0
