import type { Request, Response } from "express";
import { Y_MAP_ANNOTATIONS } from "../../../shared/constants.js";
import { generateNotificationId } from "../../../shared/utils.js";
import { removeAnnotationRecord } from "../../annotations/lifecycle.js";
import { pushNotification } from "../../notifications.js";
import { getOrCreateDocument } from "../../yjs/provider.js";
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

  // **`removeAnnotationRecord`, NOT `AnnotationLifecycle.remove`** — the
  // difference is the ADR-027 note guard, and this route must not have it.
  // Archive is how the user deletes their own private note; routing this call
  // through the guarded member is #1680 verbatim, and it is pinned by a spec
  // that drives THIS handler rather than the mechanism (a spec on the mechanism
  // stays green through exactly that rewiring). The wrapper is left to the
  // default `withBrowser`, matching `annotation-reply.ts`.
  const result = removeAnnotationRecord(ydoc, annotationsMap, annotationId);
  if (result.kind !== "ok") {
    // One arm, and the TYPE is what says so: the mechanism returns
    // `RemoveMechanismResult`, which subtracts `invalid-note` — the arm only
    // the guarded member produces. So `result` narrows to `not-found` here and
    // there is no branch to get wrong. An earlier draft wrote a ternary and a
    // comment claiming a new arm would be a compile error; a ternary's `else`
    // absorbs one silently, and two reviewers demonstrated exactly that.
    const message = `Annotation ${annotationId} not found`;
    console.warn(`[Tandem] API error (404): remove annotation failed: ${message}`);
    pushNotification({
      id: generateNotificationId(),
      type: "annotation-error",
      severity: "error",
      message: `Remove failed: ${message}`,
      dedupKey: `remove-error:${annotationId}`,
      timestamp: Date.now(),
    });
    res.status(404).json({ error: "NOT_FOUND", message });
    return;
  }
  res.json({ data: { removed: true, annotationId } });
}
