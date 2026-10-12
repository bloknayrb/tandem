import type { Request, Response } from "express";
import { openFromDisk } from "../../documents/open.js";
import { sendApiError } from "./_shared.js";
import { sendOpenResult } from "./send-open-result.js";

export async function handleOpen(req: Request, res: Response): Promise<void> {
  const { filePath, force, readOnly } = (req.body ?? {}) as Record<string, unknown>;
  if (!filePath || typeof filePath !== "string") {
    res.status(400).json({ error: "BAD_REQUEST", message: "filePath is required" });
    return;
  }
  try {
    const result = await openFromDisk(filePath, {
      force: force === true,
      readOnly: readOnly === true,
    });
    sendOpenResult(res, result);
  } catch (err: unknown) {
    sendApiError(res, err);
  }
}
