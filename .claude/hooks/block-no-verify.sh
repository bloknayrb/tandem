#!/usr/bin/env bash
# PreToolUse hook: block Bash commands that skip Husky hooks
# Exit code 2 = block the tool call
#
# The reason goes to STDERR. On a PreToolUse exit 2 Claude Code shows the model
# stderr only, so a reason echoed to stdout blocks the call and explains nothing.

set -uo pipefail

INPUT=$(cat)
COMMAND=$(printf '%s' "$INPUT" | node -e "
  let d='';
  process.stdin.on('data', c => d += c);
  process.stdin.on('end', () => {
    try {
      const e = JSON.parse(d);
      const c = e.tool_input?.command || '';
      process.stdout.write(c);
    } catch {
      process.stderr.write('Hook: failed to parse tool input\n');
      process.exit(1);
    }
  });
" 2>/dev/null) || {
  {
    echo "Blocked (block-no-verify.sh, fail-closed): could not read the command from the hook input."
    echo "It needs \`node\` on PATH and a JSON tool input whose command is a string. If node is missing, every Bash call is blocked until it is back; tell the user."
  } >&2
  exit 2
}

if [[ -n "$COMMAND" && "$COMMAND" =~ --no-verify ]]; then
  {
    echo "Blocked (block-no-verify.sh): this command contains the text --no-verify, which skips the Husky hooks."
    echo "If a Husky hook is failing, fix what it reports instead of bypassing it."
    echo "The match is on the whole command text, so a commit message or PR body that only mentions the flag is blocked too."
    echo "For that case, write the text to a file with the Write tool (a heredoc is a command and is blocked too), then pass the file: git commit -F <file>, gh pr create --body-file <file>."
  } >&2
  exit 2
fi
