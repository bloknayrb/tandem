import type { Request, Response } from "express";
import { Y_MAP_ANNOTATIONS } from "../../../shared/constants.js";
import { generateNotificationId } from "../../../shared/utils.js";
import { pushNotification } from "../../notifications.js";
import { getOrCreateDocument } from "../../yjs/provider.js";
import { addReplyToAnnotation } from "../annotations.js";
import type { Handler } from "../api-routes.js";
import { getCurrentDoc } from "../document.js";

export function makeAnnotationReplyHandler(): Handler {
  return (req: Request, res: Response) => {
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
    const annotationsMap = ydoc.getMap(Y_MAP_ANNOTATIONS);

    // No origin tag — allows event emission so Claude sees user replies
    const result = addReplyToAnnotation(ydoc, annotationsMap, annotationId, text, "user");
    if (!result.ok) {
      const status = result.code === "ANNOTATION_RESOLVED" ? 409 : 404;
      pushNotification({
        id: generateNotificationId(),
        type: "annotation-error",
        severity: "error",
        message: `Reply failed: ${result.error}`,
        dedupKey: `reply-error:${annotationId}`,
        timestamp: Date.now(),
      });
      res.status(status).json({ error: result.code, message: result.error });
      return;
    }
    res.json({ data: { replyId: result.replyId, annotationId } });
  };
}
