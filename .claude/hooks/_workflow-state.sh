#!/usr/bin/env bash
# Shared helpers for workflow-nudge hooks.
# Source this file; do not execute it directly.

# Marker filenames (single source of truth — referenced across multiple hooks).
readonly _WS_MARK_PLAN_WRITE="last-plan-write"
readonly _WS_MARK_SOURCE_EDIT="last-source-edit"
readonly _WS_MARK_AGENT_CALL="last-agent-call"
readonly _WS_MARK_SIMPLIFY="last-simplify"
readonly _WS_MARK_COMMIT="last-commit"
readonly _WS_MARK_STOP_NUDGED="stop-nudged"

# Parse session_id from stdin JSON. Falls back to "pid-$$" if missing so parallel
# sessions without IDs don't share a state dir. Sanitizes the value to a safe
# path segment and refuses leading-dot variants so traversal patterns ("..",
# "../x") can't escape the state root.
_ws_session_id() {
  local input="$1"
  local fallback="pid-${PPID:-$$}"
  printf '%s' "$input" | PID_FALLBACK="$fallback" node -e "
    let d='';
    process.stdin.on('data', c => d += c);
    process.stdin.on('end', () => {
      const fb = process.env.PID_FALLBACK || 'default';
      let s = '';
      try { s = (JSON.parse(d).session_id || ''); } catch {}
      s = String(s).replace(/[^a-zA-Z0-9_-]/g, '_');
      if (!s) s = fb;
      process.stdout.write(s);
    });
  " 2>/dev/null || printf '%s' "$fallback"
}

# Resolve and create the per-session state directory. Echoes its path.
_ws_state_dir() {
  local session_id="$1"
  local dir=".claude/.workflow-state/${session_id}"
  mkdir -p "$dir" 2>/dev/null || true
  printf '%s' "$dir"
}

# Touch a marker file inside the state dir. Optional payload as a third arg.
# Writes via temp+rename so a pre-planted symlink at the marker path can't
# redirect the write outside the state dir.
_ws_mark() {
  local state_dir="$1"
  local name="$2"
  local payload="${3:-}"
  local file="${state_dir}/${name}"
  local tmp="${file}.tmp.$$"
  if [[ -n "$payload" ]]; then
    printf '%s\n' "$payload" > "$tmp" || return 1
  else
    : > "$tmp" || return 1
  fi
  mv -f "$tmp" "$file"
}

# Read a marker payload, or empty if missing.
_ws_payload() {
  local file="${1}/${2}"
  [[ -f "$file" ]] && cat "$file" || printf ''
}

# Return 0 if file $1 exists and is newer than $2 (or $2 is missing).
_ws_newer_than() {
  local a="$1"
  local b="$2"
  [[ -f "$a" ]] || return 1
  [[ ! -f "$b" ]] && return 0
  [[ "$a" -nt "$b" ]]
}

# Echo the mtime of a marker as epoch seconds, or "0" if missing.
_ws_mtime() {
  local file="$1"
  if [[ -f "$file" ]]; then
    stat -c %Y "$file" 2>/dev/null || stat -f %m "$file" 2>/dev/null || printf '0'
  else
    printf '0'
  fi
}

# Return 0 if $1 looks like a real `git commit` invocation (not commit-tree /
# commit-graph) and not just a substring of a quoted message body. Accepts
# pre-`commit` git options like `-C path` or `--no-pager`. Anchors to the
# string start to avoid matching `git commit` inside `-m "..."` text.
_ws_is_git_commit() {
  local cmd="$1"
  [[ "$cmd" =~ ^[[:space:]]*git([[:space:]]+(-[^[:space:]]+|--[^[:space:]=]+(=[^[:space:]]+)?)([[:space:]]+[^-[:space:]][^[:space:]]*)?)*[[:space:]]+commit([[:space:]]|$) ]]
}

# Return 0 if the (forward-slashed) path looks like a source-tree edit:
# under src/ or src-tauri/, not a test, not markdown, not generated.
_ws_is_source_edit() {
  local p="$1"
  [[ -n "$p" ]] || return 1
  [[ "$p" =~ (^|/)src(-tauri)?/ ]] || return 1
  [[ "$p" =~ \.(test|spec)\.[tj]sx?$ ]] && return 1
  [[ "$p" =~ \.md$ ]] && return 1
  [[ "$p" =~ /dist/ ]] && return 1
  [[ "$p" =~ /node_modules/ ]] && return 1
  return 0
}
