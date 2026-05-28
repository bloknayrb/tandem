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
# field values are replaced with SOH (0x01) so each field stays on one line --
# downstream only needs prefix matches, never the embedded newlines.
#
# Prefer jq (no interpreter cold-start) and fall back to node when jq is absent
# so contributors without jq aren't broken. Both emit the same five fields in
# the same order, newline-joined: tool_name, file_path (\\ -> /), skill,
# command, exit_code.
if command -v jq >/dev/null 2>&1; then
  # esc replaces embedded newlines with SOH (\u0001), matching the node parser;
  # the file_path branch additionally maps \\ -> / before the newline pass.
  # exit_code mirrors node exactly: prefer .exit_code if it is a number, else
  # .exitCode if it is a number, else "" -- per-field number test (not `//`)
  # avoids picking a non-numeric .exit_code over a numeric .exitCode.
  EXTRACTED=$(printf '%s' "$INPUT" | jq -j '
    def esc: (. // "" | tostring | gsub("\n";"\u0001"));
    def numstr: if type == "number" then tostring else "" end;
    [ (.tool_name | esc),
      ((.tool_input.file_path // "" | tostring | gsub("\\\\";"/")) | gsub("\n";"\u0001")),
      (.tool_input.skill | esc),
      (.tool_input.command | esc),
      (if (.tool_response.exit_code | numstr) != ""
         then (.tool_response.exit_code | numstr)
         else (.tool_response.exitCode | numstr) end)
    ] | join("\n")
  ' 2>/dev/null) || exit 0
else
  # Fallback parser when jq is unavailable. Identical field contract.
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
fi

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
