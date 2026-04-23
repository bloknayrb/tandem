import type { Request, Response } from "express";
import type { Handler } from "../api-routes.js";
import { getActiveDocId, saveDocumentToDisk } from "../document-service.js";
import { sendApiError } from "./_shared.js";

export function makeSaveHandler(): Handler {
  return async (req: Request, res: Response) => {
    const { documentId } = (req.body ?? {}) as Record<string, unknown>;
    if (documentId !== undefined && typeof documentId !== "string") {
      res.status(400).json({ error: "BAD_REQUEST", message: "documentId must be a string" });
      return;
    }
    const targetId = (documentId as string | undefined) ?? getActiveDocId();
    if (!targetId) {
      res.status(404).json({ error: "NOT_FOUND", message: "No document to save." });
      return;
    }
    try {
      const result = await saveDocumentToDisk(targetId, "manual");
      res.json({ data: result });
    } catch (err: unknown) {
      sendApiError(res, err);
    }
  };
}
