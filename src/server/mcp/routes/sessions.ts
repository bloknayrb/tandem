import type { Request, Response } from "express";

import { API_SESSIONS_CLEAR, API_SESSIONS_DELETE } from "../../../shared/api-paths.js";
import { isStoreReadOnly } from "../../annotations/store.js";
import {
  assertLoopbackForMutation,
  assertOriginAllowlisted,
} from "../../integrations/api-routes.js";
import { clearAllSessions, deleteSession, listSessionsMetadata } from "../../session/manager.js";
import { sendApiError } from "./_shared.js";

/**
 * GET /api/sessions — list persisted document sessions with metadata
 * (file path, last-accessed, live annotation count). Read-only; no loopback
 * gate (consistent with the other read-only GET routes).
 */
export async function handleListSessions(_req: Request, res: Response): Promise<void> {
  try {
    const sessions = await listSessionsMetadata();
    res.json({ data: { sessions } });
  } catch (err: unknown) {
    sendApiError(res, err);
  }
}

/**
 * POST /api/sessions/delete — delete a single persisted session by file path.
 * Mutating: gated on origin allowlist + loopback before any state change.
 */
export async function handleDeleteSession(req: Request, res: Response): Promise<void> {
  if (assertOriginAllowlisted(req, res, API_SESSIONS_DELETE)) return;
  if (assertLoopbackForMutation(req, res)) return;

  if (isStoreReadOnly()) {
    res.status(403).json({ error: "FORBIDDEN", message: "Store is read-only." });
    return;
  }

  const { filePath } = (req.body ?? {}) as Record<string, unknown>;
  if (!filePath || typeof filePath !== "string") {
    res.status(400).json({ error: "BAD_REQUEST", message: "filePath is required" });
    return;
  }
  try {
    await deleteSession(filePath);
    res.json({ data: { deleted: true } });
  } catch (err: unknown) {
    sendApiError(res, err);
  }
}

/**
 * POST /api/sessions/clear — delete all persisted document sessions
 * (chat history + upload sessions preserved). Mutating: gated on origin
 * allowlist + loopback before any state change.
 */
export async function handleClearSessions(req: Request, res: Response): Promise<void> {
  if (assertOriginAllowlisted(req, res, API_SESSIONS_CLEAR)) return;
  if (assertLoopbackForMutation(req, res)) return;

  if (isStoreReadOnly()) {
    res.status(403).json({ error: "FORBIDDEN", message: "Store is read-only." });
    return;
  }

  try {
    const cleared = await clearAllSessions();
    res.json({ data: { cleared } });
  } catch (err: unknown) {
    sendApiError(res, err);
  }
}
