/**
 * Helpers shared by CLI stdio entry points (`mcp-stdio`, `channel`) and the
 * standalone server / monitor binaries that all speak MCP over stdout.
 */

import { DEFAULT_MCP_PORT } from "./constants.js";

/**
 * In stdio MCP mode, stdout is the JSON-RPC wire — any stray library write
 * corrupts the protocol. Redirect `console.log/warn/info` to stderr so
 * incidental logging is safe. Callers that also run in-process tests (e.g.
 * `src/monitor/index.ts`) can gate this behind `!process.env.VITEST`.
 */
export function redirectConsoleToStderr(): void {
  console.log = console.error;
  console.warn = console.error;
  console.info = console.error;
}

/**
 * Resolve the Tandem HTTP base URL used by stdio subcommands. Precedence is
 * (1) explicit override, (2) `TANDEM_URL` env var, (3) the default port on
 * localhost. The returned string has no trailing slash so callers can
 * concatenate `/health`, `/mcp`, etc. without double-slash.
 */
export function resolveTandemUrl(override?: string): string {
  const raw = override ?? process.env.TANDEM_URL ?? `http://localhost:${DEFAULT_MCP_PORT}`;
  return raw.replace(/\/$/, "");
}
