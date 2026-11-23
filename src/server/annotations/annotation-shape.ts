// No imports: shared by the read path (`mcp/annotations.ts`) and the
// key-identity reconciler (`key-identity.ts`) without an import cycle.

/**
 * The structural pre-check a raw `Y_MAP_ANNOTATIONS` value must pass before it
 * is handed to `sanitizeAnnotation`: an object with string `id`/`type`/`status`
 * and a `range` carrying numeric `from`/`to`.
 *
 * Lifted out of {@link collectAnnotations} so the id-keyed tools' document
 * resolver (`resolveAnnotationStore`, PR #2225 review) admits exactly the
 * records the READ path admits — a record `tandem_getAnnotations` would skip as
 * malformed must not make a document a candidate for a write either.
 */
export function hasAnnotationShape(value: unknown): value is Record<string, unknown> {
  const ann = value as Record<string, unknown>;
  return Boolean(
    ann &&
      typeof ann === "object" &&
      typeof ann.id === "string" &&
      typeof ann.type === "string" &&
      typeof ann.status === "string" &&
      ann.range &&
      typeof (ann.range as Record<string, unknown>).from === "number" &&
      typeof (ann.range as Record<string, unknown>).to === "number",
  );
}
