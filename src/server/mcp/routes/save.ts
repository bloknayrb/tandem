import type { Request, Response } from "express";
import { API_SAVE } from "../../../shared/api-paths.js";
import { assertOriginAllowlisted } from "../../integrations/api-routes.js";
import {
  getActiveDocId,
  persistSkippedSaveSession,
  saveDocumentAsToDisk,
  saveDocumentToDisk,
  serializeDocument,
} from "../document-service.js";
import { isLoopbackRequest, sendApiError } from "./_shared.js";

/**
 * POST /api/save — multi-mode handler.
 *
 * Three branches keyed by the request body:
 *
 *  1. `{ documentId? }` — default. Save the active or specified doc using the
 *     existing in-place save pipeline (`saveDocumentToDisk`).
 *
 *  2. `{ documentId?, serialize: true, format }` — browser save-as fallback.
 *     Serialize the doc to the requested format and return the bytes inline.
 *     Caller wraps in a Blob + anchor download client-side. Does NOT touch
 *     disk and does NOT promote the doc.
 *
 *  3. `{ documentId?, targetPath, format }` — Tauri save-as. Write the doc
 *     to `targetPath` (validated via `assertPathSafe`) and promote the
 *     in-memory `OpenDoc` from `source: "upload"` to `source: "file"` so
 *     subsequent auto-saves write back to the same location.
 */
export async function handleSave(req: Request, res: Response): Promise<void> {
  // CSRF (#1295's class, second instance). A `text/plain` POST is a SIMPLE
  // request, so no preflight fires and the origin allowlist never gets a say;
  // the socket is loopback, so `enforceLoopbackMutation` passes and
  // `authMiddleware` skips the token check entirely (loopback is exempted
  // before it). `express.json()` is mounted with no `type` option, so the body
  // arrives undefined -- which the destructure below tolerates. Every field
  // then defaults, and the call proceeds against the ACTIVE document.
  //
  // `assertOriginAllowlisted` is the control that bites, because it fails
  // closed on a MISSING Origin too (`LOCALHOST_ORIGIN_RE.test("")` is false),
  // and a cross-origin `no-cors` POST does carry an Origin -- that is exactly
  // why the trick works for the request and not for the response.
  //
  // `assertLoopbackForMutation` is deliberately NOT added alongside it. It
  // reads the same `req.socket.remoteAddress` that the path-wide
  // `enforceLoopbackMutation` already checks, so against this attack it does
  // nothing; what it WOULD do is make `scrubPathForCaller`'s non-loopback
  // branch formally unreachable through this route and retire the specs
  // covering it. One real gate beats a second that only looks like defence.
  if (assertOriginAllowlisted(req, res, API_SAVE)) return;

  const body = (req.body ?? {}) as Record<string, unknown>;
  const { documentId, targetPath, format, serialize } = body;

  if (documentId !== undefined && typeof documentId !== "string") {
    res.status(400).json({ error: "BAD_REQUEST", message: "documentId must be a string" });
    return;
  }
  const targetId = (documentId as string | undefined) ?? getActiveDocId();
  if (!targetId) {
    res.status(404).json({ error: "NOT_FOUND", message: "No document to save." });
    return;
  }

  // Branch 2: serialize-only (browser save-as fallback)
  if (serialize === true) {
    if (typeof format !== "string" || (format !== "md" && format !== "txt")) {
      res.status(400).json({
        error: "BAD_REQUEST",
        message: "format must be 'md' or 'txt' when serialize=true",
      });
      return;
    }
    try {
      const result = serializeDocument(targetId, format);
      if (!result.ok) {
        res.status(400).json({ error: "BAD_REQUEST", message: result.reason });
        return;
      }
      res.json({
        data: { content: result.content, fileName: result.fileName, format },
      });
    } catch (err: unknown) {
      sendApiError(res, err);
    }
    return;
  }

  // Branch 3: save-as (Tauri native path)
  if (targetPath !== undefined || format !== undefined) {
    if (typeof targetPath !== "string" || targetPath.length === 0) {
      res
        .status(400)
        .json({ error: "BAD_REQUEST", message: "targetPath must be a non-empty string" });
      return;
    }
    if (typeof format !== "string" || (format !== "md" && format !== "txt")) {
      res.status(400).json({ error: "BAD_REQUEST", message: "format must be 'md' or 'txt'" });
      return;
    }
    try {
      const result = await saveDocumentAsToDisk(targetId, targetPath, format);
      if (result.status === "error") {
        // Map known error codes to HTTP status — path-rejected and unsupported
        // format are client errors; unknown / IO errors map to 500.
        const status =
          result.errorCode === "PATH_REJECTED" ||
          result.errorCode === "UNSUPPORTED_FORMAT" ||
          result.errorCode === "INVALID_PATH" ||
          result.errorCode === "EXTENSION_MISMATCH" ||
          result.errorCode === "READ_ONLY" ||
          result.errorCode === "NOT_PROMOTABLE" ||
          result.errorCode === "NOT_FOUND"
            ? 400
            : 500;
        res.status(status).json({
          error: result.errorCode ?? "SAVE_FAILED",
          message: result.reason ?? "Save As failed",
        });
        return;
      }
      res.json({ data: result });
    } catch (err: unknown) {
      sendApiError(res, err);
    }
    return;
  }

  // Branch 1: ordinary save (existing behavior)
  try {
    const result = await saveDocumentToDisk(targetId, "manual");
    if (result.status === "skipped") {
      // The disk save did NOT happen — persist the dirty flag (#1069) and any
      // pending conflict (#1238) so a restart doesn't discard the only copy of
      // unsaved edits or silently launder away a conflict the user still has
      // to resolve. Mirrors tandem_save's (document.ts) skip handling; both
      // routes to a skipped `saveDocumentToDisk` share this helper so neither
      // can drift out of sync with the other again.
      await persistSkippedSaveSession(targetId);
    }
    // #1294: this branch reports failure in a 200 body rather than through
    // sendApiError, so the scrub there does not reach it. `reason` is the raw
    // write error (`EACCES: permission denied, open '<abs path>'`) for a
    // document the caller identified only by documentId — same disclosure, a
    // different envelope. Branches 2 and 3 are exempt: their paths are the
    // caller's own `targetPath`.
    if (result.status === "error" && !isLoopbackRequest(req)) {
      res.json({ data: { ...result, reason: "The save failed." } });
      return;
    }
    res.json({ data: result });
  } catch (err: unknown) {
    sendApiError(res, err);
  }
}
