import type { Request, Response } from "express";
import { openScratchpad } from "../file-opener.js";
import { sendApiError } from "./_shared.js";

const MAX_SCRATCHPAD_CONTENT_BYTES = 1024 * 1024;

export async function handleScratchpad(req: Request, res: Response): Promise<void> {
  const body = req.body;
  if (
    body !== undefined &&
    (body === null ||
      typeof body !== "object" ||
      Array.isArray(body) ||
      Object.keys(body).some((key) => key !== "content"))
  ) {
    res.status(400).json({ error: "BAD_REQUEST", message: "Expected { content?: string }." });
    return;
  }
  const content = (body as { content?: unknown } | undefined)?.content;
  if (content !== undefined && typeof content !== "string") {
    res.status(400).json({ error: "BAD_REQUEST", message: "content must be a string." });
    return;
  }
  if (
    typeof content === "string" &&
    Buffer.byteLength(content, "utf8") > MAX_SCRATCHPAD_CONTENT_BYTES
  ) {
    res.status(413).json({
      error: "PAYLOAD_TOO_LARGE",
      message: "Scratchpad content must be no larger than 1 MiB.",
    });
    return;
  }
  try {
    const result = await openScratchpad(content as string | undefined);
    res.json({ data: result });
  } catch (err: unknown) {
    sendApiError(res, err);
  }
}
