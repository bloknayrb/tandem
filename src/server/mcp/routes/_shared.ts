import type { NextFunction, Request, Response } from "express";
import { crossBasename } from "../../../shared/cross-basename.js";
import { isLoopback } from "../../auth/middleware.js";

/** Express middleware/handler function type (Express 5 compatible). */
export type Handler = (req: Request, res: Response, next: NextFunction) => void;

/**
 * Strip an absolute path to a basename for non-loopback callers (#1294).
 *
 * The project already had this convention — `GET /api/backups` and
 * `GET /api/sessions` each implemented it by hand — and several surfaces missed
 * it, which is what made it one missing convention rather than N bugs. It lives
 * here so the next route inherits it instead of re-deciding it.
 *
 * `GET /api/info` is a deliberate exception, NOT an example: it returns
 * `changelogPath` / `workflowsPath` / `welcomePath` absolute to every
 * authenticated caller, because the remote browser client feeds them straight
 * back to `/api/open` and a basename would not resolve. See the note in
 * `routes/info.ts`. Do not read this helper's existence as a claim that every
 * path-bearing route is scrubbed.
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

/**
 * Reduce a URL to scheme + authority for non-loopback callers.
 *
 * The sibling of {@link scrubPathForCaller}, and per-caller for the same reason:
 * loopback gets the real value because the local UI genuinely needs it. A twin
 * that scrubbed harder than its sibling would reopen the drift the note above
 * exists to close.
 *
 * Reduced rather than dropped. The authority is the one part a caller can act
 * on — it is what distinguishes "this entry points off-box" from "this entry
 * points at loopback" — while userinfo, path, query and fragment are the parts
 * that carry credentials, tokens and layout.
 *
 * Built BY CONSTRUCTION from `protocol` + `host`: nothing is copied and then
 * stripped, so there is no strip step to get wrong, and a URL component nobody
 * anticipated cannot ride out. `host` carries the port and excludes userinfo.
 *
 * Returns `undefined` — meaning "drop the field" — for a string `new URL()`
 * refuses, and for a parsed URL with no authority at all (`file:///home/alice/x`,
 * `foo:bar`), whose `host` is `""`. Guessing at either would re-emit the path
 * this helper exists to withhold.
 */
export function scrubUrlForCaller(req: PeerRequest, url: string): string | undefined {
  if (isLoopbackRequest(req)) return url;
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return undefined;
  }
  if (parsed.host === "") return undefined;
  return `${parsed.protocol}//${parsed.host}`;
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
    // `SOURCE_MISSING` and `FILE_MODIFIED` are `saveDocumentToDisk`'s skip codes
    // (see `saveSkippedMessage`), which docx-apply reuses rather than minting a
    // parallel vocabulary for the same two conditions. They reach sendApiError
    // only from there — a skipped save returns 200 with a `skipCode`.
    case "SOURCE_MISSING":
      return 404;
    case "INVALID_PATH":
    // A symlink at the backup destination is a bad caller-supplied path, not a
    // server fault — 500 would read as "Tandem broke" for something the caller
    // can fix by passing a different `backupPath`.
    case "BACKUP_SYMLINK":
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
    case "FILE_MODIFIED":
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

/** Map a Node/custom error code to a JSON-body error label. Exported for testing. */
export function errorCodeToLabel(code: string): string {
  switch (code) {
    case "ENOENT":
    case "FILE_NOT_FOUND":
    case "NO_DOCUMENT":
    case "NOT_FOUND":
    case "SOURCE_MISSING":
      return "NOT_FOUND";
    case "INVALID_PATH":
    case "BACKUP_SYMLINK":
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
    // `FILE_MODIFIED` folds onto EXTERNAL_CONFLICT for the same reason
    // DOCX_TOO_LARGE folds onto FILE_TOO_LARGE below: they are one condition
    // ("the file changed under us") reported by two code paths, `saveSkippedMessage`
    // already gives them identical user-facing copy, and a novel label would be an
    // unrecognized string to every existing client.
    case "EXTERNAL_CONFLICT":
    case "FILE_MODIFIED":
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

/**
 * Map thrown API error codes to HTTP responses. Not scoped to any one
 * producer: the open pipeline, the reload family and the annotation layer all
 * feed it, which is why the table below carries `RELOAD_IN_PROGRESS`,
 * `EXTERNAL_CONFLICT` and `ANNOTATION_RESOLVED` alongside the open codes.
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

/**
 * Path-free replacements for {@link sendApiError}'s detail, keyed by LABEL —
 * i.e. by what `errorCodeToLabel` returns, not by the incoming error code.
 *
 * The distinction is load-bearing and was got wrong once: the original entry was
 * keyed `FILE_NOT_FOUND`, which `errorCodeToLabel` never emits (it folds ENOENT
 * / FILE_NOT_FOUND / NO_DOCUMENT / NOT_FOUND into `NOT_FOUND`), so the most
 * common 404 fell through to the catch-all. Every label the mapper can return
 * needs an entry here or it silently degrades to "The operation failed.";
 * `path-scrub.test.ts` asserts that exhaustively.
 */
export const GENERIC_ERROR_MESSAGE: Record<string, string> = {
  NOT_FOUND: "The requested file was not found.",
  INVALID_PATH: "The path is not valid.",
  BAD_REQUEST: "The request was not valid.",
  READ_ONLY: "The document is read-only.",
  RELOAD_IN_PROGRESS: "A reload is already in progress.",
  EXTERNAL_CONFLICT: "The file was modified outside Tandem.",
  ANNOTATION_RESOLVED: "The annotation is already resolved.",
  FILE_TOO_LARGE: "The file is too large.",
  FILE_LOCKED: "File is locked by another program.",
  PERMISSION_DENIED: "Permission denied.",
  INTERNAL: "The operation failed.",
};

/** Labels {@link errorCodeToLabel} can return. Exported for the exhaustiveness test. */
export const ERROR_LABELS = [
  "NOT_FOUND",
  "INVALID_PATH",
  "BAD_REQUEST",
  "ANNOTATION_RESOLVED",
  "READ_ONLY",
  "RELOAD_IN_PROGRESS",
  "EXTERNAL_CONFLICT",
  "FILE_TOO_LARGE",
  "FILE_LOCKED",
  "PERMISSION_DENIED",
  "INTERNAL",
] as const;
