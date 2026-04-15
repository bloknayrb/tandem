#!/usr/bin/env node
/**
 * Tandem Channel Shim — standalone binary entry.
 *
 * Claude Code / Claude Desktop spawns this as a subprocess per the
 * `tandem-channel` MCP server entry. Actual runtime lives in ./run.ts so
 * the CLI (`tandem channel`) can share it.
 */

import { runChannel } from "./run.js";

runChannel().catch((err) => {
  console.error("[Channel] Fatal error:", err);
  process.exit(1);
});
