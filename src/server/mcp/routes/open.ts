import type { Request, Response } from "express";
import { openFileByPath } from "../file-opener.js";
import { licenseGate, sendLicenseRequired } from "../license-gate.js";
import { sendApiError } from "./_shared.js";

export async function handleOpen(req: Request, res: Response): Promise<void> {
  const { filePath, force, readOnly } = (req.body ?? {}) as Record<string, unknown>;
  if (!filePath || typeof filePath !== "string") {
    res.status(400).json({ error: "BAD_REQUEST", message: "filePath is required" });
    return;
  }
  // License gate (#1116) — only the destructive force-reload sub-path (mirrors
  // the tandem_open MCP handler). Plain open stays ungated (escape hatch).
  if (force === true && licenseGate() !== null) {
    sendLicenseRequired(res);
    return;
  }
  try {
    const result = await openFileByPath(filePath, {
      force: force === true,
      readOnly: readOnly === true,
    });
    res.json({ data: result });
  } catch (err: unknown) {
    sendApiError(res, err);
  }
}
