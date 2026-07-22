/**
 * On-disk schema for Tandem's durable annotation envelope.
 *
 * ## Unknown-field policy
 *
 * All object schemas use `.passthrough()` (overriding Zod's default strip).
 * Forward-compatibility is the goal: a future version might add fields
 * (e.g. `pinnedBy`, `severity`) that a pre-upgrade Tandem install should
 * *preserve* when rewriting the file, not silently drop. Strict rejection
 * would turn a harmless additive change into a "corrupt" error and trip the
 * `.json.future` fallback path unnecessarily. Breaking version jumps
 * (`schemaVersion > 1`) are still handled explicitly via
 * `parseAnnotationDoc` returning `{ ok: false, error: "future" }`.
 */

import { z } from "zod";
import {
  AgentIdentitySchema,
  AnnotationStatusSchema,
  AnnotationTypeSchema,
  AuthorSchema,
  type HighlightColor,
  HighlightColorSchema,
  ReplyAuthorSchema,
} from "../../shared/types.js";
import { logLegacyMigration, MIGRATE_TO_V1_DOC_HASH } from "./migration-log.js";
import { migrateUp } from "./migrations/index.js";

/** On-disk envelope version. Bump when making breaking changes to the file shape. */
export const SCHEMA_VERSION = 1 as const;

/**
 * Reply size bounds (#1000 security review R2). `REPLY_TEXT_MAX` is a generous
 * durable-schema sanity ceiling — deliberately large so it can NEVER drop a
 * legitimate existing user/claude reply on load (`normalizeReply` discards rows
 * that fail `safeParse`). The tight, product-sensible truncation of untrusted
 * imported Word reply bodies happens at the injection door
 * (`IMPORT_REPLY_BODY_CAP`), well under this ceiling. `IMPORT_AUTHOR_MAX` only
 * ever bounds our own injection-written field, so it is safe to validate tightly.
 */
export const REPLY_TEXT_MAX = 100_000;
export const IMPORT_REPLY_BODY_CAP = 4_000;
export const IMPORT_AUTHOR_MAX = 128;

/**
 * Compute the next revision for a user-intent write. Returns `1` for a brand
 * new record (no `prev`), otherwise `prev.rev + 1`. Pre-T6 records that lack
 * `rev` are treated as `rev: 0` so the first write after migration lands at
 * `rev: 1`.
 *
 * Used at every server-side creation and mutation site so the `?? 0` fallback
 * and increment live in exactly one place — the invariant is part of the
 * schema module's domain, not the call sites'.
 */
export function nextRev(prev?: { rev?: number }): number {
  return (prev?.rev ?? 0) + 1;
}

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
 * Per-annotation envelope record. Largely mirrors `AnnotationBase` from
 * `src/shared/types.ts`, plus the optional type-discriminator fields
 * (`color` / `suggestedText`), plus the required `rev`. ADR-027 removed
 * `directedAt` from the model; the schema enforces its absence via a
 * `.refine()` so any caller that skips migration is caught at validation time.
 * Fields not listed here (e.g. `heldInSolo`) are preserved via `.passthrough()`.
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
    // New for v1 envelope: monotonically-increasing revision counter used for
    // last-writer-wins merge between in-memory Y.Map state and on-disk state.
    rev: z.number().int().nonnegative(),
    // #1123 M3: authoring agent identity (local-model collaborator only).
    // Preserved by `.passthrough()`; listed for parity + type-safety at the
    // write site, mirroring the `heldInSolo` precedent on the reply record.
    agentIdentity: AgentIdentitySchema.optional(),
  })
  .passthrough()
  // ADR-027: directedAt is removed from the model. All production read paths
  // (parseAnnotationDoc, migrateToV1) run migrateFlagAndDirectedAt() before
  // reaching this schema, so the field is already gone. This refine catches
  // any caller that bypasses migration and passes a stale record directly.
  .refine((rec) => !("directedAt" in rec), {
    message: "directedAt is removed in ADR-027; run migrateFlagAndDirectedAt before validation",
    path: ["directedAt"],
  });

/**
 * Reply record (existing `AnnotationReply` shape + `rev`).
 */
