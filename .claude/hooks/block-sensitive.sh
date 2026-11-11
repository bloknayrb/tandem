#!/usr/bin/env bash
# PreToolUse hook: block edits to paths ending in .env or package-lock.json
# (only those two suffixes: .env.local, .env.example and Cargo.lock pass)
# Exit code 2 = block the tool call
#
# The reason goes to STDERR. On a PreToolUse exit 2 Claude Code shows the model
# stderr only, so a reason echoed to stdout blocks the call and explains nothing.

set -euo pipefail

INPUT=$(cat)
FILE_PATH=$(echo "$INPUT" | node -e "
  let d='';
  process.stdin.on('data', c => d += c);
  process.stdin.on('end', () => {
    try {
      const e = JSON.parse(d);
      const f = e.tool_input?.file_path || e.tool_input?.command || '';
      process.stdout.write(f);
    } catch { process.exit(0); }
  });
")

if [[ -n "$FILE_PATH" && "$FILE_PATH" =~ (\.env|package-lock\.json)$ ]]; then
  {
    echo "Blocked (block-sensitive.sh): refusing to edit $FILE_PATH with Edit or Write."
    if [[ "$FILE_PATH" =~ package-lock\.json$ ]]; then
      echo "package-lock.json is generated. Change package.json, then regenerate it: npm install --package-lock-only"
      echo "A merge conflict in it is resolved the same way: take either side whole (git checkout --ours or --theirs -- package-lock.json), then regenerate."
    else
      echo ".env holds local secrets. Ask the user to make the change, or tell them the line to add."
    fi
  } >&2 || true # under `set -e` a failed write must not exit 1 before the block
  exit 2
fi
