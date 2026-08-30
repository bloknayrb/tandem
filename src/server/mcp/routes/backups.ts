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
import { hasDoc } from "../../documents/registry.js";
import { restoreDocumentFromBackup } from "../../documents/reload-family.js";
import { listDocBackups } from "../../file-io/doc-backup.js";
import {
  assertLoopbackForMutation,
  assertOriginAllowlisted,
} from "../../integrations/api-routes.js";
import { resolveAppDataDir } from "../../platform.js";
import { getCurrentDoc } from "../document-service.js";
import { isValidDocumentId, scrubPathForCaller, sendApiError } from "./_shared.js";

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

  // #1295 L2: the target used to come from global state — `getCurrentDoc()` with
  // no argument — while the list twin already accepted `documentId` from the
  // query. A client could therefore list snapshots for doc A and have the
  // restore land on doc B if the active document changed in between (another
  // window, an MCP tandem_open, or the scratchpad CSRF above). It failed closed
  // only INCIDENTALLY: the snapshot name resolves against B's path hash, so a
  // mismatch yielded FILE_NOT_FOUND rather than writing A's bytes over B. That
  // safety came from the directory layout, not from any check here — the same
  // hazard handleResolveExternalConflict was fixed for in #1238.
  //
  // The client already sends this field; only the server ignored it. Kept
  // OPTIONAL so an omitting caller keeps the previous behaviour. Because this
  // is a destructive route now taking attacker-influenceable input, it mirrors
  // document-reload.ts's FULL shape check — length and character class — before
  // the registry lookup, not just the existence check.
  const { documentId } = (req.body ?? {}) as Record<string, unknown>;
  if (documentId !== undefined) {
    if (!isValidDocumentId(documentId)) {
      res.status(400).json({ error: "BAD_REQUEST", message: "documentId is invalid." });
      return;
    }
    if (!hasDoc(documentId)) {
      res.status(404).json({ error: "NOT_FOUND", message: "Document is not open." });
      return;
    }
  }

  const docState = getCurrentDoc(typeof documentId === "string" ? documentId : undefined);
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
