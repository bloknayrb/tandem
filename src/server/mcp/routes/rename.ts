import type { Request, Response } from "express";
import path from "path";

import { API_RENAME } from "../../../shared/api-paths.js";
import {
  assertLoopbackForMutation,
  assertOriginAllowlisted,
} from "../../integrations/api-routes.js";
import { renameDocument } from "../document-service.js";
import { errorCodeToHttpStatus } from "./_shared.js";

/**
 * POST /api/rename — rename an open on-disk document's file in place (#1017).
 *
 * Body: `{ documentId: string, newName: string }`. `newName` is a bare basename
 * (same directory, same extension). Gated on origin allowlist + loopback so
 * authenticated LAN callers cannot rename local files (#1121 F6).
 */
export async function handleRename(req: Request, res: Response): Promise<void> {
  if (assertOriginAllowlisted(req, res, API_RENAME)) return;
  if (assertLoopbackForMutation(req, res)) return;
  const { documentId: rawDocumentId, newName: rawNewName } = (req.body ?? {}) as Record<
    string,
    unknown
  >;
  if (!rawDocumentId || typeof rawDocumentId !== "string") {
    res.status(400).json({ error: "BAD_REQUEST", message: "documentId is required" });
    return;
  }
  if (!rawNewName || typeof rawNewName !== "string") {
    res.status(400).json({ error: "BAD_REQUEST", message: "newName is required" });
    return;
  }
  // Sanitize both inputs at the HTTP boundary via path.basename(). CodeQL's
  // js/path-injection taint-tracker treats path.basename() as a sanitizer
  // barrier, so the basename'd binding is what flows to renameDocument's
  // file-system sinks. The `tandem_rename` MCP handler basenames identically
  // (document.ts), so both entry points normalize a path-like input to its
  // last component rather than rejecting it — separators (`sub/b.md` → `b.md`)
  // and single-char drive prefixes (`a:b.md` → `b.md`) are stripped here. Every
  // other illegal name (`<>"|?*`, control chars, reserved devices, trailing
  // dot, multi-char `name:stream`) survives basename and is rejected by
  // renameDocument's validateRenameFilename. documentId is a hash with no
  // separators, so basename is a no-op on valid input; a malformed one strips
  // to a value that just misses openDocs.get() → NOT_FOUND.
  const documentId = path.basename(rawDocumentId);
  if (!documentId) {
    res.status(400).json({ error: "BAD_REQUEST", message: "documentId is required" });
    return;
  }
  const newName = path.basename(rawNewName);
  if (!newName) {
    res.status(400).json({ error: "INVALID_PATH", message: "newName must not be empty" });
    return;
  }

  const result = await renameDocument(documentId, newName);
  if (result.status === "error") {
    const status = errorCodeToHttpStatus(result.errorCode);
    res.status(status).json({ error: result.errorCode ?? "INTERNAL", message: result.reason });
    return;
  }

  res.json({
    data: { oldPath: result.oldPath, newPath: result.newPath, fileName: result.fileName },
  });
}
