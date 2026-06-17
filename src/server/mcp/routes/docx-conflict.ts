import type { Request, Response } from "express";

import { API_DOCX_CONFLICT_RESOLVE } from "../../../shared/api-paths.js";
import { getActiveDocId } from "../../documents/registry.js";
import {
  assertLoopbackForMutation,
  assertOriginAllowlisted,
} from "../../integrations/api-routes.js";
import { resolveExternalConflict } from "../file-opener.js";
import { sendApiError } from "./_shared.js";

/**
 * POST /api/docx-conflict/resolve — resolve a pending `.docx` external-conflict
 * prompt (#1069). Body: `{ choice: "keep" | "reload" }`.
 *
 * - "keep": keep the in-memory unsaved edits and re-baseline so explicit save
 *   unblocks (the next save overwrites the on-disk version).
 * - "reload": discard the unsaved edits, reload from disk through the
 *   file-watcher reload lifecycle (annotations preserved + re-anchored).
 *
 * Gated on origin allowlist + loopback (#1121 F6): resolving a docx conflict
 * is a destructive state change and must not be reachable by authenticated LAN
 * peers. Idempotent: resolving with no pending conflict is a no-op success
 * (double-click / stale-banner race).
 *
 * The conflict banner always refers to the active document, so documentId is
 * not accepted from the request body — the active document is the only
 * meaningful target and accepting user-supplied IDs would introduce an
 * unnecessary taint path from request input to FS operations.
 */
export async function handleResolveDocxConflict(req: Request, res: Response): Promise<void> {
  if (assertOriginAllowlisted(req, res, API_DOCX_CONFLICT_RESOLVE)) return;
  if (assertLoopbackForMutation(req, res)) return;
  const { choice } = (req.body ?? {}) as Record<string, unknown>;
  if (choice !== "keep" && choice !== "reload") {
    res.status(400).json({ error: "BAD_REQUEST", message: 'choice must be "keep" or "reload".' });
    return;
  }
  const docId = getActiveDocId();
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
