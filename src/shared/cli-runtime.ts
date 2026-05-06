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
 * Blank values are treated as absent so a blank plugin option does not mask an
 * explicit TANDEM_URL or the localhost default.
 * The returned string has no trailing slash so callers can concatenate
 * `/health`, `/mcp`, etc. without double-slash. One or more trailing slashes
 * are stripped, so both `http://x/` and `http://x//` resolve to `http://x`.
 */
export function resolveTandemUrl(override?: string): string {
  return resolveTandemUrlCandidate(override).replace(/\/+$/, "");
}

function resolveTandemUrlCandidate(override?: string): string {
  const candidates = [
    override,
    process.env.CLAUDE_PLUGIN_OPTION_SERVER_URL,
    process.env.TANDEM_URL,
  ];
  for (const url of candidates) {
    if (url !== undefined && url.trim() !== "") return url.trim();
  }
  return `http://localhost:${DEFAULT_MCP_PORT}`;
}

/**
 * Resolve the Tandem auth token. Precedence:
 * (1) explicit override (programmatic, e.g. from tests)
 * (2) CLAUDE_PLUGIN_OPTION_AUTH_TOKEN — injected by plugin host from userConfig
 * (3) TANDEM_AUTH_TOKEN — explicit env override
 * Blank values are treated as absent so a blank plugin option does not mask an
 * explicit TANDEM_AUTH_TOKEN. Returns undefined when all absent (loopback mode,
 * no Authorization header sent).
 */
export function resolveAuthToken(override?: string): string | undefined {
  return resolveAuthTokenCandidate(override).token;
}

export type AuthTokenSource =
  | "explicit override"
  | "CLAUDE_PLUGIN_OPTION_AUTH_TOKEN"
  | "TANDEM_AUTH_TOKEN";

export function resolveAuthTokenCandidate(
  override?: string,
): { token: string; source: AuthTokenSource } | { token: undefined; source: undefined } {
  const candidates: Array<[AuthTokenSource, string | undefined]> = [
    ["explicit override", override],
    ["CLAUDE_PLUGIN_OPTION_AUTH_TOKEN", process.env.CLAUDE_PLUGIN_OPTION_AUTH_TOKEN],
    ["TANDEM_AUTH_TOKEN", process.env.TANDEM_AUTH_TOKEN],
  ];
  for (const [source, token] of candidates) {
    if (token !== undefined && token.trim() !== "") return { token, source };
  }
  return { token: undefined, source: undefined };
}

/** Regex for a valid Tandem auth token (32+ URL-safe alphanumeric chars). */
const VALID_TOKEN_RE = /^[A-Za-z0-9_\-]{32,}$/;

/** Guard so we only warn once per process (not on every SSE reconnect). */
let _warnedInvalidToken = false;

/**
 * Fetch wrapper that automatically injects `Authorization: Bearer <token>`
 * when a resolved Tandem auth token is set and valid.
 *
 * This is the forgiving variant — used by monitor/channel which may run in
 * loopback-only mode without a token. Invalid or absent tokens are silently
 * ignored (no exit-1). The strict validation lives in mcp-stdio.ts only.
 * When the token is set but fails validation, a one-time warning is emitted
 * so operators know why auth headers are absent.
 */
export async function authFetch(url: string, init?: RequestInit): Promise<Response> {
  const { token, source } = resolveAuthTokenCandidate();
  if (token !== undefined) {
    const trimmed = token.trim();
    if (VALID_TOKEN_RE.test(trimmed)) {
      const headers = new Headers(init?.headers);
      headers.set("Authorization", `Bearer ${trimmed}`);
      return fetch(url, { ...init, headers });
    }
    // Token is set but invalid — warn once so operators know why auth fails
    if (!_warnedInvalidToken) {
      _warnedInvalidToken = true;
      console.error(
        `[tandem] authFetch: ${source} is set but invalid (must be 32+ alphanumeric chars [A-Za-z0-9_-]); sending without Authorization header`,
      );
    }
  }
  return fetch(url, init);
}
