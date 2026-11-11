#!/usr/bin/env bash
# Thin wrapper. Real logic lives in the .mjs alongside.
# The gate is fail-closed, and only exit 2 blocks a PreToolUse call. So any
# other failure (node missing from PATH is 127, a crash in the .mjs is 1) is
# turned into a block here instead of letting the plan through unchecked.
set -uo pipefail
node "${0%/*}/block-plan-without-agent-review.mjs"
rc=$?
if [[ $rc -ne 0 && $rc -ne 2 ]]; then
  echo "Blocked (fail-closed): the plan-review gate could not run (exit $rc). It needs \`node\` on PATH; tell the user." >&2
  exit 2
fi
exit $rc
