import type { Request, Response } from "express";
import { applyChangesCore } from "../docx-apply.js";
import { sendApiError } from "./_shared.js";

export async function handleApplyChanges(req: Request, res: Response): Promise<void> {
  const { documentId, author, backupPath } = (req.body ?? {}) as Record<string, unknown>;
  if (documentId !== undefined && typeof documentId !== "string") {
    res.status(400).json({ error: "BAD_REQUEST", message: "documentId must be a string" });
    return;
  }
  if (author !== undefined && typeof author !== "string") {
    res.status(400).json({ error: "BAD_REQUEST", message: "author must be a string" });
    return;
  }
  if (backupPath !== undefined && typeof backupPath !== "string") {
    res.status(400).json({ error: "BAD_REQUEST", message: "backupPath must be a string" });
    return;
  }

  try {
    const result = await applyChangesCore(
      documentId as string | undefined,
      author as string | undefined,
      backupPath as string | undefined,
    );
    res.json({ data: result });
  } catch (err: unknown) {
    sendApiError(res, err);
  }
}
