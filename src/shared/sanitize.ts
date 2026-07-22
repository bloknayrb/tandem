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
  /**
   * @deprecated Never emitted by `sanitizeAnnotation` since Wave 8 (PR #756)
   * reversed the import-note→comment rewrite. Retained in the union so that
   * log-parsing tools and `relaySanitizationEvent` don't break on event streams
   * that pre-date W8. Do not add new call sites.
   */
  | { kind: "import-note-to-comment"; id: string }
  | { kind: "audience-conflict-resolved"; id: string };

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
    // WS-A2: preserve the Solo-hold marker through sanitize. Like `rev`, this
    // is stripped by the allowlist unless listed here — and every Claude-facing
    // read routes through sanitize, so without this the client badge and the
    // fail-closed-restart tiebreaker (which read `heldInSolo` on the sanitized
    // record) would see it as always-undefined. The marker gates the badge +
    // restart hold, NOT live hiding (that is server-authoritative mode-based).
    ...(typeof ann.heldInSolo === "boolean" ? { heldInSolo: ann.heldInSolo } : {}),
    // #1123 M3: the authoring agent's identity (local-model collaborator only).
    // sanitize is a strict allowlist, so without this line agentIdentity is
    // stripped on EVERY Claude-facing read and the provider byline silently
    // no-ops on the client. Dark-safe: absent ⇒ nothing added.
    ...(ann.agentIdentity !== undefined ? { agentIdentity: ann.agentIdentity } : {}),
    audience: derivedAudience,
    ...(ann.promotedFrom !== undefined ? { promotedFrom: ann.promotedFrom } : {}),
    ...(ann.importSource !== undefined ? { importSource: ann.importSource } : {}),
  };

  // Guard: user-authored notes, highlights, and flags must never be outbound.
  // Flags are included because the flag-to-note migration below preserves audience;
  // without this guard a flag with explicit audience:"outbound" would become a
  // note with audience:"outbound", violating ADR-027.
  // Only author:"user" is guarded; import-promoted comments (author:"import") remain
  // outbound-eligible after their own type rewrite below.
  if (
    base.audience === "outbound" &&
    ann.author === "user" &&
    (ann.type === "note" || ann.type === "highlight" || ann.type === "flag")
  ) {
    base.audience = "private";
    emit({ kind: "audience-conflict-resolved", id: ann.id });
  }

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

  // W8 (PR #756) reverses the #482 policy: imported Word reviewer comments
  // are now first-class private notes (`author: "import", type: "note",
  // audience: "private"`) until the user batch-promotes them via the
  // BatchPromoteBar. The previous import-note→comment rewrite leaked
  // un-promoted imports to Claude on every MCP read; falling through to
  // the note branch below keeps them in the private bucket.

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
