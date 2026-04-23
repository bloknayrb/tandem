import type { Request, Response } from "express";
import { convertToMarkdown } from "../convert.js";
import type { Handler } from "./_shared.js";
import { sendApiError } from "./_shared.js";

export function makeConvertHandler(): Handler {
  return async (req: Request, res: Response) => {
    const { documentId, outputPath } = (req.body ?? {}) as Record<string, unknown>;
    if (documentId !== undefined && typeof documentId !== "string") {
      res.status(400).json({ error: "BAD_REQUEST", message: "documentId must be a string" });
      return;
    }
    if (outputPath !== undefined && typeof outputPath !== "string") {
      res.status(400).json({ error: "BAD_REQUEST", message: "outputPath must be a string" });
      return;
    }

    try {
      const result = await convertToMarkdown(
        documentId as string | undefined,
        outputPath as string | undefined,
      );
      res.json({ data: result });
    } catch (err: unknown) {
      sendApiError(res, err);
    }
  };
}
