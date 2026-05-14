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

cat >&2 <<'EOF'
ℹ Session has uncommitted source edits. Workflow:
   plan → agent review → implement → /simplify → verify → manual test → commit → PR → /pr-review-toolkit:review-pr.
EOF

exit 0
