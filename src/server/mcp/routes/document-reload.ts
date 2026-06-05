import type { Request, Response } from "express";

import { getActiveDocId } from "../../documents/registry.js";
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
 * State-mutating, but same middleware posture as POST /api/save and
 * POST /api/rename: the `mw` DNS-rebinding + CORS gate closes CSRF (a cross-
 * origin JSON POST triggers a preflight answered with Allow-Origin: null), so
 * no separate loopback gate is needed. The handler validates the markdown type
 * and size before the synchronous parse; `reloadDocumentFromMarkdown` enforces
 * the open / .md / not-read-only / not-already-reloading guards.
 */
export async function handleReloadFromMarkdown(req: Request, res: Response): Promise<void> {
  const { documentId, markdown } = (req.body ?? {}) as Record<string, unknown>;
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
  const docId = (typeof documentId === "string" ? documentId : null) ?? getActiveDocId();
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
