#!/usr/bin/env bash
# Thin wrapper. Real logic lives in the .mjs alongside.
set -uo pipefail
exec node "$(dirname "$0")/block-plan-without-agent-review.mjs"
