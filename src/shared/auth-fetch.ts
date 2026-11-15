/**
 * `authFetch`: the token-carrying request every Tandem helper program makes to
 * the local server.
 *
 * Its own module, not part of `cli-runtime.ts`, so that the server bundle
 * (which imports `cli-runtime` for its constants) does not pull `undici` in
 * through `loopback-fetch` (#2422). Only the programs that make the request
 * import this file.
 */

import {
  resolveAuthTokenCandidate,
  VALID_TOKEN_RE,
  withClaudeSessionHeader,
} from "./cli-runtime.js";
import { loopbackFetch } from "./loopback-fetch.js";

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
  // Always attach the Claude session header (no-op when not resolvable) so the
  // server can correlate channel traffic with the originating Claude session,
  // independent of whether an auth token is configured.
  const headers = withClaudeSessionHeader(init?.headers);
  const { token, source } = resolveAuthTokenCandidate();
  if (token !== undefined) {
    const trimmed = token.trim();
    if (VALID_TOKEN_RE.test(trimmed)) {
      headers.set("Authorization", `Bearer ${trimmed}`);
      return loopbackFetch(url, { ...init, headers });
    }
    // Token is set but invalid — warn once so operators know why auth fails
    if (!_warnedInvalidToken) {
      _warnedInvalidToken = true;
      console.error(
        `[tandem] authFetch: ${source} is set but invalid (must be 32+ alphanumeric chars [A-Za-z0-9_-]); sending without Authorization header`,
      );
    }
  }
  return loopbackFetch(url, { ...init, headers });
}
