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
    const mode = TandemModeSchema.catch(TANDEM_MODE_DEFAULT).parse(awareness.get(Y_MAP_MODE));
    res.json({ mode });
  };
}
