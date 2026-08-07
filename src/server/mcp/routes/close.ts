import type { Request, Response } from "express";
import path from "path";
import { closeDocumentById } from "../document-service.js";
import { scrubPathForCaller, sendApiError } from "./_shared.js";

export async function handleClose(req: Request, res: Response): Promise<void> {
  const { documentId } = (req.body ?? {}) as Record<string, unknown>;
  if (!documentId || typeof documentId !== "string") {
    res.status(400).json({ error: "BAD_REQUEST", message: "documentId is required" });
    return;
  }
  try {
    const result = await closeDocumentById(documentId);
    if (!result.success) {
      // path.basename: documentId is unsanitized request-body input; don't let
      // it flow raw into a log sink (CodeQL js/log-injection).
      console.warn(
        `[Tandem] API error (404): close failed for documentId=${path.basename(documentId)}: ${result.error}`,
      );
      res.status(404).json({ error: "NOT_FOUND", message: result.error });
      return;
    }
    // #1294: `closedPath` comes from the server's own docState, not from
    // anything the caller supplied — they send only a documentId — so returning
    // it whole hands a LAN caller the username and directory layout of a file
    // whose location they may never have known. No client code reads it.
    res.json({
      data: {
        closedPath: scrubPathForCaller(req, result.closedPath),
        activeDocumentId: result.activeDocumentId,
      },
    });
  } catch (err: unknown) {
    sendApiError(res, err);
  }
}
