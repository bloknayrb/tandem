/**
 * On-disk schema for Tandem's durable annotation envelope.
 *
 * The envelope is written to app-data JSON (per Phase 1 of the durable-annotations
 * plan). It wraps the existing in-memory annotation / reply shapes with:
 *   - `schemaVersion` for forward-compat migrations
 *   - `docHash` so a stale file can be detected when the underlying document has
 *     changed on disk
 *   - `meta` for bookkeeping (filePath, lastUpdated)
 *   - `tombstones` so deleted annotations don't resurrect on merge
 *   - `rev: number` on each annotation/reply for last-writer-wins semantics
 *
 * ## Unknown-field policy
 *
 * All object schemas in this module use `.passthrough()` (Zod default is to strip
 * unknowns; we intentionally override that). Forward-compatibility is the goal:
 * a future version might add fields (e.g. `pinnedBy`, `severity`) that a pre-
 * upgrade Tandem install should *preserve* when rewriting the file, not silently
 * drop. Strict rejection would turn a harmless additive change into a "corrupt"
 * error and trip the `.json.future` fallback path unnecessarily.
 *
 * Forward version jumps (`schemaVersion > 1`) are still handled explicitly via
 * `parseAnnotationDoc` returning `{ ok: false, error: "future" }` — passthrough
 * only covers *additive* changes inside the v1 shape.
 *
 * ## Why this schema doesn't fully mirror the Annotation TS discriminated union
 *
 * `src/shared/types.ts` defines `Annotation` as a three-variant discriminated
 * union (`highlight` / `comment` / `flag`) with mutually-exclusive `undefined`
 * markers on the non-applicable variant fields. Mirroring that shape in Zod
 * via `z.discriminatedUnion` would duplicate a lot of field surface area and
 * drift from the TS type as it evolves. Instead, we validate the *shared*
 * structural shape (AnnotationBase + optional `type`-tagged fields) and let
 * consumers cast to `Annotation` downstream. The Zod schema is a gatekeeper
 * against malformed files on disk, not the source of truth for the app's
 * annotation type system.
 *
 * Full migration framework for v1 → v2+ is deferred to issue #320. This module
 * ships only `migrateToV1` (legacy session-blob → v1).
 */

import { z } from "zod";
import {
  AnnotationStatusSchema,
  AnnotationTypeSchema,
  AuthorSchema,
  HighlightColorSchema,
} from "../../shared/types.js";

/** On-disk envelope version. Bump when making breaking changes to the file shape. */
export const SCHEMA_VERSION = 1 as const;

// ---------------------------------------------------------------------------
// Primitive sub-schemas
// ---------------------------------------------------------------------------

/**
 * JSON form of a Yjs RelativePosition (output of `Y.relativePositionToJSON`).
 * All four fields are optional — Yjs omits nulls on serialization. Passthrough
 * because the Yjs internals are opaque and we shouldn't break on schema drift
 * in the upstream library.
 */
const SerializedRelPosSchema = z
  .object({
    type: z.unknown().optional(),
    tname: z.string().optional(),
    item: z.unknown().optional(),
    assoc: z.number().optional(),
  })
  .passthrough();

const DocumentRangeSchema = z
  .object({
    from: z.number().int().nonnegative(),
    to: z.number().int().nonnegative(),
  })
  .passthrough();

const RelativeRangeSchema = z
  .object({
    fromRel: SerializedRelPosSchema,
    toRel: SerializedRelPosSchema,
  })
  .passthrough();

// ---------------------------------------------------------------------------
// Annotation + reply per-record schemas
// ---------------------------------------------------------------------------

/**
 * Per-annotation envelope record. Structurally matches `AnnotationBase` from
 * `src/shared/types.ts`, plus the optional type-discriminator fields
 * (`color` / `suggestedText` / `directedAt`), plus the new required `rev`.
 */
export const AnnotationRecordSchemaV1 = z
  .object({
    id: z.string().min(1),
    author: AuthorSchema,
    type: AnnotationTypeSchema,
    range: DocumentRangeSchema,
    relRange: RelativeRangeSchema.optional(),
    content: z.string(),
    status: AnnotationStatusSchema,
    timestamp: z.number(),
    textSnapshot: z.string().optional(),
    editedAt: z.number().optional(),
    // Type-specific optional fields. Not cross-validated against `type` — the
    // TS discriminated union enforces that invariant at construction time
    // (see `src/shared/types.ts`). Here we only gate shape.
    color: HighlightColorSchema.optional(),
    suggestedText: z.string().optional(),
    directedAt: z.literal("claude").optional(),
    // New for v1 envelope: monotonically-increasing revision counter used for
    // last-writer-wins merge between in-memory Y.Map state and on-disk state.
    rev: z.number().int().nonnegative(),
  })
  .passthrough();

/**
 * Reply record (existing `AnnotationReply` shape + `rev`).
 */
export const AnnotationReplyRecordSchemaV1 = z
  .object({
    id: z.string().min(1),
    annotationId: z.string().min(1),
    author: z.enum(["user", "claude"]),
    text: z.string(),
    timestamp: z.number(),
    editedAt: z.number().optional(),
    rev: z.number().int().nonnegative(),
  })
  .passthrough();

/**
 * Tombstone for a deleted annotation. `rev` is the rev the annotation carried
 * when it was deleted, so merge logic can decide whether an incoming add from
 * a stale peer is older (drop it) or newer (resurrect).
 */
