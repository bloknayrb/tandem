import type { Request, Response } from "express";
import { isLoopback } from "../../auth/middleware.js";
import { getActiveDocId, getOpenDocs } from "../../documents/registry.js";
import { saveMarkdown } from "../../file-io/markdown.js";
import { getOrCreateDocument } from "../../yjs/provider.js";

/**
 * GET /api/document/raw — return a document's literal markdown source (#1021).
 *
 * Serializes the Y.Doc via `saveMarkdown`, the exact function the markdown
 * FormatAdapter uses to write to disk, so the source view shows byte-identical
 * content to what autosave persists. This is the sanctioned use of the
 * markdown-serialization path: Critical Rule #5 forbids `extractMarkdown()` only
 * for annotation-coordinate contexts (it shifts offsets); here we want the
 * literal disk markdown, not plain text.
 *
 * Loopback-only (#1121 F5): returning the full document content over the
 * network would expose potentially sensitive document text to any authenticated
 * LAN peer. This matches the unconditional posture of /api/diagnostics.
 */
export function handleGetDocumentRaw(req: Request, res: Response): void {
  if (!isLoopback(req.socket.remoteAddress)) {
    res.status(403).json({ error: "FORBIDDEN", message: "Loopback only." });
    return;
  }
  const queryId = typeof req.query.documentId === "string" ? req.query.documentId : null;
  const docId = queryId ?? getActiveDocId();
  if (!docId) {
    res.status(400).json({ error: "BAD_REQUEST", message: "No active document." });
    return;
  }
  const entry = getOpenDocs().get(docId);
  if (!entry) {
    res.status(404).json({ error: "NOT_FOUND", message: "Document is not open." });
    return;
  }
  if (entry.format !== "md") {
    res
      .status(400)
      .json({ error: "BAD_REQUEST", message: "Only .md documents have a markdown source." });
    return;
  }
  const doc = getOrCreateDocument(docId);
  res.json({ markdown: saveMarkdown(doc) });
}
