import type * as Y from "yjs";
import { API_ANNOTATION_REPLY, API_REMOVE_ANNOTATION } from "../../shared/api-paths";
import { Y_MAP_ANNOTATIONS } from "../../shared/constants";
import { withBrowser } from "../../shared/origins";
import { sanitizeAnnotation } from "../../shared/sanitize";
import type { Annotation, AnnotationType, TandemMode } from "../../shared/types";
import { API_BASE } from "../utils/fileUpload";

const warn = (event: unknown): void => {
  console.warn("[sanitize]", event);
};

/**
 * WS-A2: whether a user-created annotation of `type` should be stamped
 * `heldInSolo: true`. Only AI-visible comments qualify — notes and highlights
 * are never sent to Claude (ADR-027), so they are not "held from the AI" and
 * carry no held marker or badge. Hiding itself is server-authoritative
 * (mode-based); this persisted marker is only the UI-badge / fail-closed-restart
 * substrate. Shared by the toolbar create path and the note→comment promotion
 * transform so the two can't drift on which writes count as held.
 */
export function heldInSoloOnCreate(type: AnnotationType, mode: TandemMode): boolean {
  return type === "comment" && mode === "solo";
}

export function editAnnotation(ydoc: Y.Doc | null, id: string, newContent: string): void {
  if (!ydoc) return;
  const map = ydoc.getMap(Y_MAP_ANNOTATIONS);
  const raw = map.get(id) as Annotation | undefined;
  if (!raw) return;
  const ann = sanitizeAnnotation(raw, warn);

  withBrowser(ydoc, () => {
    if (ann.suggestedText !== undefined) {
      try {
        const parsed = JSON.parse(newContent) as { suggestedText: string; content: string };
        map.set(id, {
          ...ann,
          suggestedText: parsed.suggestedText,
          content: parsed.content,
          editedAt: Date.now(),
          rev: (ann.rev ?? 0) + 1,
        });
      } catch {
        console.warn(`[annotation-actions] Failed to parse edit payload for annotation ${id}`);
      }
      return;
    }
    map.set(id, { ...ann, content: newContent, editedAt: Date.now(), rev: (ann.rev ?? 0) + 1 });
  });
}

/**
 * Build the promotion payload — shared between the single-card
 * `sendNoteToClaude` path and the batch `promoteNotesToComments` helper so
 * the two can't drift on the channel-event gate's invariants (note→comment,
 * author "import" → "user", audience → "outbound", `promotedFrom: "note"`).
 */
function promotedAnnotation(ann: Annotation, tandemMode: TandemMode): Annotation {
  // Strip note/highlight-specific fields when collapsing to the comment
  // variant — the discriminated union rejects a `color` on a comment. Also drop
  // any inherited `heldInSolo` so the marker below is re-derived from the CURRENT
  // mode (a clean strip when promoting in Tandem, without writing an explicit
  // `undefined` key into CRDT state).
  const {
    color: _color,
    suggestedText: _suggestedText,
    heldInSolo: _staleHeld,
    ...rest
  } = ann as Annotation & {
    color?: unknown;
    suggestedText?: unknown;
  };
  return {
    ...rest,
    type: "comment" as const,
    author: ann.author === "import" ? ("user" as const) : ann.author,
    audience: "outbound" as const,
    promotedFrom: "note" as const,
    rev: (ann.rev ?? 0) + 1,
    // WS-A2 (A-F2): a note promoted to a comment while in Solo is a held comment
    // — mark it so the badge + fail-closed restart match a directly-created
    // Solo comment. The result is always a comment, so pass "comment" to the
    // shared predicate (keeps this and the toolbar create path from drifting).
    ...(heldInSoloOnCreate("comment", tandemMode) ? { heldInSolo: true } : {}),
  };
}

export function sendNoteToClaude(
  ydoc: Y.Doc | null,
  annotationId: string,
  tandemMode: TandemMode = "tandem",
): void {
  if (!ydoc) return;
  const map = ydoc.getMap(Y_MAP_ANNOTATIONS);
  const raw = map.get(annotationId) as Annotation | undefined;
  if (!raw) return;
  const ann = sanitizeAnnotation(raw, warn);
  if (ann.type !== "note") return;
  // withBrowser tags the transact as user-originated so the channel queue
  // emits the note→comment promotion event. A bare map.set produces an
  // undefined-origin transact that the skip set's evolution could quietly
  // start dropping.
  withBrowser(ydoc, () => {
    map.set(annotationId, promotedAnnotation(ann, tandemMode));
  });
}

/**
 * Batch variant of `sendNoteToClaude`. Single Y.Doc transact so the durable
 * sync observer sees one batched write per submission rather than N inflight
 * mutations. The observer fans out to per-annotation channel events on its
 * own — batching here is purely a write-coalescing optimization.
 */
export function promoteNotesToComments(
  ydoc: Y.Doc | null,
  annotationIds: string[],
  tandemMode: TandemMode = "tandem",
): number {
  if (!ydoc || annotationIds.length === 0) return 0;
  const map = ydoc.getMap(Y_MAP_ANNOTATIONS);
  let promoted = 0;
  withBrowser(ydoc, () => {
    for (const id of annotationIds) {
      const raw = map.get(id) as Annotation | undefined;
      if (!raw) continue;
      const ann = sanitizeAnnotation(raw, warn);
      if (ann.type !== "note") continue;
      map.set(id, promotedAnnotation(ann, tandemMode));
      promoted++;
    }
  });
  return promoted;
}

export async function removeAnnotation(
  annotationId: string,
  documentId: string | undefined,
): Promise<void> {
  try {
    const resp = await fetch(`${API_BASE}${API_REMOVE_ANNOTATION}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ annotationId, documentId }),
    });
    if (!resp.ok) {
      const err = await resp.json().catch(() => ({ message: "Unknown error" }));
      console.error("[Tandem] Remove annotation failed:", err);
    }
  } catch (e) {
    console.error("[Tandem] Remove annotation failed:", e);
  }
}

export async function replyToAnnotation(
  annotationId: string,
  text: string,
  documentId: string | undefined,
): Promise<boolean> {
  try {
    const res = await fetch(`${API_BASE}${API_ANNOTATION_REPLY}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ annotationId, text, documentId }),
    });
    if (!res.ok) {
      const data = (await res.json().catch(() => ({}))) as Record<string, unknown>;
      console.warn(
        `[annotation-actions] Reply failed (${res.status}): ${data.message ?? "unknown error"}`,
      );
      return false;
    }
    return true;
  } catch (err) {
    console.error("[annotation-actions] Reply request failed:", err);
    return false;
  }
}
