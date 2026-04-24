import type { Request, Response } from "express";
import { closeDocumentById } from "../document-service.js";
import { sendApiError } from "./_shared.js";

export async function handleClose(req: Request, res: Response): Promise<void> {
  const { documentId } = (req.body ?? {}) as Record<string, unknown>;
  if (!documentId || typeof documentId !== "string") {
    res.status(400).json({ error: "BAD_REQUEST", message: "documentId is required" });
    return;
  }
  try {
    const result = await closeDocumentById(documentId);
    if (!result.success) {
      console.warn(
        `[Tandem] API error (404): close failed for documentId=${documentId}: ${result.error}`,
      );
      res.status(404).json({ error: "NOT_FOUND", message: result.error });
      return;
    }
    res.json({
      data: { closedPath: result.closedPath, activeDocumentId: result.activeDocumentId },
    });
  } catch (err: unknown) {
    sendApiError(res, err);
  }
}
