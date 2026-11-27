/**
 * Pre-overwrite document backup routes (#1086).
 *
 * GET  /api/backups          — list restorable snapshots for a document, and
 *                              the kept edits the user has not been told about
 * POST /api/backups/restore  — restore one snapshot through the reload lifecycle
 *                              (the editor's Version history: keeps the
 *                              document's unsaved edits first, ADR-057)
 *
 * The acknowledge route lives in `backups-ack.ts`, one module per mutating
 * handler, because `tests/docs/loopback-gate-claims.test.ts` resolves gates
 * per module.
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
import { keptEditsNotice, listDocBackups } from "../../file-io/doc-backup.js";
import {
  assertLoopbackForMutation,
  assertOriginAllowlisted,
} from "../../integrations/api-routes.js";
import { resolveAppDataDir } from "../../platform.js";
import { getCurrentDoc } from "../document-service.js";
import {
  isValidDocumentId,
  scrubPathForCaller,
  sendApiError,
  sendEditorBackupFailed,
} from "./_shared.js";

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
    res.json({ data: { filePath: null, backups: [], keptNotice: null } });
    return;
  }
  // Strip the absolute path to a basename for non-loopback callers (#1121 F5):
  // the home-directory layout must not be disclosed across the network. Routed
  // through the shared helper (#1294) so this read twin and the mutating twin
  // below cannot drift apart again — that drift is what created #1294.
  const filePath = scrubPathForCaller(req, docState.filePath);
  try {
    const appDataDir = resolveAppDataDir();
    const backups = await listDocBackups(docState.filePath, appDataDir);
    // Never throws: an unreadable ack file reads as "nothing acknowledged".
    const keptNotice = await keptEditsNotice(docState.filePath, appDataDir, backups);
    res.json({ data: { filePath, backups, keptNotice } });
  } catch (err) {
    sendApiError(res, err);
  }
}

export async function handleRestoreBackup(req: Request, res: Response): Promise<void> {
  if (assertOriginAllowlisted(req, res, API_BACKUPS_RESTORE)) return;
  if (assertLoopbackForMutation(req, res)) return;
  const { backup, discardUnsavedEdits } = (req.body ?? {}) as Record<string, unknown>;
  if (typeof backup !== "string" || backup.length === 0) {
    res.status(400).json({ error: "BAD_REQUEST", message: "backup must be a non-empty string" });
    return;
  }
  // Strict: only a literal `true` discards. Absent keeps the edits (ADR-057);
  // a truthy string such as "false" must never read as consent to lose them.
  if (discardUnsavedEdits !== undefined && typeof discardUnsavedEdits !== "boolean") {
    res
      .status(400)
      .json({ error: "BAD_REQUEST", message: "discardUnsavedEdits must be a boolean" });
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
    // Keeps the unsaved edits first unless the user chose "Restore anyway"
    // after a refused keep. `actor` is fixed here, never read from the body.
    // `discardUnsavedEdits` is not a new destructive capability (#2027's
    // class): it is this route's behaviour before ADR-057's PR 2, and it sits
    // behind the same origin and loopback gates.
    const result = await restoreDocumentFromBackup(docState.id, safeBackup, {
      keepUnsavedEdits: discardUnsavedEdits !== true,
      actor: "user",
    });
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
    // The snapshot named is gone (pruned or swept after the list loaded); the
    // shared message is addressed to Claude's tool.
    if ((err as { code?: unknown }).code === "FILE_NOT_FOUND") {
      res.status(404).json({
        error: "FILE_NOT_FOUND",
        message: "That backup no longer exists. The list has been refreshed.",
      });
      return;
    }
    if (
      sendEditorBackupFailed(
        res,
        err,
        "Couldn't keep a backup of your unsaved edits first, so nothing was restored. " +
          "Tandem's backup folder may be full or not writable; if it is full, restoring " +
          "anyway can't keep a copy of the file's current version either.",
      )
    ) {
      return;
    }
    sendApiError(res, err);
  }
}
