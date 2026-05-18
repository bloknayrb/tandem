import type * as Y from "yjs";
import { API_ANNOTATION_REPLY, API_REMOVE_ANNOTATION } from "../../shared/api-paths";
import { Y_MAP_ANNOTATIONS } from "../../shared/constants";
import { withBrowser } from "../../shared/origins";
import { sanitizeAnnotation } from "../../shared/sanitize";
import type { Annotation } from "../../shared/types";
import { API_BASE } from "../utils/fileUpload";

const warn = (event: unknown): void => {
  console.warn("[sanitize]", event);
};

export function editAnnotation(ydoc: Y.Doc | null, id: string, newContent: string): void {
  if (!ydoc) return;
  const map = ydoc.getMap(Y_MAP_ANNOTATIONS);
  const raw = map.get(id) as Annotation | undefined;
  if (!raw) return;
  const ann = sanitizeAnnotation(raw, warn);

  if (ann.suggestedText !== undefined) {
    try {
      const parsed = JSON.parse(newContent) as { suggestedText: string; content: string };
      map.set(id, {
        ...ann,
        suggestedText: parsed.suggestedText,
        content: parsed.content,
        editedAt: Date.now(),
      });
    } catch {
      console.warn(`[annotation-actions] Failed to parse edit payload for annotation ${id}`);
    }
    return;
  }
  map.set(id, { ...ann, content: newContent, editedAt: Date.now() });
}

export function sendNoteToClaude(ydoc: Y.Doc | null, annotationId: string): void {
  if (!ydoc) return;
  const map = ydoc.getMap(Y_MAP_ANNOTATIONS);
  const raw = map.get(annotationId) as Annotation | undefined;
  if (!raw) return;
  const ann = sanitizeAnnotation(raw, warn);
  // Promote note → comment, audience → outbound, and re-author import-sourced
  // notes as user (the user is endorsing the imported reviewer comment as
  // their own ask to Claude). The annotations observer's note→comment add-
  // event path gates on `author === "user"`, so keeping `author: "import"`
  // here would silently fail to surface the new comment to the channel.
  map.set(annotationId, {
    ...ann,
    type: "comment" as const,
    author: ann.author === "import" ? ("user" as const) : ann.author,
    audience: "outbound" as const,
    promotedFrom: "note" as const,
  });
}

/**
 * Batch variant of `sendNoteToClaude`. Single Y.Doc transact so the durable
 * sync observer sees one batched write per submission rather than N inflight
 * mutations. The observer fans out to per-annotation channel events on its
 * own — batching here is purely a write-coalescing optimization.
 */
export function promoteNotesToComments(ydoc: Y.Doc | null, annotationIds: string[]): number {
  if (!ydoc || annotationIds.length === 0) return 0;
  const map = ydoc.getMap(Y_MAP_ANNOTATIONS);
  let promoted = 0;
  withBrowser(ydoc, () => {
    for (const id of annotationIds) {
      const raw = map.get(id) as Annotation | undefined;
      if (!raw) continue;
      const ann = sanitizeAnnotation(raw, warn);
      if (ann.type !== "note") continue;
      map.set(id, {
        ...ann,
        type: "comment" as const,
        author: ann.author === "import" ? ("user" as const) : ann.author,
        audience: "outbound" as const,
        promotedFrom: "note" as const,
      });
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
