#!/usr/bin/env bash
# Manual test fixture for .claude/hooks/_workflow-state.sh helpers and
# track-workflow-events.sh's commit-clears-nudge behavior.
#
# Run from repo root:  bash tests/hooks/test_workflow_state.sh
# Hard-fails on the first failing case (set -e + explicit guard).
#
# Pure bash; no bats dependency. CI-eligible from day one if wired into a
# job that does `bash tests/hooks/test_workflow_state.sh`.

set -uo pipefail

REPO_ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
HOOKS_DIR="${REPO_ROOT}/.claude/hooks"

# shellcheck source=../../.claude/hooks/_workflow-state.sh
source "${HOOKS_DIR}/_workflow-state.sh"

PASS_COUNT=0
fail() {
  echo "FAIL: $1" >&2
  exit 1
}
pass() {
  PASS_COUNT=$((PASS_COUNT + 1))
}

# -----------------------------------------------------------------------------
# _ws_is_source_edit
# -----------------------------------------------------------------------------

_ws_is_source_edit "src/client/App.svelte" \
  && pass || fail "forward-slash src path should be a source edit"

# Windows backslash path — this is the fix.
_ws_is_source_edit 'src\client\App.svelte' \
  && pass || fail "backslash-normalized src path should be a source edit"

# Regression guard: exclusion (tests/) must survive backslash normalization.
_ws_is_source_edit 'tests\client\foo.test.ts' \
  && fail "backslash-normalized tests path must NOT be a source edit" \
  || pass

_ws_is_source_edit "src-tauri/src/lib.rs" \
  && pass || fail "src-tauri path should be a source edit"

_ws_is_source_edit "tests/client/foo.test.ts" \
  && fail "tests/ path must NOT be a source edit" \
  || pass

_ws_is_source_edit "src/client/App.svelte.test.ts" \
  && fail ".test.ts file under src/ must NOT be a source edit" \
  || pass

_ws_is_source_edit "src/notes/foo.md" \
  && fail ".md file under src/ must NOT be a source edit" \
  || pass

_ws_is_source_edit "src/node_modules/x/index.js" \
  && fail "node_modules under src/ must NOT be a source edit" \
  || pass

_ws_is_source_edit "" \
  && fail "empty path must NOT be a source edit" \
  || pass

# -----------------------------------------------------------------------------
# track-workflow-events.sh: commit clears stop-nudged
# -----------------------------------------------------------------------------

# Build a per-test session dir under a temp root.
TMP_ROOT="$(mktemp -d 2>/dev/null || mktemp -d -t hookstest)"
trap 'rm -rf "$TMP_ROOT"' EXIT

# We can't intercept the hook's internal _ws_state_dir resolution from outside
# without env injection, so we test by invoking the hook with a known
# session_id and then introspecting the state dir it creates under cwd.
SESSION_ID="test-commit-clears-nudge-$$"
EXPECTED_DIR="${REPO_ROOT}/.claude/.workflow-state/${SESSION_ID}"
rm -rf "$EXPECTED_DIR" 2>/dev/null || true
mkdir -p "$EXPECTED_DIR"

# Pre-plant a stop-nudged mark in the session state dir.
: > "${EXPECTED_DIR}/${_WS_MARK_STOP_NUDGED}"
[[ -f "${EXPECTED_DIR}/${_WS_MARK_STOP_NUDGED}" ]] || fail "could not pre-plant stop-nudged mark"

# Successful git commit -> nudge mark cleared.
COMMIT_INPUT=$(cat <<EOF
{"session_id":"${SESSION_ID}","tool_name":"Bash","tool_input":{"command":"git commit -m test"},"tool_response":{"exit_code":0}}
EOF
)
cd "$REPO_ROOT"
printf '%s' "$COMMIT_INPUT" | bash "${HOOKS_DIR}/track-workflow-events.sh" \
  || fail "track-workflow-events.sh exited nonzero on successful-commit input"

[[ ! -f "${EXPECTED_DIR}/${_WS_MARK_STOP_NUDGED}" ]] \
  && pass || fail "stop-nudged mark must be cleared after successful git commit"

[[ -f "${EXPECTED_DIR}/${_WS_MARK_COMMIT}" ]] \
  && pass || fail "last-commit mark must be written on successful git commit"

# Failed git commit -> nudge mark preserved.
SESSION_ID="test-failed-commit-preserves-nudge-$$"
EXPECTED_DIR="${REPO_ROOT}/.claude/.workflow-state/${SESSION_ID}"
rm -rf "$EXPECTED_DIR" 2>/dev/null || true
mkdir -p "$EXPECTED_DIR"
: > "${EXPECTED_DIR}/${_WS_MARK_STOP_NUDGED}"

FAILED_COMMIT_INPUT=$(cat <<EOF
{"session_id":"${SESSION_ID}","tool_name":"Bash","tool_input":{"command":"git commit -m test"},"tool_response":{"exit_code":1}}
EOF
)
printf '%s' "$FAILED_COMMIT_INPUT" | bash "${HOOKS_DIR}/track-workflow-events.sh" \
  || fail "track-workflow-events.sh exited nonzero on failed-commit input"

[[ -f "${EXPECTED_DIR}/${_WS_MARK_STOP_NUDGED}" ]] \
  && pass || fail "stop-nudged mark must survive failed git commit"

[[ ! -f "${EXPECTED_DIR}/${_WS_MARK_COMMIT}" ]] \
  && pass || fail "last-commit mark must NOT be written on failed git commit"

# Cleanup test session dirs.
rm -rf "${REPO_ROOT}/.claude/.workflow-state/test-commit-clears-nudge-"* \
       "${REPO_ROOT}/.claude/.workflow-state/test-failed-commit-preserves-nudge-"* 2>/dev/null || true

echo "OK: ${PASS_COUNT} assertions passed."
