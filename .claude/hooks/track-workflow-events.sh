#!/usr/bin/env bash
# PostToolUse hook (unmatched — runs on every tool).
# Records workflow state markers used by nudge hooks.
# Hot path: fires on every tool call. Pre-filter with a bash regex before
# spawning node so 90% of tool calls (Read/Grep/Glob/LS/etc.) exit immediately.

set -uo pipefail
trap 'exit 0' ERR

# shellcheck source=_workflow-state.sh
source "$(dirname "$0")/_workflow-state.sh"

INPUT=$(cat)

# Fast path: short-circuit for tools we don't track. Avoids node spawn (~50ms
# on Windows) for the vast majority of tool calls.
if [[ ! "$INPUT" =~ \"tool_name\"[[:space:]]*:[[:space:]]*\"(Edit|Write|Agent|Task|Skill|Bash)\" ]]; then
  exit 0
fi

SESSION_ID=$(_ws_session_id "$INPUT")
STATE_DIR=$(_ws_state_dir "$SESSION_ID")

# Newline-delimited extraction (NOT null-delimited: command substitution
# strips NULs and collapses every field into the first slot). Newlines inside
# field values are stripped — we only need prefix matches downstream.
EXTRACTED=$(printf '%s' "$INPUT" | node -e "
  let d='';
  process.stdin.on('data', c => d += c);
  process.stdin.on('end', () => {
    try {
      const e = JSON.parse(d);
      const tr = e.tool_response;
      let ec = '';
      if (tr && typeof tr === 'object') {
        if (typeof tr.exit_code === 'number') ec = String(tr.exit_code);
        else if (typeof tr.exitCode === 'number') ec = String(tr.exitCode);
      }
      const fp = ((e.tool_input && e.tool_input.file_path) || '').replace(/\\\\/g, '/');
      const esc = v => String(v == null ? '' : v).replace(/\n/g, '');
      process.stdout.write([
        esc(e.tool_name || ''),
        esc(fp),
        esc((e.tool_input && e.tool_input.skill) || ''),
        esc((e.tool_input && e.tool_input.command) || ''),
        esc(ec),
      ].join('\n'));
    } catch { process.stdout.write(['','','','',''].join('\n')); }
  });
" 2>/dev/null) || exit 0

mapfile -t FIELDS <<< "$EXTRACTED"
TOOL_NAME="${FIELDS[0]:-}"
FILE_PATH="${FIELDS[1]:-}"
SKILL_NAME="${FIELDS[2]:-}"
COMMAND="${FIELDS[3]:-}"
EXIT_CODE="${FIELDS[4]:-}"

case "$TOOL_NAME" in
  Edit|Write)
    if [[ "$FILE_PATH" =~ (^|/)\.claude/plans/.+\.md$ ]]; then
      _ws_mark "$STATE_DIR" "$_WS_MARK_PLAN_WRITE" "$FILE_PATH"
    fi
    if _ws_is_source_edit "$FILE_PATH"; then
      _ws_mark "$STATE_DIR" "$_WS_MARK_SOURCE_EDIT" "$FILE_PATH"
    fi
    ;;
  Agent|Task)
    _ws_mark "$STATE_DIR" "$_WS_MARK_AGENT_CALL"
    ;;
  Skill)
    if [[ "$SKILL_NAME" == "simplify" || "$SKILL_NAME" == *":simplify" ]]; then
      _ws_mark "$STATE_DIR" "$_WS_MARK_SIMPLIFY"
    fi
    ;;
  Bash)
    if _ws_is_git_commit "$COMMAND" && [[ "${EXIT_CODE:-1}" == "0" ]]; then
      _ws_mark "$STATE_DIR" "$_WS_MARK_COMMIT"
      # Clear stop-nudged so the next post-commit edit cycle re-fires the
      # reminder. Without this, stop-cycle-check.sh's per-session early-return
      # short-circuits forever after the first nudge.
      rm -f "${STATE_DIR}/${_WS_MARK_STOP_NUDGED}" 2>/dev/null || true
      # Surface systemic clear-failure (Windows file lock, AV scanner) to
      # stderr so it's visible in hook logs without escalating to a hard fail.
      if [[ -f "${STATE_DIR}/${_WS_MARK_STOP_NUDGED}" ]]; then
        echo "warn: stop-nudged mark survived commit clear at $(date -Iseconds 2>/dev/null || date)" >&2
      fi
    fi
    ;;
esac

exit 0
