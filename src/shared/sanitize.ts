import type { Annotation } from "./types.js";

/** Raw annotation from Y.Map — may contain legacy `suggestion`/`question` types. */
export type RawAnnotation = Omit<Annotation, "type"> & { type: string };

/**
 * Normalize a legacy annotation into the unified shape.
 * - `suggestion` → `comment` with `suggestedText` + `content` (parsed from JSON)
 * - `question` → `comment` with `directedAt: "claude"`
 * - Strips stray `color` from non-highlight entries (#245)
 * - Preserves `rev` (the durable-annotation last-writer-wins counter — added
 *   by the on-disk schema, see `src/server/annotations/schema.ts`). `rev` is
 *   a server-internal durability concept, not a client-facing annotation
 *   field, so it doesn't appear on the `Annotation` union type. Passthrough
 *   here is load-bearing: without it every sanitize-then-write cycle in the
 *   MCP tools would reset `rev` to undefined and the sync observer would
 *   serialize `rev: 0` forever.
 */
export function sanitizeAnnotation(input: Annotation | RawAnnotation): Annotation {
  const ann = input as RawAnnotation;

  // Build a base with only AnnotationBase fields (strip legacy type-specific fields)
  const base = {
    id: ann.id,
    author: ann.author,
    range: ann.range,
    content: ann.content,
    status: ann.status,
    timestamp: ann.timestamp,
    ...(ann.relRange !== undefined ? { relRange: ann.relRange } : {}),
    ...(ann.textSnapshot !== undefined ? { textSnapshot: ann.textSnapshot } : {}),
    ...(ann.editedAt !== undefined ? { editedAt: ann.editedAt } : {}),
    ...(typeof ann.rev === "number" ? { rev: ann.rev } : {}),
  };

  if (ann.type === "suggestion") {
    let suggestedText: string | undefined;
    let content: string;
    try {
      const parsed = JSON.parse(ann.content) as { newText?: string; reason?: string };
      suggestedText = parsed.newText;
      content = parsed.reason ?? "";
    } catch {
      console.warn(
        `[sanitizeAnnotation] Malformed JSON in legacy suggestion ${ann.id}, treating as plain comment`,
      );
      content = ann.content;
    }
    return { ...base, type: "comment", content, suggestedText } as Annotation;
  }

  if (ann.type === "question") {
    return { ...base, type: "comment", directedAt: "claude" as const } as Annotation;
  }

  if (ann.type === "highlight") {
    return {
      ...base,
      type: "highlight",
      color: (ann as Annotation & { color?: string }).color,
    } as Annotation;
  }

  if (ann.type === "flag") {
    return { ...base, type: "flag" } as Annotation;
  }

  if (ann.type === "comment") {
    return {
      ...base,
      type: "comment",
      ...(ann.suggestedText !== undefined ? { suggestedText: ann.suggestedText } : {}),
      ...(ann.directedAt !== undefined ? { directedAt: ann.directedAt } : {}),
    } as Annotation;
  }

  // Truly unknown type — coerce to comment with warning
  console.warn(
    `[sanitizeAnnotation] Unknown type "${ann.type}" for ${ann.id}, coercing to "comment"`,
  );
  return { ...base, type: "comment" } as Annotation;
}
