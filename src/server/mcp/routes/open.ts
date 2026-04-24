import type { Request, Response } from "express";
import { openFileByPath } from "../file-opener.js";
import { sendApiError } from "./_shared.js";

export async function handleOpen(req: Request, res: Response): Promise<void> {
  const { filePath, force } = (req.body ?? {}) as Record<string, unknown>;
  if (!filePath || typeof filePath !== "string") {
    res.status(400).json({ error: "BAD_REQUEST", message: "filePath is required" });
    return;
  }
  try {
    const result = await openFileByPath(filePath, { force: force === true });
    res.json({ data: result });
  } catch (err: unknown) {
    sendApiError(res, err);
  }
}
