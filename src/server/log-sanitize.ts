/**
 * Render an untrusted string safe to interpolate into an operator log line.
 *
 * `console.*` all redirect to stderr (Critical Rule 3 — stdout is the MCP
 * wire), so every one of these lines lands in the operator's TERMINAL.
 * Unstripped, an ESC/OSC-0 sequence retitles that terminal and a bare LF forges
 * a whole log line.
 *
 * Two callers, reached by different peers:
 *
 * - `mcp/channel-routes.ts` logs request-body fields. The whole
 *   `/api/channel-*` family is carved out of `enforceLoopbackMutation` in
 *   `NON_LOOPBACK_ALLOWED` (`api-routes.ts`), because the shim and the plugin
 *   monitor run against a non-loopback `TANDEM_URL` — so under a Cowork bind a
 *   bearer-authenticated LAN peer writes straight into that terminal.
 * - `yjs/provider.ts` logs the rejected `origin` and generation `token` of a
 *   refused WebSocket peer. Hocuspocus always binds 127.0.0.1, so that one is
 *   loopback-only — but it is reached BEFORE authentication, and `origin`/
 *   `token` are whatever the peer put on the wire. Eight characters of `token`
 *   are enough for a complete escape (`ESC ]0;x BEL` is six).
 *
 * **Total before it strips.** Two channel call sites pass a field with no type
 * guard at all (`message` and `error` on `/api/channel-error`), and
 * `String(value)` *throws* on a JSON-craftable object: `String(JSON.parse(
 * '{"toString":1,"valueOf":2}'))` is a `TypeError`. That throw would happen in
 * an outer-app route handler, and although `startMcpServerHttp` now registers a
 * JSON error handler on the outer app too, the response it produces is still an
 * error the caller provoked. The `try`/`catch` is what stops that; it is not
 * defensive decoration.
 *
 * Modelled on `stripControlChars` (`src/client/utils/diagnostics.ts`) and
 * deliberately NOT imported from it: `src/server` imports nothing from
 * `src/client` today, and this copy also strips LF, CR and TAB, which that one
 * keeps — a bare LF is the line-forging half of this finding.
 *
 * Lives here rather than in `mcp/channel-routes.ts` (where it was introduced)
 * because `yjs/provider.ts` importing from an MCP route module would be a
 * dependency edge in the wrong direction; `provider.ts` is imported BY
 * `channel-routes.ts`.
 */

/**
 * Characters kept from any untrusted field written to the operator's log.
 *
 * Exported so the specs clamp against the real bound rather than a copy of it.
 */
export const LOG_FIELD_MAX = 200;

/** Strip control characters and bidi overrides, then clamp to `LOG_FIELD_MAX`. */
export function sanitizeForLog(value: unknown): string {
  let s: string;
  try {
    s = typeof value === "string" ? value : String(value);
  } catch {
    // A body object whose `toString` and `valueOf` are both non-callable.
    return "[unstringifiable]";
  }
  const stripped = s
    // C0 (LF, CR and TAB included), DEL and C1 — the escape-sequence introducers.
    // biome-ignore lint/suspicious/noControlCharactersInRegex: stripping them is the point
    .replace(/[\x00-\x1f\x7f-\x9f]/g, "")
    // Trojan-Source bidi overrides. Not control characters, so the strip above
    // does not see them, and they reorder the rendered line all the same.
    .replace(/[\u200e\u200f\u202a-\u202e\u2066-\u2069\u061c]/g, "");
  return stripped.length > LOG_FIELD_MAX ? `${stripped.slice(0, LOG_FIELD_MAX)}\u2026` : stripped;
}
