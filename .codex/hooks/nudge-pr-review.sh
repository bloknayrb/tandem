#!/usr/bin/env bash
# PostToolUse hook (Bash).
# After a successful `gh pr create`, nudge to run /pr-review-toolkit:review-pr.

set -uo pipefail
trap 'exit 0' ERR

INPUT=$(cat)

# Fast path: only consider Bash tool calls. Avoids matching commit-message
# bodies that happen to mention "gh pr create" in unrelated tool payloads.
[[ "$INPUT" =~ \"tool_name\"[[:space:]]*:[[:space:]]*\"Bash\" ]] || exit 0

EXTRACTED=$(printf '%s' "$INPUT" | node -e "
  let d='';
  process.stdin.on('data', c => d += c);
  process.stdin.on('end', () => {
    try {
      const e = JSON.parse(d);
      const cmd = ((e.tool_input && e.tool_input.command) || '').replace(/\n/g, ' ');
      const tr = e.tool_response;
      let ec = '';
      if (tr && typeof tr === 'object') {
        if (typeof tr.exit_code === 'number') ec = String(tr.exit_code);
        else if (typeof tr.exitCode === 'number') ec = String(tr.exitCode);
      }
      process.stdout.write(cmd + '\n' + ec);
    } catch { process.stdout.write('\n'); }
  });
" 2>/dev/null) || exit 0

mapfile -t FIELDS <<< "$EXTRACTED"
COMMAND="${FIELDS[0]:-}"
EXIT_CODE="${FIELDS[1]:-}"

# Anchor to start of command so a commit message containing "gh pr create"
# doesn't trigger the nudge.
[[ "$COMMAND" =~ ^[[:space:]]*gh[[:space:]]+pr[[:space:]]+create([[:space:]]|$) ]] || exit 0

# Only fire on success. If exit code is unknown, fire anyway (best effort).
if [[ -n "$EXIT_CODE" && "$EXIT_CODE" != "0" ]]; then
  exit 0
fi

cat >&2 <<'EOF'
✓ PR opened. Next step per CLAUDE.md workflow: /pr-review-toolkit:review-pr.
   When review feedback lands, plan the fixes and have agents review the plan before implementing.
EOF

exit 0
