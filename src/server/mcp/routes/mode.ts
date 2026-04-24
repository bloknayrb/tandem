import type { Request, Response } from "express";
import {
  CTRL_ROOM,
  TANDEM_MODE_DEFAULT,
  Y_MAP_MODE,
  Y_MAP_USER_AWARENESS,
} from "../../../shared/constants.js";
import { TandemModeSchema } from "../../../shared/types.js";
import { getOrCreateDocument } from "../../yjs/provider.js";
import type { Handler } from "./_shared.js";

export function makeModeHandler(): Handler {
  return (_req: Request, res: Response) => {
    const ctrlDoc = getOrCreateDocument(CTRL_ROOM);
    const awareness = ctrlDoc.getMap(Y_MAP_USER_AWARENESS);
    const raw = awareness.get(Y_MAP_MODE);
    const parsed = TandemModeSchema.safeParse(raw);
    if (raw !== undefined && !parsed.success) {
      console.warn(
        `[Tandem] Invalid mode value in awareness, falling back to default. raw=${JSON.stringify(raw)}`,
      );
    }
    const mode = parsed.success ? parsed.data : TANDEM_MODE_DEFAULT;
    res.json({ mode });
  };
}
