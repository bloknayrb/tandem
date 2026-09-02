#!/bin/sh
# Scratch server on the review's scratch port pair (4918/4919), gate ARMED, isolated app-data dir.
# Never 3478/3479 (the product) and never the E2E harness pair (scripts/test-ports.ts).
ROOT="$(cd "$(dirname "$0")/../../../../.." && pwd)"
DATA="${TMPDIR:-/tmp}/tandem-review-probe/data"
mkdir -p "$DATA"
cd "$ROOT"
exec env TANDEM_LICENSE_GATE=1 TANDEM_PORT=4918 TANDEM_MCP_PORT=4919 TANDEM_APP_DATA_DIR="$DATA" npx tsx src/server/index.ts