export const AnnotationReplyRecordSchemaV1 = z
  .object({
    id: z.string().min(1),
    annotationId: z.string().min(1),
    author: ReplyAuthorSchema,
    // Bounded to defend against pathological/oversized .docx reply bodies that
    // bypass the SNAPSHOT_CAP path (#1000 security review R2).
    text: z.string().max(REPLY_TEXT_MAX),
    timestamp: z.number(),
    editedAt: z.number().optional(),
    rev: z.number().int().nonnegative(),
    // #1000: user-private (note-authored or imported Word) reply — never sent
    // to Claude. Optional; absent ⇒ surfaces normally on comment parents.
    private: z.boolean().optional(),
    // #1000: original Word reviewer name for `author: "import"` replies.
    importAuthor: z.string().max(IMPORT_AUTHOR_MAX).optional(),
    // WS-A2: Solo-hold marker (badge + fail-closed-restart tiebreaker). Already
    // preserved by `.passthrough()`; listed explicitly for parity with the
    // annotation record and type-safety at the write site.
    heldInSolo: z.boolean().optional(),
    // #1123 M3: authoring agent identity (local-model collaborator replies only).
    agentIdentity: AgentIdentitySchema.optional(),
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
    // Additive (no schema-version bump — MetaSchema is .passthrough()).
    // SHA-256 of `extractText(doc)` recomputed on EVERY durable write, used by
    // the rename-recovery path (#313) to re-associate an orphaned envelope with
    // a renamed-but-byte-identical document. Optional so pre-#313 envelopes
    // (which lack it) still parse; recovery simply skips them.
    contentHash: z.string().optional(),
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
// Color migration helpers
// ---------------------------------------------------------------------------

// Align legacy color remap with the v7 design handoff palette
// (docs/designs/handoff/tandem/project/calm-v7.css):
// - red → pink (warm-family remap; the prior red→yellow remap predated the
//   v7 palette decision and silently collapsed two visually distinct
//   highlights into one)
// - purple → blue (cool-family remap; unchanged)
const LEGACY_COLOR_MAP: Record<"red" | "purple", HighlightColor> = {
  red: "pink",
  purple: "blue",
};

function migrateHighlightColor(ann: Record<string, unknown>): void {
  const color = ann.color;
  if (typeof color === "string" && color in LEGACY_COLOR_MAP) {
    ann.color = LEGACY_COLOR_MAP[color as keyof typeof LEGACY_COLOR_MAP];
  }
}

// ADR-027: flag→note migration + directedAt removal
// ---------------------------------------------------------------------------

function migrateFlagAndDirectedAt(ann: Record<string, unknown>, docHash?: string): void {
  if (ann.type === "flag") {
    ann.type = "note";
    logLegacyMigration(docHash, "flag");
  }
  if ("directedAt" in ann) {
    delete ann.directedAt;
    logLegacyMigration(docHash, "directedAt");
  }
}

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
    } catch (err) {
      console.error("[parseAnnotationDoc] JSON.parse failed:", err);
      return { ok: false, error: "corrupt" };
    }
  }

  if (candidate === null || typeof candidate !== "object") {
    console.error(
      `[parseAnnotationDoc] expected object, got ${candidate === null ? "null" : typeof candidate}`,
    );
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

  // Migrate legacy highlight colors before validation. Clone each annotation
  // so the caller's input objects are not mutated as a side effect of parsing.
  const cand = candidate as { annotations?: unknown[]; docHash?: unknown };
  const candDocHash = typeof cand.docHash === "string" ? cand.docHash : undefined;
  if (Array.isArray(cand.annotations)) {
    for (let i = 0; i < cand.annotations.length; i++) {
      const ann = cand.annotations[i];
      if (ann && typeof ann === "object") {
        const cloned = { ...(ann as Record<string, unknown>) };
        migrateHighlightColor(cloned);
        migrateFlagAndDirectedAt(cloned, candDocHash);
        cand.annotations[i] = cloned;
      }
    }
  }

  // Run the versioned migration framework forward to the current schema
  // version. Today `SCHEMA_VERSION` is 1, so any well-formed file is already
  // at-or-below current and `migrateUp` returns the input unchanged — the
  // wiring is dormant but live. When `SCHEMA_VERSION` is bumped to 2, the
  // registered v1 → v2 migration begins running here with no further changes.
  // A migration that throws (e.g. a record that fails the v_n input contract)
  // is treated as corruption rather than crashing the load path.
  const fromVersion =
    typeof schemaVersion === "number" && Number.isInteger(schemaVersion) ? schemaVersion : 1;
  let migrated: unknown;
  try {
    migrated = migrateUp(candidate, fromVersion, SCHEMA_VERSION);
  } catch (err) {
    console.error("[parseAnnotationDoc] migration failed:", err);
    return { ok: false, error: "corrupt" };
  }

  const result = AnnotationDocSchemaV1.safeParse(migrated);
  if (!result.success) {
    console.error("[parseAnnotationDoc] schema validation failed:", result.error.issues);
    return { ok: false, error: "corrupt" };
  }
  return { ok: true, doc: result.data };
}

