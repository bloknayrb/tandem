#!/usr/bin/env bash
# Stop hook.
# Fires every agent turn end. If the session has uncommitted source edits,
# emit one informational reminder per session.

set -uo pipefail
trap 'exit 0' ERR

# shellcheck source=_workflow-state.sh
source "$(dirname "$0")/_workflow-state.sh"

INPUT=$(cat)
SESSION_ID=$(_ws_session_id "$INPUT")
STATE_DIR=$(_ws_state_dir "$SESSION_ID")

NUDGED_MARK="${STATE_DIR}/${_WS_MARK_STOP_NUDGED}"
[[ -f "$NUDGED_MARK" ]] && exit 0

EDIT_MARK="${STATE_DIR}/${_WS_MARK_SOURCE_EDIT}"
COMMIT_MARK="${STATE_DIR}/${_WS_MARK_COMMIT}"

[[ -f "$EDIT_MARK" ]] || exit 0
_ws_newer_than "$COMMIT_MARK" "$EDIT_MARK" && exit 0

: > "$NUDGED_MARK"

# Emit the reminder as real context (STDOUT JSON) so Claude Code injects it via
# hookSpecificOutput.additionalContext, not just as stderr noise. Build the JSON
# with jq so the text is escaped correctly; fall back to stderr if jq is missing
# so the reminder is never silently dropped.
read -r -d '' REMINDER <<'EOF' || true
ℹ Session has uncommitted source edits. Workflow:
   plan → agent review → implement → /simplify → verify → manual test → commit → PR → /pr-review-toolkit:review-pr.
EOF

if command -v jq >/dev/null 2>&1; then
  jq -n --arg ctx "$REMINDER" \
    '{hookSpecificOutput:{hookEventName:"Stop",additionalContext:$ctx}}'
else
  printf '%s\n' "$REMINDER" >&2
fi

exit 0
