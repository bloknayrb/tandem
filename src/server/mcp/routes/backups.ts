/**
 * Pre-overwrite document backup routes (#1086).
 *
 * GET  /api/backups          — list restorable snapshots for a document
 * POST /api/backups/restore  — restore one snapshot through the reload lifecycle
 *
 * Both routes ride the standard `apiMiddleware` (Host-header DNS-rebinding
 * check + CORS Origin allowlist). The GET strips the absolute filePath to a
 * basename for non-loopback callers (#1121 F5). The mutating POST additionally
 * gates on origin allowlist + loopback (#1121 F6).
 */

import path from "node:path";

import type { Request, Response } from "express";
import { API_BACKUPS_RESTORE } from "../../../shared/api-paths.js";
import { listDocBackups } from "../../file-io/doc-backup.js";
import {
  assertLoopbackForMutation,
  assertOriginAllowlisted,
} from "../../integrations/api-routes.js";
import { resolveAppDataDir } from "../../platform.js";
import { getCurrentDoc } from "../document-service.js";
import { restoreDocumentFromBackup } from "../file-opener.js";
import { scrubPathForCaller, sendApiError } from "./_shared.js";

export async function handleListBackups(req: Request, res: Response): Promise<void> {
  const raw = req.query.documentId;
  if (raw !== undefined && typeof raw !== "string") {
    res.status(400).json({ error: "BAD_REQUEST", message: "documentId must be a string" });
    return;
  }
  const docState = getCurrentDoc(raw);
  if (!docState) {
    res.status(404).json({ error: "NOT_FOUND", message: "Document is not open." });
    return;
  }
  // upload:// / scratchpad docs have no on-disk path, hence no backups.
  if (docState.source !== "file") {
    res.json({ data: { filePath: null, backups: [] } });
    return;
  }
  // Strip the absolute path to a basename for non-loopback callers (#1121 F5):
  // the home-directory layout must not be disclosed across the network. Routed
  // through the shared helper (#1294) so this read twin and the mutating twin
  // below cannot drift apart again — that drift is what created #1294.
  const filePath = scrubPathForCaller(req, docState.filePath);
  try {
    const backups = await listDocBackups(docState.filePath, resolveAppDataDir());
    res.json({ data: { filePath, backups } });
  } catch (err) {
    sendApiError(res, err);
  }
}

export async function handleRestoreBackup(req: Request, res: Response): Promise<void> {
  if (assertOriginAllowlisted(req, res, API_BACKUPS_RESTORE)) return;
  if (assertLoopbackForMutation(req, res)) return;
  const { backup } = (req.body ?? {}) as Record<string, unknown>;
  if (typeof backup !== "string" || backup.length === 0) {
    res.status(400).json({ error: "BAD_REQUEST", message: "backup must be a non-empty string" });
    return;
  }
  // path.basename strips any directory components from the caller-supplied
  // backup name, eliminating path-traversal taint before it reaches the FS.
  // docBackupSnapshotPath also validates against SNAPSHOT_TAIL_RE as a second
  // layer, but basename here is the CodeQL-visible sanitizer.
  const safeBackup = path.basename(backup);
  const docState = getCurrentDoc();
  if (!docState) {
    res.status(404).json({ error: "NOT_FOUND", message: "Document is not open." });
    return;
  }
  try {
    const result = await restoreDocumentFromBackup(docState.id, safeBackup);
    // #1294: the read twin above already basenames `filePath` for non-loopback
    // callers; this mutating twin returned `restoredFrom` and `filePath`
    // verbatim. Same route family, same disclosure — scrub both identically.
    res.json({
      data: {
        ...result,
        restoredFrom: scrubPathForCaller(req, result.restoredFrom),
        filePath: scrubPathForCaller(req, result.filePath),
      },
    });
  } catch (err) {
    sendApiError(res, err);
  }
}
