import type { Request, Response } from "express";
import { openScratchpad } from "../file-opener.js";
import { sendApiError } from "./_shared.js";

export async function handleScratchpad(_req: Request, res: Response): Promise<void> {
  try {
    const result = await openScratchpad();
    res.json({ data: result });
  } catch (err: unknown) {
    sendApiError(res, err);
  }
}
