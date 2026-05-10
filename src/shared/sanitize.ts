import type { Annotation } from "./types.js";

/** Raw annotation from Y.Map — may contain legacy `suggestion`/`question` types. */
export type RawAnnotation = Omit<Annotation, "type"> & { type: string };

/**
 * Discriminated union describing a lossy rewrite performed by
 * `sanitizeAnnotation`. Reported via the required `onLossy` callback so
 * callers can route the event to their own observability sink (server:
 * migration-log; client: dev console).
 *
 * NEW kinds added here MUST be handled in `relaySanitizationEvent`
 * (`src/server/annotations/migration-log.ts`) — extend
 * `LegacyMigrationKind` in lockstep.
 */
export type SanitizationEvent =
  | { kind: "flag-to-note"; id: string }
  | { kind: "question-to-comment"; id: string }
  | { kind: "malformed-suggestion-json"; id: string }
  | { kind: "unknown-type"; id: string; rawType: string }
  | { kind: "import-note-to-comment"; id: string };

/**
 * Required callback invoked once per lossy rewrite. Sync only — Promise
 * returns are forbidden at the type level. Errors thrown from the callback
 * are caught inside `sanitizeAnnotation` and logged to stderr; sanitize
 * never aborts mid-`.map()` because of a faulty relay.
 */
export type OnLossy = (event: SanitizationEvent) => void;

/**
 * Normalize a legacy annotation into the unified shape.
 * - `suggestion` → `comment` with `suggestedText` + `content` (parsed from JSON)
 * - `question` → `comment` (directedAt removed per ADR-027)
 * - `flag` → `note` (ADR-027: audience-based model)
 * - Strips stray `color` from non-highlight entries (#245)
 * - Strips `directedAt` from comments (ADR-027)
 * - Preserves `rev` (the durable-annotation last-writer-wins counter — added
 *   by the on-disk schema, see `src/server/annotations/schema.ts`). `rev` is
 *   a server-internal durability concept, not a client-facing annotation
 *   field, so it doesn't appear on the `Annotation` union type. Passthrough
 *   here is load-bearing: without it every sanitize-then-write cycle in the
 *   MCP tools would reset `rev` to undefined and the sync observer would
 *   serialize `rev: 0` forever.
 *
 * `onLossy` is REQUIRED. Lossy rewrites — `flag→note`, `question→comment`,
 * malformed-suggestion-JSON, unknown-type → comment — fire one event each.
 * Making the callback required is the TS-level enforcement that prevents a
 * forgotten callsite from silently regressing observability.
 */
export function sanitizeAnnotation(
  input: Annotation | RawAnnotation,
  onLossy: OnLossy,
): Annotation {
  const ann = input as RawAnnotation;

  const emit = (event: SanitizationEvent): void => {
    try {
      onLossy(event);
    } catch (err) {
      // Never abort sanitize because of a faulty relay. The whole point of
      // the callback is observability — if it throws, log to stderr (which
      // the server redirects from console.warn) and move on.
      console.warn(`[sanitizeAnnotation] onLossy threw for ${event.kind}:`, err);
    }
  };

  // AR1: derive audience before `base` is built so it flows through all early-return paths.
  // "flag" is explicit — it hasn't been mutated to "note" at this point.
  // Import annotations are always private initially; users triage Word comments before Claude sees them.
  // Computing a default is normative behavior, not a lossy migration — no event emitted.
  const derivedAudience: "private" | "outbound" =
    ann.audience === "private" || ann.audience === "outbound"
      ? ann.audience
      : ann.author === "import" ||
          ann.type === "highlight" ||
          ann.type === "note" ||
          ann.type === "flag"
        ? "private"
        : "outbound";

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
    audience: derivedAudience,
    ...(ann.promotedFrom !== undefined ? { promotedFrom: ann.promotedFrom } : {}),
    ...(ann.importSource !== undefined ? { importSource: ann.importSource } : {}),
  };

  if (ann.type === "suggestion") {
    let suggestedText: string | undefined;
    let content: string;
    try {
      const parsed = JSON.parse(ann.content) as { newText?: string; reason?: string };
      suggestedText = parsed.newText;
      content = parsed.reason ?? "";
    } catch {
      emit({ kind: "malformed-suggestion-json", id: ann.id });
      content = ann.content;
    }
    return { ...base, type: "comment", content, suggestedText } as Annotation;
  }

  if (ann.type === "question") {
    emit({ kind: "question-to-comment", id: ann.id });
    return { ...base, type: "comment" } as Annotation;
  }

  if (ann.type === "highlight") {
    return {
      ...base,
      type: "highlight",
      color: (ann as Annotation & { color?: string }).color,
    } as Annotation;
  }

  // Imported Word reviewer comments stored under the unreleased PR #474
  // model as `type: "note"` need to surface to Claude as comments per
  // ADR-027 (#482). MUST run before the flag/note clause below — otherwise
  // the `type === "note"` branch shadows this rewrite into a no-op.
  if (ann.author === "import" && ann.type === "note") {
    emit({ kind: "import-note-to-comment", id: ann.id });
    return { ...base, type: "comment" } as Annotation;
  }

  if (ann.type === "flag" || ann.type === "note") {
    if (ann.type === "flag") {
      emit({ kind: "flag-to-note", id: ann.id });
    }
    return { ...base, type: "note" } as Annotation;
  }

  if (ann.type === "comment") {
    return {
      ...base,
      type: "comment",
      ...(ann.suggestedText !== undefined ? { suggestedText: ann.suggestedText } : {}),
    } as Annotation;
  }

  // Truly unknown type — coerce to comment
  emit({ kind: "unknown-type", id: ann.id, rawType: ann.type });
  return { ...base, type: "comment" } as Annotation;
}
