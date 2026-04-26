import type { Request, Response } from "express";
import { Y_MAP_ANNOTATIONS } from "../../../shared/constants.js";
import { generateNotificationId } from "../../../shared/utils.js";
import { pushNotification } from "../../notifications.js";
import { getOrCreateDocument } from "../../yjs/provider.js";
import { removeAnnotationById } from "../annotations.js";
import { getCurrentDoc } from "../document.js";

export function handleRemoveAnnotation(req: Request, res: Response): void {
  const { annotationId, documentId } = (req.body ?? {}) as Record<string, unknown>;
  if (!annotationId || typeof annotationId !== "string") {
    res.status(400).json({ error: "BAD_REQUEST", message: "annotationId is required" });
    return;
  }

  const doc = getCurrentDoc(typeof documentId === "string" ? documentId : undefined);
  if (!doc) {
    res.status(404).json({ error: "NOT_FOUND", message: "No document open" });
    return;
  }
  const ydoc = getOrCreateDocument(doc.docName);
  const annotationsMap = ydoc.getMap(Y_MAP_ANNOTATIONS);

  const result = removeAnnotationById(ydoc, annotationsMap, doc.filePath, annotationId);
  if (!result.ok) {
    const status = result.code === "NOT_FOUND" ? 404 : 400;
    console.warn(`[Tandem] API error (${status}): remove annotation failed: ${result.error}`);
    pushNotification({
      id: generateNotificationId(),
      type: "annotation-error",
      severity: "error",
      message: `Remove failed: ${result.error}`,
      dedupKey: `remove-error:${annotationId}`,
      timestamp: Date.now(),
    });
    res.status(status).json({ error: result.code, message: result.error });
    return;
  }
  res.json({ data: { removed: true, annotationId } });
}
