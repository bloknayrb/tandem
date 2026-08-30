import type { Request, Response } from "express";

import { API_DOCUMENT_RELOAD } from "../../../shared/api-paths.js";
import { hasDoc } from "../../documents/registry.js";
import { reloadDocumentFromMarkdown } from "../../documents/reload-family.js";
import {
  assertLoopbackForMutation,
  assertOriginAllowlisted,
} from "../../integrations/api-routes.js";
import { isValidDocumentId, sendApiError } from "./_shared.js";

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
 * The client must send the source view's exact document ID. Active-document
 * state is process-global and can change in another window while a source
 * commit is in flight, so it is never used as a fallback here. The ID is
 * bounded, restricted to room-name characters, and re-resolved against the
 * live registry before the server-managed file path can be reached.
 */
export async function handleReloadFromMarkdown(req: Request, res: Response): Promise<void> {
  if (assertOriginAllowlisted(req, res, API_DOCUMENT_RELOAD)) return;
  if (assertLoopbackForMutation(req, res)) return;
  const { documentId, markdown } = (req.body ?? {}) as Record<string, unknown>;
  if (!isValidDocumentId(documentId)) {
    res.status(400).json({ error: "BAD_REQUEST", message: "documentId is invalid." });
    return;
  }
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
  if (!hasDoc(documentId)) {
    res.status(404).json({ error: "NOT_FOUND", message: "Document is not open." });
    return;
  }
  try {
    await reloadDocumentFromMarkdown(documentId, markdown);
    res.json({ success: true });
  } catch (err: unknown) {
    sendApiError(res, err);
  }
}
