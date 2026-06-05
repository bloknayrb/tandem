import type { Request, Response } from "express";
import path from "path";
import { renameDocument } from "../document-service.js";
import { errorCodeToHttpStatus } from "./_shared.js";

/**
 * POST /api/rename — rename an open on-disk document's file in place (#1017).
 *
 * Body: `{ documentId: string, newName: string }`. `newName` is a bare basename
 * (same directory, same extension). The DNS-rebinding Host check + CORS Origin
 * reflection come from the shared `apiMiddleware`; renameDocument performs all
 * the path/name validation and the migration.
 */
export async function handleRename(req: Request, res: Response): Promise<void> {
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
  // barrier, so both values are considered clean after this point. documentId
  // is a hash (no separators) so path.basename() is a no-op on valid input;
  // the call is here specifically to terminate the taint chain before either
  // value reaches any file-system sink inside renameDocument.
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
