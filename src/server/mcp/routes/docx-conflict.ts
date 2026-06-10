import type { Request, Response } from "express";

import { getActiveDocId } from "../../documents/registry.js";
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
 */
// Document IDs are 64-char SHA-256 hex hashes or upload_<alphanumeric> strings.
// Validating the shape before use breaks CodeQL's js/path-injection taint chain
// (the string cannot reach any FS path if it doesn't match this safe pattern)
// and also rejects obviously-malformed inputs as a security improvement.
const VALID_DOC_ID_RE = /^(?:[a-f0-9]{64}|upload_[\w-]+)$/;

export async function handleResolveDocxConflict(req: Request, res: Response): Promise<void> {
  const { documentId, choice } = (req.body ?? {}) as Record<string, unknown>;
  if (choice !== "keep" && choice !== "reload") {
    res.status(400).json({ error: "BAD_REQUEST", message: 'choice must be "keep" or "reload".' });
    return;
  }
  const rawId = typeof documentId === "string" ? documentId : null;
  const docId = (rawId !== null && VALID_DOC_ID_RE.test(rawId) ? rawId : null) ?? getActiveDocId();
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
