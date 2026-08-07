import type { NextFunction, Request, Response } from "express";

/** Express middleware/handler function type (Express 5 compatible). */
export type Handler = (req: Request, res: Response, next: NextFunction) => void;

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
    // DOCX_TOO_LARGE (#1310) is the decompressed-size sibling of FILE_TOO_LARGE's compressed cap.
    // Without this case it falls through to 500, which makes sendApiError log
    // "[Tandem] Unhandled API error:" with a stack — reporting a policy refusal of hostile input as
    // a Tandem crash, in the one artefact (Copy Diagnostics) a user would send us about it.
    case "FILE_TOO_LARGE":
    case "DOCX_TOO_LARGE":
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
    // Deliberately the SAME label as the compressed-size cap rather than a new one: both are
    // "this file is too big to open", the distinction between them is in `message`, and a novel
    // label would be an unrecognized string to every existing client while changing nothing a
    // caller can act on differently.
    case "FILE_TOO_LARGE":
    case "DOCX_TOO_LARGE":
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
