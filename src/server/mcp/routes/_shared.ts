import type { NextFunction, Request, Response } from "express";
import { isLoopback } from "../../auth/middleware.js";

/** Express middleware/handler function type (Express 5 compatible). */
export type Handler = (req: Request, res: Response, next: NextFunction) => void;

/** Reject UNC paths (both backslash and forward-slash variants) to prevent NTLM hash leaks. */
function hasUncPrefix(p: string): boolean {
  return p.startsWith("\\\\") || p.startsWith("//");
}

/** basename() on Linux doesn't treat `\` as a separator, so Windows-style paths
 *  like `C:\Program Files\node.exe` return the whole string. Split on both. */
function crossBasename(p: string): string {
  return p.split(/[/\\]/).pop() || "";
}

/** Validate that a nodeBinary path points to a Node.js binary, not an arbitrary executable. */
const VALID_NODE_BASENAME_RE = /^node(-sidecar(-[a-z0-9_-]+)?)?(\.exe)?$/;
export function isValidNodeBinary(nodeBinary: string): boolean {
  if (!nodeBinary) return false;
  if (nodeBinary.includes("..")) return false;
  if (hasUncPrefix(nodeBinary)) return false;
  return VALID_NODE_BASENAME_RE.test(crossBasename(nodeBinary));
}

/**
 * Strip an absolute path to a basename for non-loopback callers (#1294).
 *
 * The project already had this convention — `GET /api/backups`, `GET /api/sessions`
 * and `GET /api/info` each implemented it by hand — and four surfaces missed it,
 * which is what made it one missing convention rather than four bugs. It lives
 * here so the next route inherits it instead of re-deciding it.
 *
 * An absolute path discloses the username and the home-directory / install
 * layout: reconnaissance for a targeted path attack. Loopback callers get the
 * real path, because the local UI genuinely needs it.
 *
 * Accepted residual, recorded so it stays a decision: a basename can itself
 * carry a username or be sensitive (`Q3-layoffs.md`). Basename is nonetheless
 * what the existing read-side routes return, and matching them exactly is the
 * point — a mutating twin that scrubs *harder* than its read twin reopens the
 * drift this consolidation exists to close.
 *
 * Uses `crossBasename`, not `path.basename`: on Linux the latter does not treat
 * `\` as a separator, so a Windows-style path would pass through whole.
 */
export function scrubPathForCaller(req: PeerRequest, absPath: string): string {
  return isLoopbackRequest(req) ? absPath : crossBasename(absPath);
}

/** Nullable twin of {@link scrubPathForCaller}, for optional path fields. */
export function scrubOptionalPathForCaller(
  req: PeerRequest,
  absPath: string | null | undefined,
): string | null {
  if (absPath === null || absPath === undefined) return null;
  return scrubPathForCaller(req, absPath);
}

/**
 * Loopback test for a request. Reads `req.socket.remoteAddress` only — never the
 * `Host` header, which is forgeable and is what makes DNS rebinding a non-issue.
 */
export function isLoopbackRequest(req: PeerRequest): boolean {
  return isLoopback(req.socket?.remoteAddress);
}

/**
 * The only part of a request these helpers need. Deliberately structural rather
 * than `express.Request`: `res.req` is typed `IncomingMessage`, and the peer
 * address is the sole input to the loopback decision anyway — widening to the
 * full Express type would force a cast at the one call site that matters most.
 */
export interface PeerRequest {
  socket?: { remoteAddress?: string | undefined };
}

/**
 * Shape check for a caller-supplied documentId, before it reaches the registry.
 *
 * Bounded length + room-name character class. Extracted here (#1295 L2) so the
 * destructive backup-restore route validates identically to `document/reload`
 * rather than re-deriving it — a second copy is how the scrub convention in
 * this file drifted in the first place.
 *
 * This is a SHAPE check only. Callers must still confirm the document is open
 * (`hasDoc`) before acting: a well-formed id for a closed document is not a
 * valid target.
 */
const MAX_DOCUMENT_ID_LENGTH = 256;
const DOCUMENT_ID_RE = /^[A-Za-z0-9._-]+$/;
export function isValidDocumentId(id: unknown): id is string {
  return (
    typeof id === "string" &&
    id.length > 0 &&
    id.length <= MAX_DOCUMENT_ID_LENGTH &&
    DOCUMENT_ID_RE.test(id)
  );
}

