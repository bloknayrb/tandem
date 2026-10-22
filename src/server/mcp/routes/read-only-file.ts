import type { Request, Response } from "express";

import { API_READ_ONLY_FILE_RESOLVE } from "../../../shared/api-paths.js";
import { resolveReadOnlyFile } from "../../documents/read-only-file.js";
import { getOpenDocs } from "../../documents/registry.js";
import {
  assertLoopbackForMutation,
  assertOriginAllowlisted,
} from "../../integrations/api-routes.js";
import { getOrCreateDocument } from "../../yjs/provider.js";
import { type SaveResult, saveDocumentToDiskRetryingLock } from "../document-service.js";
import { isValidDocumentId, sendApiError } from "./_shared.js";

/**
 * POST /api/read-only-file/resolve — answer the read-only-file prompt (#2273).
 * Body: `{ documentId, choice: "overwrite" | "dismiss", detectedAt }`.
 *
 * - "overwrite" (POSIX only): approve overwriting this file for as long as the
 *   document stays open at this path, then save. The response carries the
 *   `SaveResult`, so the banner can report a save that still did not land.
 * - "dismiss": stop asking on autosave. An explicit save asks again.
 *
 * Gated on origin allowlist + loopback, like the external-conflict resolve it
 * mirrors. Unlike that route, `documentId` and `detectedAt` are REQUIRED: the
 * server's active document is not the client's focused tab, and an approval
 * must name the exact prompt episode it answers — the live one is held in
 * server memory, never read off the forgeable Y.Map mirror, so with no prompt
 * pending nothing can be approved. A mismatch is a no-op `stale` success.
 *
 * Reach (security review): on POSIX every save already overwrote a read-only
 * file with no check at all, so a page able to call this route gains nothing
 * it could not do through `POST /api/save` before #2273. On Windows the
 * attribute made such files unreachable, and "overwrite" is refused there
 * (`unsupported`) rather than opening that class — the #2027 shape.
 */
export async function handleResolveReadOnlyFile(req: Request, res: Response): Promise<void> {
  if (assertOriginAllowlisted(req, res, API_READ_ONLY_FILE_RESOLVE)) return;
  if (assertLoopbackForMutation(req, res)) return;
  const { documentId, choice, detectedAt } = (req.body ?? {}) as Record<string, unknown>;
  if (choice !== "overwrite" && choice !== "dismiss") {
    res
      .status(400)
      .json({ error: "BAD_REQUEST", message: 'choice must be "overwrite" or "dismiss".' });
    return;
  }
  if (!isValidDocumentId(documentId)) {
    res.status(400).json({ error: "BAD_REQUEST", message: "documentId is required." });
    return;
  }
  if (typeof detectedAt !== "number") {
    res.status(400).json({ error: "BAD_REQUEST", message: "detectedAt must be a number." });
    return;
  }
  const id = documentId;
  const docState = getOpenDocs().get(id);
  if (!docState) {
    res.status(400).json({ error: "NO_DOCUMENT", message: `Document ${id} is not open.` });
    return;
  }
  try {
    const doc = getOrCreateDocument(id);
    const outcome = resolveReadOnlyFile(id, doc, docState.filePath, choice, detectedAt);
    if (outcome === "unsupported") {
      res.status(400).json({
        error: "UNSUPPORTED",
        message:
          "Tandem can't overwrite a read-only file on Windows. Clear Read-only in the file's Properties, then save again.",
      });
      return;
    }
    let save: SaveResult | undefined;
    if (outcome === "approved") save = await saveDocumentToDiskRetryingLock(id, "manual");
    res.json({ data: { outcome, ...(save ? { save } : {}) } });
  } catch (err: unknown) {
    sendApiError(res, err);
  }
}
