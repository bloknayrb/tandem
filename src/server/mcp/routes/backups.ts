/**
 * Pre-overwrite document backup routes (#1086).
 *
 * GET  /api/backups          — list restorable snapshots for a document
 * POST /api/backups/restore  — restore one snapshot through the reload lifecycle
 *
 * Both routes ride the standard `apiMiddleware` (Host-header DNS-rebinding
 * check + CORS Origin allowlist). Like /api/rename, the mutating POST has no
 * extra loopback gate: CSRF is closed because a cross-origin JSON POST
 * triggers a preflight that the middleware answers with Allow-Origin: null,
 * and the restore can only target an already-open document's own snapshots
 * (server-enumerated names — no caller-supplied paths reach the filesystem).
 */

import path from "node:path";

import type { Request, Response } from "express";
import { listDocBackups } from "../../file-io/doc-backup.js";
import { resolveAppDataDir } from "../../platform.js";
import { getCurrentDoc } from "../document-service.js";
import { restoreDocumentFromBackup } from "../file-opener.js";
import { sendApiError } from "./_shared.js";

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
  try {
    const backups = await listDocBackups(docState.filePath, resolveAppDataDir());
    res.json({ data: { filePath: docState.filePath, backups } });
  } catch (err) {
    sendApiError(res, err);
  }
}

export async function handleRestoreBackup(req: Request, res: Response): Promise<void> {
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
    res.json({ data: result });
  } catch (err) {
    sendApiError(res, err);
  }
}