/** Result of `migrateToV1`. Drop counts let callers surface lossy upgrades. */
export interface MigrationResult {
  doc: AnnotationDocV1;
  /** Count of annotation records skipped during migration (non-object input or schema rejection). */
  droppedAnnotations: number;
  /** Count of reply records skipped during migration (same criteria). */
  droppedReplies: number;
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
 * Anything unrecognized is coerced; invalid records are skipped and tallied
 * in `droppedAnnotations` / `droppedReplies` so callers can surface data loss
 * rather than silently discarding records. As a second line of defense, a
 * single `console.error` fires when any records are dropped — without it a
 * caller that forgets to destructure the counts would lose the data-loss
 * signal entirely. The full v1 → vN migration framework is deferred.
 */
export function migrateToV1(raw: unknown): MigrationResult {
  const src = (raw && typeof raw === "object" ? raw : {}) as Record<string, unknown>;

  const annotationsIn = Array.isArray(src.annotations) ? src.annotations : [];
  const repliesIn = Array.isArray(src.replies) ? src.replies : [];

  let droppedAnnotations = 0;
  let droppedReplies = 0;

  const annotations: AnnotationRecordV1[] = [];
  for (const ann of annotationsIn) {
    if (!ann || typeof ann !== "object") {
      droppedAnnotations++;
      continue;
    }
    const withRev = { rev: 0, ...(ann as object) };
    migrateHighlightColor(withRev as Record<string, unknown>);
    migrateFlagAndDirectedAt(withRev as Record<string, unknown>, MIGRATE_TO_V1_DOC_HASH);
    const parsed = AnnotationRecordSchemaV1.safeParse(withRev);
    if (parsed.success) {
      annotations.push(parsed.data);
    } else {
      droppedAnnotations++;
      const annId = (withRev as { id?: unknown }).id ?? "<missing>";
      console.error(
        `[ANNOTATION-STORE] migrateToV1: dropping annotation id=${String(annId)}:`,
        parsed.error.issues,
      );
    }
  }

  const replies: AnnotationReplyRecordV1[] = [];
  for (const r of repliesIn) {
    if (!r || typeof r !== "object") {
      droppedReplies++;
      continue;
    }
    const withRev = { rev: 0, ...(r as object) };
    const parsed = AnnotationReplyRecordSchemaV1.safeParse(withRev);
    if (parsed.success) {
      replies.push(parsed.data);
    } else {
      droppedReplies++;
      const replyId = (withRev as { id?: unknown }).id ?? "<missing>";
      console.error(
        `[ANNOTATION-STORE] migrateToV1: dropping reply id=${String(replyId)}:`,
        parsed.error.issues,
      );
    }
  }

  if (droppedAnnotations > 0 || droppedReplies > 0) {
    console.error(
      `[ANNOTATION-STORE] migrateToV1 dropped ${droppedAnnotations} annotation(s) and ${droppedReplies} reply/replies as malformed`,
    );
  }

  return {
    doc: {
      schemaVersion: SCHEMA_VERSION,
      docHash: "",
      meta: { filePath: "", lastUpdated: 0 },
      annotations,
      tombstones: [],
      replies,
    },
    droppedAnnotations,
    droppedReplies,
  };
}
