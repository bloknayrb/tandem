import type { Request, Response } from "express";
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
  const { documentId, newName } = (req.body ?? {}) as Record<string, unknown>;
  if (!documentId || typeof documentId !== "string") {
    res.status(400).json({ error: "BAD_REQUEST", message: "documentId is required" });
    return;
  }
  if (!newName || typeof newName !== "string") {
    res.status(400).json({ error: "BAD_REQUEST", message: "newName is required" });
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
