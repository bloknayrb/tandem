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

/** Validate that a channelPath points to a JS file without traversal or UNC paths. */
export function isValidChannelPath(channelPath: string): boolean {
  if (!channelPath) return false;
  if (!crossBasename(channelPath).endsWith(".js")) return false;
  if (channelPath.includes("..")) return false;
  if (hasUncPrefix(channelPath)) return false;
  return true;
}

/** Map error code to HTTP status. Exported for testing. */
export function errorCodeToHttpStatus(code: string | undefined): number {
  switch (code) {
    case "ENOENT":
    case "FILE_NOT_FOUND":
    case "NO_DOCUMENT":
      return 404;
    case "INVALID_PATH":
    case "UNSUPPORTED_FORMAT":
    case "NO_SUGGESTIONS":
      return 400;
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
      return "NOT_FOUND";
    case "INVALID_PATH":
      return "INVALID_PATH";
    case "UNSUPPORTED_FORMAT":
    case "NO_SUGGESTIONS":
      return "BAD_REQUEST";
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
