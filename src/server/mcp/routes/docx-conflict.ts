import type { Request, Response } from "express";

import { getActiveDocId, hasDoc } from "../../documents/registry.js";
import { resolveExternalConflict } from "../file-opener.js";
import { sendApiError } from "./_shared.js";

/**
 * POST /api/docx-conflict/resolve — resolve a pending `.docx` external-conflict
 * prompt (#1069). Body: `{ documentId?, choice: "keep" | "reload" }`.
 *
 * - "keep": keep the in-memory unsaved edits and re-baseline so explicit save
 *   unblocks (the next save overwrites the on-disk version).
 * - "reload": discard the unsaved edits, reload from disk through the
 *   file-watcher reload lifecycle (annotations preserved + re-anchored).
 *
 * State-mutating, but same middleware posture as POST /api/save and
 * POST /api/document/reload: the `mw` DNS-rebinding + CORS gate closes CSRF (a
 * cross-origin JSON POST triggers a preflight answered with Allow-Origin:
 * null), so no separate loopback gate is needed. Idempotent: resolving with no
 * pending conflict is a no-op success (double-click / stale-banner race).
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
 */
export async function handleResolveDocxConflict(req: Request, res: Response): Promise<void> {
  const { documentId, choice } = (req.body ?? {}) as Record<string, unknown>;
  if (choice !== "keep" && choice !== "reload") {
    res.status(400).json({ error: "BAD_REQUEST", message: 'choice must be "keep" or "reload".' });
    return;
  }
  if (documentId !== undefined && typeof documentId !== "string") {
    res.status(400).json({ error: "BAD_REQUEST", message: "documentId must be a string" });
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
    await resolveExternalConflict(docId, choice);
    res.json({ success: true });
  } catch (err: unknown) {
    sendApiError(res, err);
  }
}
