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
 * Resolve the Tandem HTTP base URL used by stdio subcommands. Precedence:
 * (1) explicit override (programmatic, e.g. from tests)
 * (2) CLAUDE_PLUGIN_OPTION_SERVER_URL — injected by plugin host from userConfig
 * (3) TANDEM_URL — explicit env override
 * (4) localhost default
 * The returned string has no trailing slash so callers can concatenate
 * `/health`, `/mcp`, etc. without double-slash.
 */
export function resolveTandemUrl(override?: string): string {
  const raw =
    override ??
    process.env.CLAUDE_PLUGIN_OPTION_SERVER_URL ??
    process.env.TANDEM_URL ??
    `http://localhost:${DEFAULT_MCP_PORT}`;
  return raw.replace(/\/$/, "");
}

/**
 * Resolve the Tandem auth token. Precedence:
 * (1) explicit override (programmatic, e.g. from tests)
 * (2) CLAUDE_PLUGIN_OPTION_AUTH_TOKEN — injected by plugin host from userConfig
 * (3) TANDEM_AUTH_TOKEN — explicit env override
 * Returns undefined when all absent (loopback mode, no Authorization header sent).
 */
export function resolveAuthToken(override?: string): string | undefined {
  return override ?? process.env.CLAUDE_PLUGIN_OPTION_AUTH_TOKEN ?? process.env.TANDEM_AUTH_TOKEN;
}

/** Regex for a valid Tandem auth token (32+ URL-safe alphanumeric chars). */
const VALID_TOKEN_RE = /^[A-Za-z0-9_\-]{32,}$/;

/** Guard so we only warn once per process (not on every SSE reconnect). */
let _warnedInvalidToken = false;

/**
 * Fetch wrapper that automatically injects `Authorization: Bearer <token>`
 * when TANDEM_AUTH_TOKEN is set and valid.
 *
 * This is the forgiving variant — used by monitor/channel which may run in
 * loopback-only mode without a token. Invalid or absent tokens are silently
 * ignored (no exit-1). The strict validation lives in mcp-stdio.ts only.
 * When the token is set but fails validation, a one-time warning is emitted
 * so operators know why auth headers are absent.
 */
export async function authFetch(url: string, init?: RequestInit): Promise<Response> {
  const token = resolveAuthToken();
  if (token !== undefined && token.trim() !== "") {
    if (VALID_TOKEN_RE.test(token.trim())) {
      const headers = new Headers(init?.headers);
      headers.set("Authorization", `Bearer ${token.trim()}`);
      return fetch(url, { ...init, headers });
    }
    // Token is set but invalid — warn once so operators know why auth fails
    if (!_warnedInvalidToken) {
      _warnedInvalidToken = true;
      console.error(
        "[tandem] authFetch: TANDEM_AUTH_TOKEN is set but invalid (must be 32+ alphanumeric chars [A-Za-z0-9_-]); sending without Authorization header",
      );
    }
  }
  return fetch(url, init);
}