/** Map error code to HTTP status. Exported for testing. */
export function errorCodeToHttpStatus(code: string | undefined): number {
  switch (code) {
    case "ENOENT":
    case "FILE_NOT_FOUND":
    case "NO_DOCUMENT":
    case "NOT_FOUND":
      return 404;
    case "INVALID_PATH":
    case "UNSUPPORTED_FORMAT":
    case "NO_SUGGESTIONS":
    case "INVALID_ARGUMENT":
    case "INVALID_NAME":
    case "EXTENSION_MISMATCH":
    case "PATH_REJECTED":
      return 400;
    case "READ_ONLY":
      return 403;
    case "ANNOTATION_RESOLVED":
    case "NOT_RENAMABLE":
    case "ALREADY_EXISTS":
    case "RENAME_IN_PROGRESS":
    case "RELOAD_IN_PROGRESS":
    case "EXTERNAL_CONFLICT":
      return 409;
    case "FILE_TOO_LARGE":
      return 413;
    case "EBUSY":
    case "EPERM":
      return 423;
    case "EACCES":
      return 403;
    case "BACKUP_FAILED":
      return 500;
    default:
      return 500;
  }
}

/** Map a Node/custom error code to a JSON-body error label. */
function errorCodeToLabel(code: string): string {
  switch (code) {
    case "ENOENT":
    case "FILE_NOT_FOUND":
    case "NO_DOCUMENT":
    case "NOT_FOUND":
      return "NOT_FOUND";
    case "INVALID_PATH":
      return "INVALID_PATH";
    case "UNSUPPORTED_FORMAT":
    case "NO_SUGGESTIONS":
    case "INVALID_ARGUMENT":
      return "BAD_REQUEST";
    // NOTE: the rename error codes (INVALID_NAME / NOT_RENAMABLE / ALREADY_EXISTS
    // / RENAME_IN_PROGRESS / PATH_REJECTED / EXTENSION_MISMATCH) are intentionally
    // NOT mapped here. renameDocument's codes flow through routes/rename.ts (which
    // emits the raw errorCode) and the tandem_rename MCP tool (mcpError) — never
    // through sendApiError, the sole caller of this label mapper. They still need
    // their HTTP status, so they ARE listed in errorCodeToHttpStatus above.
    case "ANNOTATION_RESOLVED":
      return "ANNOTATION_RESOLVED";
    // Source-view reload (#1021) codes flow through sendApiError, so unlike the
    // rename codes they DO need labels here (plus their statuses above).
    case "READ_ONLY":
      return "READ_ONLY";
    case "RELOAD_IN_PROGRESS":
      return "RELOAD_IN_PROGRESS";
    case "EXTERNAL_CONFLICT":
      return "EXTERNAL_CONFLICT";
    case "FILE_TOO_LARGE":
      return "FILE_TOO_LARGE";
    case "EBUSY":
    case "EPERM":
      return "FILE_LOCKED";
    case "EACCES":
      return "PERMISSION_DENIED";
    case "BACKUP_FAILED":
      return "INTERNAL";
    default:
      return "INTERNAL";
  }
}

/**
 * Map error codes from file-opener to HTTP responses.
 *
 * #1294: a raw `fs` error message embeds the absolute path Node was operating
 * on, so echoing `e.message` put the app-data layout in the body of any failed
 * restore or lock-reclaim. Non-loopback callers now get the structured label
 * only; the detail stays on stderr, where it is still there for debugging.
 * This follows `sendInternal` in `integrations/api-routes.ts`, which already
 * made that trade.
 *
 * Gated via `res.req` rather than a new parameter: there are 18 call sites
 * across 12 files, and changing every signature to thread a `req` that Express
 * already hangs off the response is churn without a safety gain.
 */
export function sendApiError(res: Response, err: unknown): void {
  const e = err as NodeJS.ErrnoException;
  const code = e.code ?? "";
  const status = errorCodeToHttpStatus(code);
  const label = errorCodeToLabel(code);
  const detail =
    label === "FILE_LOCKED" ? "File is locked by another program." : (e.message ?? String(err));
  if (status >= 500) console.error("[Tandem] Unhandled API error:", err);
  else if (status >= 400) console.warn(`[Tandem] API error (${status}): ${detail}`);
  // `res.req` is always set by Express for a live response; the fallback is
  // fail-closed (treat an unknown caller as remote) rather than fail-open.
  const loopback = res.req ? isLoopbackRequest(res.req) : false;
  const msg = loopback ? detail : (GENERIC_ERROR_MESSAGE[label] ?? "The operation failed.");
  res.status(status).json({ error: label, message: msg });
}

/** Path-free replacements for {@link sendApiError}'s detail, keyed by label. */
const GENERIC_ERROR_MESSAGE: Record<string, string> = {
  FILE_NOT_FOUND: "The requested file was not found.",
  FILE_TOO_LARGE: "The file is too large.",
  FILE_LOCKED: "File is locked by another program.",
  PERMISSION_DENIED: "Permission denied.",
  INTERNAL: "The operation failed.",
};
