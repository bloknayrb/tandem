#!/bin/sh
# Same as run.sh but gate DARK and against the built server (npm run build:server first) so the static layer is mounted.
ROOT="$(cd "$(dirname "$0")/../../../../.." && pwd)"
DATA="${TMPDIR:-/tmp}/tandem-review-probe/data2"
mkdir -p "$DATA"
cd "$ROOT"
exec env TANDEM_PORT=4918 TANDEM_MCP_PORT=4919 TANDEM_APP_DATA_DIR="$DATA" node dist/server/index.js
