import type { Request, Response } from "express";
import { generateNotificationId } from "../../../shared/utils.js";
import { removeAnnotationRecord } from "../../annotations/lifecycle.js";
import { pushNotification } from "../../notifications.js";
import { getOrCreateDocument } from "../../yjs/provider.js";
import { getCurrentDoc } from "../document.js";

/**
 * Report a failed Archive on BOTH surfaces, from every exit.
 *
 * The client half is one-way: `panels/annotation-actions.ts#removeAnnotation`
 * returns `Promise<void>`, `SidePanel.svelte` calls it un-awaited, and a
 * `!resp.ok` produces a `console.error` nobody reads. So this notification is
 * the *only* thing that tells the user their Archive did nothing — and review
 * found that two of the three exits below had neither it nor a log line, with
 * `No document open` reachable through an ordinary tab swap between render and
 * click. The failure was a card that stays put and no trace anywhere.
 *
 * `dedupKey` is per-reason rather than per-annotation for the two exits that
 * have no usable id, so a jammed panel cannot stack toasts.
 */
function failRemove(res: Response, status: number, message: string, dedupKey: string): void {
  console.warn(`[Tandem] API error (${status}): remove annotation failed: ${message}`);
  pushNotification({
    id: generateNotificationId(),
    type: "annotation-error",
    severity: "error",
    message: `Remove failed: ${message}`,
    dedupKey,
    timestamp: Date.now(),
  });
  res.status(status).json({ error: status === 400 ? "BAD_REQUEST" : "NOT_FOUND", message });
}

export function handleRemoveAnnotation(req: Request, res: Response): void {
  const { annotationId, documentId } = (req.body ?? {}) as Record<string, unknown>;
  if (!annotationId || typeof annotationId !== "string") {
    failRemove(res, 400, "annotationId is required", "remove-error:no-id");
    return;
  }

  const doc = getCurrentDoc(typeof documentId === "string" ? documentId : undefined);
  if (!doc) {
    failRemove(res, 404, "No document open", "remove-error:no-document");
    return;
  }
  const ydoc = getOrCreateDocument(doc.docName);

  // **`removeAnnotationRecord`, NOT `AnnotationLifecycle.remove`** — the
  // difference is the ADR-027 note guard, and this route must not have it.
  // Archive is how the user deletes their own private note; routing this call
  // through the guarded member is #1680 verbatim, and it is pinned by a spec
  // that drives THIS handler rather than the mechanism (a spec on the mechanism
  // stays green through exactly that rewiring). The wrapper is left to the
  // default `withBrowser`, matching `annotation-reply.ts`.
  const result = removeAnnotationRecord(ydoc, annotationId);
  // One arm today, and the type says so: the mechanism returns
  // `RemoveRecordResult`, which does not carry `invalid-note` — the arm only
  // the guarded member produces.
  //
  // **The `never` anchor is what makes that a guarantee rather than a
  // coincidence.** An earlier draft wrote a ternary plus a comment claiming a
  // new arm would be a compile error; a ternary's `else` absorbs one silently,
  // and two reviewers demonstrated it. The replacement narrowed the type — but
  // only in the direction with no reachable producer. An arm added to
  // `RemoveRecordResult` is one the mechanism CAN produce, and it landed here
  // as a hardcoded 404 with the wrong code and the wrong message, still with no
  // compile error. A third reviewer found that by compiling it.
  if (result.kind === "not-found") {
    failRemove(res, 404, `Annotation ${annotationId} not found`, `remove-error:${annotationId}`);
    return;
  }
  if (result.kind !== "ok") {
    // Unreachable today. It errors HERE, naming the arm, rather than as a
    // return-type mismatch somewhere up the call stack — which is the failure
    // mode the MCP handler had, and whose obvious "fix" is a generic `default`
    // that reinstates the silent absorption.
    const unhandled: never = result;
    res.status(500).json({
      error: "INTERNAL",
      message: `unhandled remove outcome: ${(unhandled as { kind: string }).kind}`,
    });
    return;
  }
  res.json({ data: { removed: true, annotationId } });
}
