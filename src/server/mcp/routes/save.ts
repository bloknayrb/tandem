import type { Request, Response } from "express";
import {
  getActiveDocId,
  saveDocumentAsToDisk,
  saveDocumentToDisk,
  serializeDocument,
} from "../document-service.js";
import { sendApiError } from "./_shared.js";

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
    res.json({ data: result });
  } catch (err: unknown) {
    sendApiError(res, err);
  }
}
