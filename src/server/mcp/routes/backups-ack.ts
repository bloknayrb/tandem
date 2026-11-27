/**
 * POST /api/backups/acknowledge — the editor's kept-edits banner was dismissed
 * (ADR-057, PR 2).
 *
 * Body: `{ documentId, backups: string[] }`, the snapshot names the banner
 * showed. Removes them from the document's `kept-unseen.json`
 * (`acknowledgeKeptEdits`), so the banner stays down until a Claude action
 * keeps edits again. Names are only compared with the stored set's strings and
 * never reach the file system; the written file's name is a constant, and the
 * directory comes from the registry's path.
 *
 * Its own module, not `backups.ts`: `tests/docs/loopback-gate-claims.test.ts`
 * resolves the gates per module, so a second mutating handler there would be
 * invisible to it. Within the documented trust model (docs/security.md): an
 * allowlisted origin can hide the banner, never the kept edits, which stay in
 * Version history.
 */

import type { Request, Response } from "express";
import { API_BACKUPS_ACKNOWLEDGE } from "../../../shared/api-paths.js";
import { acknowledgeKeptEdits } from "../../file-io/doc-backup.js";
import {
  assertLoopbackForMutation,
  assertOriginAllowlisted,
} from "../../integrations/api-routes.js";
import { resolveAppDataDir } from "../../platform.js";
import { getCurrentDoc } from "../document-service.js";
import { isValidDocumentId } from "./_shared.js";

/** More than the `unsaved` kind's cap ever lists; a longer array is not the banner's. */
const MAX_NAMES = 16;
const MAX_NAME_LENGTH = 255;

export async function handleAcknowledgeKeptEdits(req: Request, res: Response): Promise<void> {
  if (assertOriginAllowlisted(req, res, API_BACKUPS_ACKNOWLEDGE)) return;
  if (assertLoopbackForMutation(req, res)) return;
  const body: unknown = req.body;
  if (body === null || typeof body !== "object" || Array.isArray(body)) {
    res.status(400).json({ error: "BAD_REQUEST", message: "A JSON object body is required." });
    return;
  }
  const { documentId, backups } = body as Record<string, unknown>;
  if (!isValidDocumentId(documentId)) {
    res.status(400).json({ error: "BAD_REQUEST", message: "documentId is invalid." });
    return;
  }
  if (
    !Array.isArray(backups) ||
    backups.length === 0 ||
    backups.length > MAX_NAMES ||
    !backups.every((b) => typeof b === "string" && b.length > 0 && b.length <= MAX_NAME_LENGTH)
  ) {
    res
      .status(400)
      .json({ error: "BAD_REQUEST", message: "backups must be a non-empty array of names." });
    return;
  }
  // An explicit id never falls back to the active document.
  const docState = getCurrentDoc(documentId);
  if (!docState) {
    res.status(404).json({ error: "NOT_FOUND", message: "Document is not open." });
    return;
  }
  if (docState.source !== "file") {
    res.json({ data: { acknowledged: false } });
    return;
  }
  try {
    const acknowledged = await acknowledgeKeptEdits(
      docState.filePath,
      resolveAppDataDir(),
      backups as string[],
    );
    res.json({ data: { acknowledged } });
  } catch (err) {
    // Not recorded: say so, so the banner can show its error rather than
    // vanish and come straight back.
    console.error("[Backups] could not record a dismissed kept-edits notice:", err);
    res.status(500).json({ error: "ACK_FAILED", message: "The dismissal could not be saved." });
  }
}
