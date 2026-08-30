import type { Request, Response } from "express";
import { generateNotificationId } from "../../../shared/utils.js";
import { addUserReply, describeReplyWriteRefusal } from "../../annotations/lifecycle.js";
import { relaySanitizationEvent } from "../../annotations/migration-log.js";
import { pushNotification } from "../../notifications.js";
import { getOrCreateDocument } from "../../yjs/provider.js";
import { getCurrentDoc } from "../document.js";

export function handleAnnotationReply(req: Request, res: Response): void {
  const { annotationId, text, documentId } = (req.body ?? {}) as Record<string, unknown>;
  if (!annotationId || typeof annotationId !== "string") {
    res.status(400).json({ error: "BAD_REQUEST", message: "annotationId is required" });
    return;
  }
  if (!text || typeof text !== "string") {
    res.status(400).json({ error: "BAD_REQUEST", message: "text is required" });
    return;
  }

  const doc = getCurrentDoc(typeof documentId === "string" ? documentId : undefined);
  if (!doc) {
    res.status(404).json({ error: "NOT_FOUND", message: "No document open" });
    return;
  }
  const ydoc = getOrCreateDocument(doc.docName);

  // **`addUserReply`, NOT `lifecycle.reply`** — the difference is the ADR-027
  // guard, and this route must not have it: replying to one's own private note
  // is exactly what ADR-027 permits. The origin is `browser` inside the entry
  // rather than a parameter here; `browser` is the one origin outside
  // `CHANNEL_SKIP`, so a parameter would be a way to silence a user's reply.
  // (The comment this replaces said "no origin tag", which had been stale since
  // the `withBrowser` default landed.)
  const result = addUserReply(ydoc, annotationId, text, (event) =>
    relaySanitizationEvent(doc.docName, event),
  );
  if (result.kind === "ok") {
    res.json({ data: { replyId: result.replyId, annotationId } });
    return;
  }
  const { code, message } = describeReplyWriteRefusal(result);
  // Status from the CODE, not the arm. The code set is closed and does not
  // grow when the result union does, so this mapping cannot go stale behind
  // a new arm — the arm is forced through `describeReplyWriteRefusal`'s anchor
  // first.
  const status = code === "ANNOTATION_RESOLVED" ? 409 : code === "NOT_FOUND" ? 404 : 400;
  console.warn(`[Tandem] API error (${status}): annotation reply failed: ${message}`);
  pushNotification({
    id: generateNotificationId(),
    type: "annotation-error",
    severity: "error",
    message: `Reply failed: ${message}`,
    dedupKey: `reply-error:${annotationId}`,
    timestamp: Date.now(),
  });
  res.status(status).json({ error: code, message });
}
