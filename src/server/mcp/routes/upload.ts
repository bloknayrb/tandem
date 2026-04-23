import type { Request, Response } from "express";
import { detectFormat } from "../document-model.js";
import { openFileFromContent } from "../file-opener.js";
import type { Handler } from "./_shared.js";
import { sendApiError } from "./_shared.js";

export function makeUploadHandler(): Handler {
  return async (req: Request, res: Response) => {
    const { fileName, content } = (req.body ?? {}) as Record<string, unknown>;
    if (!fileName || typeof fileName !== "string") {
      res.status(400).json({ error: "BAD_REQUEST", message: "fileName is required" });
      return;
    }
    if (content === undefined || content === null) {
      res.status(400).json({ error: "BAD_REQUEST", message: "content is required" });
      return;
    }
    if (typeof content !== "string") {
      res.status(400).json({ error: "BAD_REQUEST", message: "content must be a base64 string" });
      return;
    }
    try {
      const format = detectFormat(fileName);
      const decoded = format === "docx" ? Buffer.from(content, "base64") : String(content);
      const result = await openFileFromContent(fileName, decoded);
      res.json({ data: result });
    } catch (err: unknown) {
      sendApiError(res, err);
    }
  };
}
