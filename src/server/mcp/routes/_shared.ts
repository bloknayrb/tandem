import type { NextFunction, Request, Response } from "express";

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
 * Validate that a channelPath points at the bundled channel shim entry.
 *
 * `/api/setup` registers the body-supplied `channelPath` as an executable
 * MCP command (`node <channelPath>`). Restricting the shape to the known
 * `dist/channel/index.js` artifact (in addition to no-traversal / no-UNC) is
 * defense-in-depth: it stops a *remote, token-bearing* caller on a LAN bind —
 * who cannot plant files on the host — from coercing `node <arbitrary.js>`,
 * and it catches accidental mis-pointing. It is NOT a boundary against a
 * same-user local writer, who can already plant a `…/dist/channel/index.js`
 * payload and has code execution regardless (Tandem's same-user threat model).
 * The `existsSync` check is applied separately at the call site so this stays
 * a pure string validator. See the #985 security review.
 */
export function isValidChannelPath(channelPath: string): boolean {
  if (!channelPath) return false;
  if (channelPath.includes("..")) return false;
  if (hasUncPrefix(channelPath)) return false;
  // Normalize Windows separators; require the canonical bundled artifact path.
  // Accept the bare relative form (dev mode resolves it against cwd) and any
  // absolute path ending in the artifact suffix.
  const normalized = channelPath.replace(/\\/g, "/");
  return normalized === "dist/channel/index.js" || normalized.endsWith("/dist/channel/index.js");
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

/** Map error codes from file-opener to HTTP responses */
export function sendApiError(res: Response, err: unknown): void {
  const e = err as NodeJS.ErrnoException;
  const code = e.code ?? "";
  const status = errorCodeToHttpStatus(code);
  const label = errorCodeToLabel(code);
  const msg =
    label === "FILE_LOCKED" ? "File is locked by another program." : (e.message ?? String(err));
  if (status >= 500) console.error("[Tandem] Unhandled API error:", err);
  else if (status >= 400) console.warn(`[Tandem] API error (${status}): ${msg}`);
  res.status(status).json({ error: label, message: msg });
}
