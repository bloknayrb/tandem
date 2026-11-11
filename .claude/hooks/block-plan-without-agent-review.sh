#!/usr/bin/env bash
# Thin wrapper. Real logic lives in the .mjs alongside.
# The gate is fail-closed, and only exit 2 blocks a PreToolUse call. So any
# other failure (node missing from PATH is 127, a crash in the .mjs is 1) is
# turned into a block here instead of letting the plan through unchecked.
set -uo pipefail
dir="${0%/*}"
[[ "$dir" == "$0" ]] && dir=. # invoked by bare name: no slash to strip
node "$dir/block-plan-without-agent-review.mjs"
rc=$?
if [[ $rc -ne 0 && $rc -ne 2 ]]; then
  echo "Blocked (fail-closed): the plan-review gate did not finish (exit $rc; 127 means \`node\` is not on PATH, anything else is a crash in the gate, printed above). Tell the user." >&2
  exit 2
fi
exit $rc
