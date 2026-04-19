#!/usr/bin/env node
/**
 * Tandem Channel Shim — standalone binary entry.
 *
 * Claude Code / Claude Desktop spawns this as a subprocess per the
 * `tandem-channel` MCP server entry. Actual runtime lives in ./run.ts so
 * the CLI (`tandem channel`) can share it.
 */

import { runChannel } from "./run.js";

process.once("uncaughtException", (err: unknown) => {
  const msg = err instanceof Error ? (err.stack ?? err.message) : String(err);
  try {
    process.stderr.write(`[tandem channel] uncaughtException: ${msg}\n`);
  } catch {
    /* EPIPE */
  }
  process.exit(1);
});
process.once("unhandledRejection", (reason: unknown) => {
  const detail = reason instanceof Error ? reason.message : String(reason);
  process.stderr.write(`[tandem channel] unhandledRejection: ${detail}\n`);
  process.exit(1);
});

runChannel().catch((err) => {
  console.error("[Channel] Fatal error:", err);
  process.exit(1);
});
