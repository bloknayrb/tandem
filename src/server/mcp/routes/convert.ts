import type { Request, Response } from "express";
import { convertToMarkdown } from "../convert.js";
import { scrubPathForCaller, sendApiError } from "./_shared.js";

export async function handleConvert(req: Request, res: Response): Promise<void> {
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
    // #1294: when the caller omits `outputPath`, `convertToMarkdown` derives it
    // from the open document's directory — so the response returns an absolute
    // path the caller never supplied. `findAvailablePath` can also rename it
    // (`x-1.md`), so even a caller-supplied path comes back changed; basenaming
    // keeps the part that changed and drops the part that discloses layout.
    res.json({ data: { ...result, outputPath: scrubPathForCaller(req, result.outputPath) } });
  } catch (err: unknown) {
    sendApiError(res, err);
  }
}
