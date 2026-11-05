/**
 * How a session id appears in a log line (#2358, ADR-054; ownership design
 * §11.1).
 *
 * `Mcp-Session-Id`, `X-Claude-Session-Id` and the stdio bridge's
 * `X-Tandem-Client-Id` select an owner record, and `tandem.log` is pasted into
 * bug reports. So while ownership is on, every server log line that names one
 * prints `#` plus the first 8 hex characters of its SHA-256 instead: still a
 * correlator within a log, never the id. While ownership is off the id is
 * printed unchanged, so a release's log lines are byte-identical to before.
 *
 * Unsalted on purpose: anyone who can confirm a hash already holds the id.
 */

import { createHash } from "node:crypto";
import { ownershipEnabled } from "../ownership-flag.js";

export function sessionIdForLog(id: string): string {
  if (!ownershipEnabled()) return id;
  return `#${createHash("sha256").update(id).digest("hex").slice(0, 8)}`;
}

/**
 * `sessionIdForLog` for a Claude Code session id. Flag-on it hashes the id
 * case-folded, the fold `claudeIdKey` (`mcp/transport-registry.ts`) applies to
 * the owner record, so one session sent in two cases logs as one hash. Flag-off
 * the id is printed exactly as received, as before.
 */
export function claudeSessionIdForLog(id: string): string {
  return ownershipEnabled() ? sessionIdForLog(id.toLowerCase()) : id;
}
