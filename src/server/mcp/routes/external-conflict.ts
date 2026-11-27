import type { Request, Response } from "express";

import { API_EXTERNAL_CONFLICT_RESOLVE } from "../../../shared/api-paths.js";
import { getActiveDocId, hasDoc } from "../../documents/registry.js";
import { resolveExternalConflict } from "../../documents/reload-family.js";
import {
  assertLoopbackForMutation,
  assertOriginAllowlisted,
} from "../../integrations/api-routes.js";
import { sendApiError, sendEditorBackupFailed } from "./_shared.js";

/**
 * POST /api/external-conflict/resolve — resolve a pending external-conflict
 * prompt (#1069, widened to every format in #1238). Body:
 * `{ documentId?, choice: "keep" | "reload" }`.
 *
 * - "keep": keep the in-memory unsaved edits and re-baseline so explicit save
 *   unblocks (the next save overwrites the on-disk version).
 * - "reload": reload from disk through the file-watcher reload lifecycle
 *   (annotations preserved + re-anchored), keeping the unsaved edits it
 *   discards as a backup first (ADR-057, PR 3). If they cannot be kept the
 *   reload is refused with `409 BACKUP_FAILED`, and the banner offers
 *   "Reload anyway", which sends `discardUnsavedEdits: true`. That flag is not
 *   a new destructive capability (#2027's class): it is this route's
 *   behaviour before PR 3, behind the same origin and loopback gates, and a
 *   `text/plain` POST parses no body, so it fails the `choice` check.
 * - "keep" also keeps the version on disk as a backup first, since the next
 *   save overwrites it.
 *
 * Gated on origin allowlist + loopback (#1121 F6): resolving a conflict is a
 * destructive state change and must not be reachable by authenticated LAN
 * peers. Idempotent: resolving with no pending conflict is a no-op success
 * (double-click / stale-banner race).
 *
 * `documentId` is accepted from the body (mirroring POST /api/save): the conflict
 * banner is per-tab and the server's active doc does NOT track the client's
 * focused tab, so an active-doc-only handler resolves the wrong document
 * whenever another tab is server-active (e.g. CHANGELOG opened on upgrade). The
 * id is only a selector among already-open docs — the filesystem path used by
 * `resolveExternalConflict` comes from the server's own `OpenDoc` registry
 * (`existing.filePath`), never from request input, so there is no request→FS
 * taint path. `hasDoc` is a fail-loud UX guard, not the security boundary:
 * `resolveExternalConflict` already fails closed (throws NO_DOCUMENT) on an
 * unknown id.
 *
 * `detectedAt` is accepted from the body (optional, #1238 review finding):
 * the conflict episode's identity, as the client last observed it. Without
 * it, a race is reachable — the user sees conflict A, clicks "Keep"; a second
 * external write replaces the pending conflict with a different episode B
 * before this request lands; resolving whatever is CURRENTLY pending under
 * A's semantics would silently accept B's disk state with no banner ever
 * shown for B. `resolveExternalConflict` no-ops instead of resolving the
 * wrong episode when this doesn't match what's actually pending.
 */
export async function handleResolveExternalConflict(req: Request, res: Response): Promise<void> {
  if (assertOriginAllowlisted(req, res, API_EXTERNAL_CONFLICT_RESOLVE)) return;
  if (assertLoopbackForMutation(req, res)) return;
  const { documentId, choice, detectedAt, discardUnsavedEdits } = (req.body ?? {}) as Record<
    string,
    unknown
  >;
  if (choice !== "keep" && choice !== "reload") {
    res.status(400).json({ error: "BAD_REQUEST", message: 'choice must be "keep" or "reload".' });
    return;
  }
  if (documentId !== undefined && typeof documentId !== "string") {
    res.status(400).json({ error: "BAD_REQUEST", message: "documentId must be a string" });
    return;
  }
  // Strict: only a literal `true` discards; it means nothing to Keep.
  if (
    discardUnsavedEdits !== undefined &&
    (typeof discardUnsavedEdits !== "boolean" || choice !== "reload")
  ) {
    res.status(400).json({
      error: "BAD_REQUEST",
      message: 'discardUnsavedEdits must be a boolean, and only with choice "reload".',
    });
    return;
  }
  if (detectedAt !== undefined && typeof detectedAt !== "number") {
    res.status(400).json({ error: "BAD_REQUEST", message: "detectedAt must be a number" });
    return;
  }
  if (typeof documentId === "string" && documentId.length > 0 && !hasDoc(documentId)) {
    res.status(400).json({ error: "NO_DOCUMENT", message: `Document ${documentId} is not open.` });
    return;
  }
  const docId = documentId?.length ? documentId : getActiveDocId();
  if (!docId) {
    res.status(400).json({ error: "BAD_REQUEST", message: "No active document." });
    return;
  }
  try {
    const result = await resolveExternalConflict(docId, choice, detectedAt, {
      discardUnsavedEdits: discardUnsavedEdits === true,
    });
    res.json({ success: true, ...(result ?? {}) });
  } catch (err: unknown) {
    if (
      sendEditorBackupFailed(
        res,
        err,
        "Couldn't keep a backup of your unsaved edits first, so nothing was reloaded. " +
          "Tandem's backup folder may be full or not writable, or the edits could not be read.",
      )
    ) {
      return;
    }
    sendApiError(res, err);
  }
}
