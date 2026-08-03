#!/usr/bin/env bash
# SessionStart hook.
# Prunes workflow-state directories older than 7 days so the dir stays bounded.

set -uo pipefail
trap 'exit 0' ERR

STATE_ROOT=".claude/.workflow-state"
[[ -d "$STATE_ROOT" ]] || exit 0

find "$STATE_ROOT" -maxdepth 1 -mindepth 1 -type d -mtime +7 -exec rm -rf {} + 2>/dev/null || true

exit 0
