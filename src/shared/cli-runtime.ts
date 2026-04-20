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

/** Regex for a valid Tandem auth token (32+ URL-safe alphanumeric chars). */
const VALID_TOKEN_RE = /^[A-Za-z0-9_\-]{32,}$/;

/**
 * Fetch wrapper that automatically injects `Authorization: Bearer <token>`
 * when TANDEM_AUTH_TOKEN is set and valid.
 *
 * This is the forgiving variant — used by monitor/channel which may run in
 * loopback-only mode without a token. Invalid or absent tokens are silently
 * ignored (no exit-1). The strict validation lives in mcp-stdio.ts only.
 */
export async function authFetch(url: string, init?: RequestInit): Promise<Response> {
  const token = process.env.TANDEM_AUTH_TOKEN;
  if (token && VALID_TOKEN_RE.test(token)) {
    const headers = new Headers(init?.headers);
    headers.set("Authorization", `Bearer ${token}`);
    return fetch(url, { ...init, headers });
  }
  return fetch(url, init);
}