export const TombstoneRecordSchemaV1 = z
  .object({
    id: z.string().min(1),
    rev: z.number().int().nonnegative(),
    deletedAt: z.number(),
  })
  .passthrough();

// ---------------------------------------------------------------------------
// Top-level envelope
// ---------------------------------------------------------------------------

const MetaSchema = z
  .object({
    filePath: z.string(),
    lastUpdated: z.number(),
  })
  .passthrough();

/**
 * The full on-disk JSON envelope.
 * Passthrough at every layer — see module header for the rationale.
 */
export const AnnotationDocSchemaV1 = z
  .object({
    schemaVersion: z.literal(SCHEMA_VERSION),
    docHash: z.string(),
    meta: MetaSchema,
    annotations: z.array(AnnotationRecordSchemaV1),
    tombstones: z.array(TombstoneRecordSchemaV1),
    replies: z.array(AnnotationReplyRecordSchemaV1),
  })
  .passthrough();

export type AnnotationDocV1 = z.infer<typeof AnnotationDocSchemaV1>;
export type AnnotationRecordV1 = z.infer<typeof AnnotationRecordSchemaV1>;
export type AnnotationReplyRecordV1 = z.infer<typeof AnnotationReplyRecordSchemaV1>;
export type TombstoneRecordV1 = z.infer<typeof TombstoneRecordSchemaV1>;

// ---------------------------------------------------------------------------
// Parse + migrate
// ---------------------------------------------------------------------------

/**
 * Discriminated result of `parseAnnotationDoc`. The `ok` flag is the
 * discriminant; we intentionally avoid keying on `error` because the v1 schema
 * uses `.passthrough()` (see module header) and any alive doc could, in
 * principle, carry a passthrough field named `error`. `ok` is our own
 * invariant, outside the schema's namespace, so narrowing is unambiguous.
 */
export type ParseAnnotationDocResult =
  | { ok: true; doc: AnnotationDocV1 }
  | { ok: false; error: "corrupt" }
  | { ok: false; error: "future"; schemaVersion: number };

/**
 * Validate an on-disk annotation doc.
 *
 * Accepts either a parsed object *or* a raw JSON string (for readability at
 * call sites). On any parse/validation failure returns
 * `{ ok: false, error: "corrupt" }`. If the payload looks well-formed but
 * carries `schemaVersion > 1`, returns
 * `{ ok: false, error: "future", schemaVersion }` so the caller can rename the
 * file to `<hash>.json.future` and fall back to in-memory state.
 */
export function parseAnnotationDoc(raw: unknown): ParseAnnotationDocResult {
  // Optional JSON-string convenience: callers that read the file as text can
  // pass the string straight through.
  let candidate: unknown = raw;
  if (typeof candidate === "string") {
    try {
      candidate = JSON.parse(candidate);
    } catch {
      return { ok: false, error: "corrupt" };
    }
  }

  if (candidate === null || typeof candidate !== "object") {
    return { ok: false, error: "corrupt" };
  }

  // Check schemaVersion *before* full validation so we can return `future`
  // without treating a newer-but-otherwise-valid file as corrupt.
  const schemaVersion = (candidate as { schemaVersion?: unknown }).schemaVersion;
  if (
    typeof schemaVersion === "number" &&
    Number.isInteger(schemaVersion) &&
    schemaVersion > SCHEMA_VERSION
  ) {
    return { ok: false, error: "future", schemaVersion };
  }

  const result = AnnotationDocSchemaV1.safeParse(candidate);
  if (!result.success) {
    return { ok: false, error: "corrupt" };
  }
  return { ok: true, doc: result.data };
}

/**
 * Best-effort migration from a legacy session-blob–shaped object (no `rev`,
 * no `tombstones`, no `docHash`, no `meta`) into the v1 envelope shape.
 *
 * Populates sensible defaults:
 *   - `rev: 0` on every annotation and reply
 *   - `tombstones: []`
 *   - `docHash: ""` (caller fills in with the real hash of the current document)
 *   - `meta: { filePath: "", lastUpdated: 0 }` (caller overrides)
 *
 * Expects `raw` to be roughly `{ annotations?: unknown[]; replies?: unknown[] }`.
 * Anything unrecognized is coerced; invalid records are skipped silently —
 * this is a lossy upgrade path, not a strict validator.
 *
 * NOTE: Phase 1 ships only this single migration function. The general
 * v1 → vN migration framework is deferred to issue #320.
 */
export function migrateToV1(raw: unknown): AnnotationDocV1 {
  const src = (raw && typeof raw === "object" ? raw : {}) as Record<string, unknown>;

  const annotationsIn = Array.isArray(src.annotations) ? src.annotations : [];
  const repliesIn = Array.isArray(src.replies) ? src.replies : [];

  const annotations = annotationsIn.flatMap((ann): AnnotationRecordV1[] => {
    if (!ann || typeof ann !== "object") return [];
    const withRev = { rev: 0, ...(ann as object) };
    const parsed = AnnotationRecordSchemaV1.safeParse(withRev);
    return parsed.success ? [parsed.data] : [];
  });

  const replies = repliesIn.flatMap((r): AnnotationReplyRecordV1[] => {
    if (!r || typeof r !== "object") return [];
    const withRev = { rev: 0, ...(r as object) };
    const parsed = AnnotationReplyRecordSchemaV1.safeParse(withRev);
    return parsed.success ? [parsed.data] : [];
  });

  return {
    schemaVersion: SCHEMA_VERSION,
    docHash: "",
    meta: { filePath: "", lastUpdated: 0 },
    annotations,
    tombstones: [],
    replies,
  };
}
