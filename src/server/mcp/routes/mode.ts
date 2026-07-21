import type { Request, Response } from "express";
import { readLiveMode } from "../../mode.js";

export function handleMode(_req: Request, res: Response): void {
  // The reported (two-state) mode from the single authority in `mode.ts`:
  // indeterminate/absent and malformed values both collapse to the default.
  res.json({ mode: readLiveMode() });
}
