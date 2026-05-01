/**
 * Shared fetch-with-timeout helper.
 *
 * Used by `src/monitor/index.ts` and `src/channel/` (event-bridge + run) to
 * give every outbound HTTP call a bounded deadline. Without this, a half-open
 * upstream wedges the caller silently — see #336 (silent failures) and #364
 * (event-bridge transport timeout symmetry).
 *
 * Pure native `fetch` + `AbortSignal.timeout` so it can be imported from any
 * surface without dragging in server deps. Routes through `authFetch` so the
 * `TANDEM_AUTH_TOKEN` header is forwarded automatically when set.
 *
 * `describeFetchError` formats timeout aborts as `<endpoint> timed out after
 * <ms>ms` so logs name the hung endpoint instead of the generic
 * "operation was aborted" string from AbortError/TimeoutError.
 */

import { authFetch } from "./cli-runtime.js";

/**
 * Fetch with a per-request deadline.
 *
 * **Do not use for SSE handshake-then-stream patterns** — applying a fetch-level
 * timeout to a streaming response also aborts the body `ReadableStream` when
 * the timeout fires, killing the stream at `timeoutMs`. Use a local
 * `AbortController` cleared after the handshake settles for that case.
 */
export async function fetchWithTimeout(
  url: string,
  init: RequestInit,
  timeoutMs: number,
): Promise<Response> {
  const signal = AbortSignal.timeout(timeoutMs);
  return authFetch(url, { ...init, signal });
}

/**
 * Format a fetch error for logs. Recognizes `TimeoutError` / `AbortError`
 * (both names that `AbortSignal.timeout` and manual aborts produce) and tags
 * them with the endpoint + threshold so log lines name the hung request.
 */
export function describeFetchError(err: unknown, endpoint: string, timeoutMs: number): string {
  if (err instanceof Error && (err.name === "TimeoutError" || err.name === "AbortError")) {
    return `${endpoint} timed out after ${timeoutMs}ms`;
  }
  return err instanceof Error ? err.message : String(err);
}

/** True iff `err` is an AbortError or TimeoutError (the names produced by
 *  AbortSignal.timeout and manual aborts). Channel callers re-throw these
 *  through broad catches so timeouts surface as structured errors instead of
 *  being swallowed as "non-JSON response" fake-success. */
export function isAbortOrTimeoutError(err: unknown): boolean {
  return err instanceof Error && (err.name === "TimeoutError" || err.name === "AbortError");
}
