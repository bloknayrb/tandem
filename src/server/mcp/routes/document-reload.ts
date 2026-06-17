import type { Request, Response } from "express";

import { API_DOCUMENT_RELOAD } from "../../../shared/api-paths.js";
import { getActiveDocId } from "../../documents/registry.js";
import {
  assertLoopbackForMutation,
  assertOriginAllowlisted,
} from "../../integrations/api-routes.js";
import { reloadDocumentFromMarkdown } from "../file-opener.js";
import { sendApiError } from "./_shared.js";

/**
 * 1 MB cap on the inline `markdown` field. `mdParser.parse` is synchronous and
 * blocks the event loop, so the 50 MB `largeBody` body limit is far too loose
 * for an inline reload argument — this mirrors `tandem_appendContent`'s cap.
 */
const MAX_RELOAD_MARKDOWN_BYTES = 1_000_000;

/**
 * POST /api/document/reload — replace a document's content from a user-supplied
 * markdown string (raw-markdown source view/edit, #1021).
 *
 * Gated on origin allowlist + loopback (#1121 F6): replacing document content
 * is destructive and must not be reachable by authenticated LAN peers.
 *
 * documentId is intentionally not accepted from the request body: the source
 * view is always rendered for the active document, so accepting a
 * user-supplied ID would introduce an unnecessary taint path from request
 * input to FS operations with no functional benefit.
 */
export async function handleReloadFromMarkdown(req: Request, res: Response): Promise<void> {
  if (assertOriginAllowlisted(req, res, API_DOCUMENT_RELOAD)) return;
  if (assertLoopbackForMutation(req, res)) return;
  const { markdown } = (req.body ?? {}) as Record<string, unknown>;
  if (typeof markdown !== "string") {
    res.status(400).json({ error: "BAD_REQUEST", message: "markdown (string) is required." });
    return;
  }
  if (Buffer.byteLength(markdown, "utf-8") > MAX_RELOAD_MARKDOWN_BYTES) {
    res
      .status(413)
      .json({ error: "PAYLOAD_TOO_LARGE", message: "Markdown exceeds the 1MB reload limit." });
    return;
  }
  const docId = getActiveDocId();
  if (!docId) {
    res.status(400).json({ error: "BAD_REQUEST", message: "No active document." });
    return;
  }
  try {
    await reloadDocumentFromMarkdown(docId, markdown);
    res.json({ success: true });
  } catch (err: unknown) {
    sendApiError(res, err);
  }
}
