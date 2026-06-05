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

# -----------------------------------------------------------------------------
# stop-cycle-check.sh: reminder injected as STDOUT hookSpecificOutput JSON
# -----------------------------------------------------------------------------

STOP_HOOK="${HOOKS_DIR}/stop-cycle-check.sh"
HAS_JQ=0
command -v jq >/dev/null 2>&1 && HAS_JQ=1

# Pending source edits, not yet nudged -> emit additionalContext JSON on stdout.
SESSION_ID="test-stop-pending-$$"
EXPECTED_DIR="${REPO_ROOT}/.claude/.workflow-state/${SESSION_ID}"
rm -rf "$EXPECTED_DIR" 2>/dev/null || true
mkdir -p "$EXPECTED_DIR"
: > "${EXPECTED_DIR}/${_WS_MARK_SOURCE_EDIT}"

STOP_OUT=$(printf '{"session_id":"%s"}' "$SESSION_ID" | bash "$STOP_HOOK")
STOP_RC=$?
[[ "$STOP_RC" -eq 0 ]] && pass || fail "stop hook must exit 0 on pending-edits path"

if [[ "$HAS_JQ" -eq 1 ]]; then
  printf '%s' "$STOP_OUT" | jq -e '.hookSpecificOutput.hookEventName == "Stop"' >/dev/null \
    && pass || fail "stop hook stdout must be JSON with hookSpecificOutput.hookEventName == Stop"
  printf '%s' "$STOP_OUT" \
    | jq -e '(.hookSpecificOutput.additionalContext | type == "string") and (.hookSpecificOutput.additionalContext | length > 0)' >/dev/null \
    && pass || fail "stop hook must emit a non-empty additionalContext string"
else
  # No jq -> the hook falls back to stderr and stdout stays empty.
  [[ -z "$STOP_OUT" ]] && pass || fail "stop hook stdout must be empty when jq is unavailable"
fi

# Re-running the same session is a no-op: stop-nudged mark is now present.
STOP_OUT2=$(printf '{"session_id":"%s"}' "$SESSION_ID" | bash "$STOP_HOOK")
STOP_RC2=$?
[[ "$STOP_RC2" -eq 0 && -z "$STOP_OUT2" ]] \
  && pass || fail "stop hook must emit nothing and exit 0 once already nudged"

# No pending edits (no source-edit marker) -> emit nothing, exit 0.
SESSION_ID="test-stop-clean-$$"
EXPECTED_DIR="${REPO_ROOT}/.claude/.workflow-state/${SESSION_ID}"
rm -rf "$EXPECTED_DIR" 2>/dev/null || true
mkdir -p "$EXPECTED_DIR"
STOP_OUT3=$(printf '{"session_id":"%s"}' "$SESSION_ID" | bash "$STOP_HOOK")
STOP_RC3=$?
[[ "$STOP_RC3" -eq 0 && -z "$STOP_OUT3" ]] \
  && pass || fail "stop hook must emit nothing and exit 0 with no pending edits"

# Committed after edit (commit newer than edit) -> emit nothing, exit 0.
SESSION_ID="test-stop-committed-$$"
EXPECTED_DIR="${REPO_ROOT}/.claude/.workflow-state/${SESSION_ID}"
rm -rf "$EXPECTED_DIR" 2>/dev/null || true
mkdir -p "$EXPECTED_DIR"
: > "${EXPECTED_DIR}/${_WS_MARK_SOURCE_EDIT}"
sleep 1
: > "${EXPECTED_DIR}/${_WS_MARK_COMMIT}"
STOP_OUT4=$(printf '{"session_id":"%s"}' "$SESSION_ID" | bash "$STOP_HOOK")
STOP_RC4=$?
[[ "$STOP_RC4" -eq 0 && -z "$STOP_OUT4" ]] \
  && pass || fail "stop hook must emit nothing when a commit is newer than the edit"

rm -rf "${REPO_ROOT}/.claude/.workflow-state/test-stop-"* 2>/dev/null || true

echo "OK: ${PASS_COUNT} assertions passed."
