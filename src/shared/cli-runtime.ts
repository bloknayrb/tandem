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
 * (4) 127.0.0.1 default (apiMiddleware narrowed out bare 'localhost' in PR #477 PR 2)
 * Blank values are treated as absent so a blank plugin option does not mask an
 * explicit TANDEM_URL or the 127.0.0.1 default.
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
  return `http://127.0.0.1:${DEFAULT_MCP_PORT}`;
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
 * Header carrying the Claude Code session id on stdio-shim → Tandem-server
 * requests. Lets the server correlate channel traffic (replies, awareness,
 * error reports) with the originating Claude Code session for multi-session
 * disambiguation and diagnostics. Read-only metadata: routes that don't
 * consume it ignore the header, so no server-route schema change is required.
 */
export const CLAUDE_SESSION_HEADER = "X-Claude-Session-Id";

/**
 * Bound on the session-id length we forward. Claude Code sets a UUID
 * (the same `session_id` passed to hooks; CHANGELOG 2.1.157 / 2.1.163), but we
 * treat the value as opaque and only guard against an oversized header line.
 */
const MAX_SESSION_ID_LEN = 256;

/**
 * Printable-ASCII guard. A stray CR/LF (or other control char) would split the
 * header line — reject anything outside `\x21`–`\x7e`. The length bound is
 * enforced separately against MAX_SESSION_ID_LEN so there's one source of truth.
 */
const SESSION_ID_RE = /^[\x21-\x7e]+$/;

/**
 * Normalize and validate a candidate Claude session id, returning `undefined`
 * when it fails the guards.
 *
 * Shared by the *sending* side (`resolveClaudeSessionId`, reading the env var)
 * and the *receiving* side (the Tandem server, reading the header off the
 * wire). Both ends must agree: this is a header-injection guard, and a sender
 * and receiver that drift apart on what counts as valid is exactly how such a
 * guard silently stops guarding. Keep it as the single definition rather than
 * re-inlining the length bound and regex at either end.
 */
export function normalizeSessionId(raw: unknown): string | undefined {
  if (typeof raw !== "string") return undefined;
  const trimmed = raw.trim();
  if (trimmed === "" || trimmed.length > MAX_SESSION_ID_LEN) return undefined;
  if (!SESSION_ID_RE.test(trimmed)) return undefined;
  return trimmed;
}

/**
 * Resolve the Claude Code session id from the process environment.
 *
 * Claude Code injects `CLAUDE_CODE_SESSION_ID` (and `CLAUDECODE=1`) into the
 * environment of the stdio MCP server subprocesses it spawns — the Tandem
 * channel shim and stdio proxy are exactly such subprocesses (Claude Code
 * CHANGELOG 2.1.157; also forwarded on `--resume` since 2.1.163). The value
 * mirrors the `session_id` passed to hooks/Bash (a UUID).
 *
 * Returns `undefined` when the launch is not a Claude Code session
 * (`CLAUDECODE !== "1"` — so a value a user happened to export in their own
 * shell is never forwarded), the var is unset/blank, or it fails the
 * printable-ASCII length guard. Whitespace is trimmed and the value is
 * length-bounded so it can be forwarded as an HTTP header without
 * header-injection or oversize risk.
 */
export function resolveClaudeSessionId(): string | undefined {
  // Only trust the id inside an actual Claude Code launch. `CLAUDECODE=1` is
  // set alongside CLAUDE_CODE_SESSION_ID by the same CLI release; gating on it
  // avoids forwarding a value a user happened to export in their own shell.
  if (process.env.CLAUDECODE !== "1") return undefined;
  return normalizeSessionId(process.env.CLAUDE_CODE_SESSION_ID);
}

/**
 * Merge the resolved Claude session id (if any) into a `HeadersInit` as the
 * `X-Claude-Session-Id` header. No-op when no session id is resolvable, so
 * callers can wrap every outbound request unconditionally.
 */
export function withClaudeSessionHeader(init?: RequestInit["headers"]): Headers {
  const headers = new Headers(init);
  const sessionId = resolveClaudeSessionId();
  if (sessionId !== undefined) headers.set(CLAUDE_SESSION_HEADER, sessionId);
  return headers;
}

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
  return fetch(url, { ...init, headers });
}
