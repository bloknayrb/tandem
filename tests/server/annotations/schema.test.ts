import { afterEach, describe, expect, it, vi } from "vitest";
import { resetMigrationLog } from "../../../src/server/annotations/migration-log.js";
import {
  AnnotationDocSchemaV1,
  type AnnotationDocV1,
  AnnotationRecordSchemaV1,
  type AnnotationRecordV1,
  migrateToV1,
  parseAnnotationDoc,
  SCHEMA_VERSION,
  TombstoneRecordSchemaV1,
} from "../../../src/server/annotations/schema.js";

const baseAnnotation: AnnotationRecordV1 = {
  id: "ann_1_abc",
  author: "claude",
  type: "comment",
  range: { from: 0, to: 10 },
  content: "hello",
  status: "pending",
  timestamp: 1_700_000_000_000,
  rev: 2,
};

const validDoc: AnnotationDocV1 = {
  schemaVersion: 1,
  docHash: "sha256:deadbeef",
  meta: { filePath: "/path/to/doc.md", lastUpdated: 1_744_819_200_000 },
  annotations: [baseAnnotation],
  tombstones: [{ id: "ann_gone", rev: 4, deletedAt: 1_744_819_200_789 }],
  replies: [
    {
      id: "rep_1",
      annotationId: "ann_1_abc",
      author: "user",
      text: "agreed",
      timestamp: 1_700_000_000_100,
      rev: 0,
    },
  ],
};

describe("parseAnnotationDoc — happy path", () => {
  it("accepts a well-formed v1 doc and returns the parsed shape", () => {
    const result = parseAnnotationDoc(validDoc);
    if (!result.ok) throw new Error("expected success");
    expect(result.doc.schemaVersion).toBe(1);
    expect(result.doc.annotations).toHaveLength(1);
    expect(result.doc.annotations[0]?.id).toBe("ann_1_abc");
    expect(result.doc.tombstones[0]?.id).toBe("ann_gone");
    expect(result.doc.replies[0]?.author).toBe("user");
  });

  it("round-trips through JSON", () => {
    const serialized = JSON.stringify(validDoc);
    const parsed = parseAnnotationDoc(serialized);
    if (!parsed.ok) throw new Error("expected success");
    // Structural equality — passthrough should preserve every field.
    expect(parsed.doc).toEqual(validDoc);
  });

  it("preserves unknown additive fields (passthrough policy)", () => {
    const withExtras = {
      ...validDoc,
      annotations: [{ ...baseAnnotation, futureField: "hello" }],
      newTopLevel: 42,
    };
    const parsed = parseAnnotationDoc(withExtras);
    if (!parsed.ok) throw new Error("expected success");
    // Passthrough preserves unknown fields — this is the documented policy.
    expect((parsed.doc as Record<string, unknown>).newTopLevel).toBe(42);
    expect((parsed.doc.annotations[0] as Record<string, unknown>).futureField).toBe("hello");
  });

  it("does not collide with a passthrough field literally named 'error'", () => {
    // Tagged-union rationale check: the discriminant is `ok`, not `error`, so
    // a passthrough field called `error` on an alive v1 doc must NOT be
    // classified as an error result.
    const withBogusField = { ...validDoc, error: "this is just data" };
    const parsed = parseAnnotationDoc(withBogusField);
    if (!parsed.ok) throw new Error("expected success despite 'error' passthrough field");
    expect((parsed.doc as Record<string, unknown>).error).toBe("this is just data");
  });
});

describe("parseAnnotationDoc — error paths", () => {
  it("returns { ok: false, error: 'corrupt' } when schemaVersion is missing", () => {
    const { schemaVersion: _omit, ...noVersion } = validDoc;
    const result = parseAnnotationDoc(noVersion);
    expect(result).toEqual({ ok: false, error: "corrupt" });
  });

  it("returns { ok: false, error: 'future', schemaVersion: 2 } for a newer schema", () => {
    const future = { ...validDoc, schemaVersion: 2 };
    const result = parseAnnotationDoc(future);
    expect(result).toEqual({ ok: false, error: "future", schemaVersion: 2 });
  });

  it("returns { ok: false, error: 'future' } even when higher-version shape is otherwise unparseable", () => {
    // A v2 file may have fields that fail v1 validation — we must not
    // report that as 'corrupt'. The version gate runs first.
    const result = parseAnnotationDoc({ schemaVersion: 99, somethingNew: true });
    expect(result).toEqual({ ok: false, error: "future", schemaVersion: 99 });
  });

  it("returns { ok: false, error: 'corrupt' } for malformed JSON string", () => {
    const result = parseAnnotationDoc("{ not valid json");
    expect(result).toEqual({ ok: false, error: "corrupt" });
  });

  it("returns { ok: false, error: 'corrupt' } for a non-object primitive", () => {
    expect(parseAnnotationDoc(42)).toEqual({ ok: false, error: "corrupt" });
    expect(parseAnnotationDoc(null)).toEqual({ ok: false, error: "corrupt" });
    expect(parseAnnotationDoc(undefined)).toEqual({ ok: false, error: "corrupt" });
  });

  it("returns { ok: false, error: 'corrupt' } when a required field is the wrong type", () => {
    const bad = { ...validDoc, annotations: "not an array" };
    const result = parseAnnotationDoc(bad);
    expect(result).toEqual({ ok: false, error: "corrupt" });
  });

  it("returns { ok: false, error: 'corrupt' } when an annotation is missing rev", () => {
    const noRev = { ...baseAnnotation } as Record<string, unknown>;
    delete noRev.rev;
    const bad = { ...validDoc, annotations: [noRev] };
    const result = parseAnnotationDoc(bad);
    expect(result).toEqual({ ok: false, error: "corrupt" });
  });
});

describe("TombstoneRecordSchemaV1", () => {
  it("validates a well-formed tombstone", () => {
    const result = TombstoneRecordSchemaV1.safeParse({
      id: "ann_gone",
      rev: 7,
      deletedAt: 1_744_819_200_789,
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.id).toBe("ann_gone");
      expect(result.data.rev).toBe(7);
    }
  });

  it("rejects a tombstone with a negative rev", () => {
    const result = TombstoneRecordSchemaV1.safeParse({
      id: "ann_gone",
      rev: -1,
      deletedAt: 1,
    });
    expect(result.success).toBe(false);
  });

  it("rejects a tombstone missing deletedAt", () => {
    const result = TombstoneRecordSchemaV1.safeParse({ id: "ann_gone", rev: 0 });
    expect(result.success).toBe(false);
  });
});

describe("migrateToV1", () => {
  it("fills rev=0 on every annotation and reply, empty tombstones, empty meta", () => {
    // Session-blob shape: annotations without rev/tombstones/docHash/meta.
    const legacy = {
      annotations: [
        {
          id: "ann_legacy_1",
          author: "user",
          type: "highlight",
          range: { from: 0, to: 5 },
          content: "",
          status: "pending",
          timestamp: 1_700_000_000_000,
          color: "yellow",
        },
        {
          id: "ann_legacy_2",
          author: "claude",
          type: "comment",
          range: { from: 10, to: 20 },
          content: "suggest rewording",
          status: "pending",
          timestamp: 1_700_000_000_100,
          suggestedText: "better wording",
        },
      ],
      replies: [
        {
          id: "rep_legacy_1",
          annotationId: "ann_legacy_2",
          author: "user",
          text: "sounds good",
          timestamp: 1_700_000_000_200,
        },
      ],
    };

    const { doc: migrated, droppedAnnotations, droppedReplies } = migrateToV1(legacy);

    expect(migrated.schemaVersion).toBe(SCHEMA_VERSION);
    expect(migrated.docHash).toBe("");
    expect(migrated.meta).toEqual({ filePath: "", lastUpdated: 0 });
    expect(migrated.tombstones).toEqual([]);

    expect(migrated.annotations).toHaveLength(2);
    expect(migrated.annotations[0]?.rev).toBe(0);
    expect(migrated.annotations[1]?.rev).toBe(0);
    expect(migrated.annotations[0]?.id).toBe("ann_legacy_1");
    expect(migrated.annotations[1]?.suggestedText).toBe("better wording");

    expect(migrated.replies).toHaveLength(1);
    expect(migrated.replies[0]?.rev).toBe(0);
    expect(migrated.replies[0]?.text).toBe("sounds good");

    expect(droppedAnnotations).toBe(0);
    expect(droppedReplies).toBe(0);
  });

  it("produces a doc that passes full v1 validation", () => {
    const legacy = {
      annotations: [
        {
          id: "ann_1",
          author: "claude",
          type: "flag",
          range: { from: 0, to: 3 },
          content: "check this",
          status: "pending",
          timestamp: 1,
          directedAt: "claude",
        },
      ],
      replies: [],
    };
    const { doc: migrated } = migrateToV1(legacy);
    const round = AnnotationDocSchemaV1.safeParse(migrated);
    expect(round.success).toBe(true);

    // ADR-027: legacy `flag` migrates to `note`.
    expect(migrated.annotations).toHaveLength(1);
    expect(migrated.annotations[0]?.type).toBe("note");
    // ADR-027: directedAt is stripped on migration.
    expect(migrated.annotations[0]?.directedAt).toBeUndefined();
    // Envelope schema requires `rev`; legacy records get `rev: 0`.
    expect(migrated.annotations[0]?.rev).toBe(0);
  });

  it("tolerates completely empty input", () => {
    const { doc: migrated, droppedAnnotations, droppedReplies } = migrateToV1({});
    expect(migrated.annotations).toEqual([]);
    expect(migrated.replies).toEqual([]);
    expect(migrated.tombstones).toEqual([]);
    expect(migrated.schemaVersion).toBe(1);
    expect(droppedAnnotations).toBe(0);
    expect(droppedReplies).toBe(0);
  });

  it("skips malformed annotation records (lossy upgrade, tallied in droppedAnnotations)", () => {
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const legacy = {
      annotations: [
        // Valid
        {
          id: "good",
          author: "user",
          type: "comment",
          range: { from: 0, to: 1 },
          content: "",
          status: "pending",
          timestamp: 1,
        },
        // Invalid — missing `id`
        {
          author: "user",
          type: "comment",
          range: { from: 0, to: 1 },
          content: "",
          status: "pending",
          timestamp: 1,
        },
        // Invalid — not an object
        "garbage",
      ],
    };
    const { doc: migrated, droppedAnnotations } = migrateToV1(legacy);
    expect(migrated.annotations).toHaveLength(1);
    expect(migrated.annotations[0]?.id).toBe("good");
    // Two invalid records (missing id, "garbage" string) → counted as drops.
    expect(droppedAnnotations).toBe(2);
    errorSpy.mockRestore();
  });

  it("tolerates non-object input without throwing", () => {
    expect(() => migrateToV1(null)).not.toThrow();
    expect(() => migrateToV1("nope")).not.toThrow();
    expect(() => migrateToV1(42)).not.toThrow();
    const { doc: migrated } = migrateToV1(null);
    expect(migrated.annotations).toEqual([]);
  });

  it("counts reply drops separately from annotation drops", () => {
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const legacy = {
      annotations: [],
      replies: [
        // Valid
        {
          id: "rep_good",
          annotationId: "ann_1",
          author: "user",
          text: "ok",
          timestamp: 1,
        },
        // Invalid — not an object
        "garbage",
        // Invalid — missing required fields
        { author: "user" },
      ],
    };
    const { droppedAnnotations, droppedReplies, doc } = migrateToV1(legacy);
    expect(droppedAnnotations).toBe(0);
    expect(droppedReplies).toBe(2);
    expect(doc.replies).toHaveLength(1);
    expect(doc.replies[0]?.id).toBe("rep_good");
    errorSpy.mockRestore();
  });

  it("treats non-array annotations/replies as empty (no drops attributed)", () => {
    const { droppedAnnotations, droppedReplies, doc } = migrateToV1({
      annotations: "not-an-array",
      replies: 42,
    });
    expect(droppedAnnotations).toBe(0);
    expect(droppedReplies).toBe(0);
    expect(doc.annotations).toEqual([]);
    expect(doc.replies).toEqual([]);
  });

  it("logs the summary line plus per-record details when records are dropped", () => {
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    migrateToV1({
      annotations: [null, "garbage"],
      replies: [{ author: "user" }],
    });
    // Summary line + per-record log for the malformed reply (the two annotation
    // entries are non-objects and short-circuit before per-record logging).
    const summary = errorSpy.mock.calls.find((args) =>
      String(args[0]).includes("migrateToV1 dropped"),
    );
    const replyDetail = errorSpy.mock.calls.find((args) =>
      String(args[0]).includes("dropping reply"),
    );
    expect(summary).toBeDefined();
    expect(replyDetail).toBeDefined();

    errorSpy.mockClear();
    // Clean input → no log.
    migrateToV1({});
    expect(errorSpy).not.toHaveBeenCalled();

    errorSpy.mockRestore();
  });
});

describe("highlight color migration", () => {
  it("migrateToV1 maps legacy red to yellow and purple to blue", () => {
    const legacy = {
      annotations: [
        {
          id: "ann_red",
          author: "claude",
          type: "highlight",
          range: { from: 0, to: 5 },
          content: "",
          status: "pending",
          timestamp: 1,
          color: "red",
        },
        {
          id: "ann_purple",
          author: "user",
          type: "highlight",
          range: { from: 6, to: 10 },
          content: "",
          status: "pending",
          timestamp: 2,
          color: "purple",
        },
        {
          id: "ann_yellow",
          author: "user",
          type: "highlight",
          range: { from: 11, to: 15 },
          content: "",
          status: "pending",
          timestamp: 3,
          color: "yellow",
        },
      ],
    };
    const { doc, droppedAnnotations } = migrateToV1(legacy);
    expect(droppedAnnotations).toBe(0);
    expect(doc.annotations).toHaveLength(3);
    expect(doc.annotations[0]?.color).toBe("yellow");
    expect(doc.annotations[1]?.color).toBe("blue");
    expect(doc.annotations[2]?.color).toBe("yellow");
  });

  it("parseAnnotationDoc migrates legacy colors in v1 files", () => {
    const docWithOldColors: AnnotationDocV1 = {
      ...validDoc,
      annotations: [
        { ...baseAnnotation, id: "ann_r", type: "highlight", color: "red" as never },
        { ...baseAnnotation, id: "ann_p", type: "highlight", color: "purple" as never },
        { ...baseAnnotation, id: "ann_b", type: "highlight", color: "blue" },
      ],
    };
    const result = parseAnnotationDoc(docWithOldColors);
    if (!result.ok) throw new Error("expected success");
    expect(result.doc.annotations[0]?.color).toBe("yellow");
    expect(result.doc.annotations[1]?.color).toBe("blue");
    expect(result.doc.annotations[2]?.color).toBe("blue");
  });

  it("migrateToV1 passes through annotations without a color field", () => {
    const legacy = {
      annotations: [
        {
          id: "ann_comment",
          author: "user",
          type: "comment",
          range: { from: 0, to: 5 },
          content: "A note",
          status: "pending",
          timestamp: 1,
        },
      ],
    };
    const { doc, droppedAnnotations } = migrateToV1(legacy);
    expect(droppedAnnotations).toBe(0);
    expect(doc.annotations).toHaveLength(1);
    expect(doc.annotations[0]?.color).toBeUndefined();
  });

  it("migrateToV1 drops annotations with unknown future colors", () => {
    const legacy = {
      annotations: [
        {
          id: "ann_orange",
          author: "claude",
          type: "highlight",
          range: { from: 0, to: 5 },
          content: "",
          status: "pending",
          timestamp: 1,
          color: "orange",
        },
      ],
    };
    const { doc, droppedAnnotations } = migrateToV1(legacy);
    expect(droppedAnnotations).toBe(1);
    expect(doc.annotations).toHaveLength(0);
  });
});

describe("AnnotationRecordSchemaV1 — per-record shape", () => {
  it("accepts a relRange with Yjs-shaped SerializedRelPos values", () => {
    // SerializedRelPos is opaque at the type level; on the wire it's an object
    // with optional {type, tname, item, assoc} fields — Yjs omits fields that
    // are null/undefined (see node_modules/yjs/src/utils/RelativePosition.js).
    // The schema validates the envelope shape, not the Yjs-internal semantics.
    const withRel = {
      ...baseAnnotation,
      relRange: {
        fromRel: { item: { client: 1, clock: 0 }, assoc: 0 },
        toRel: { item: { client: 1, clock: 5 }, assoc: 0 },
      },
    };
    const result = AnnotationRecordSchemaV1.safeParse(withRel);
    expect(result.success).toBe(true);
  });

  it("rejects a negative range offset", () => {
    const bad = { ...baseAnnotation, range: { from: -1, to: 5 } };
    const result = AnnotationRecordSchemaV1.safeParse(bad);
    expect(result.success).toBe(false);
  });

  it("rejects an unknown annotation type", () => {
    const bad = { ...baseAnnotation, type: "bogus" };
    const result = AnnotationRecordSchemaV1.safeParse(bad);
    expect(result.success).toBe(false);
  });

  it("accepts a relRange with all SerializedRelPos fields omitted (Yjs null-strip edge)", () => {
    // `Y.relativePositionToJSON` omits fields that are null/undefined. A
    // relative position anchored at the start/end of a type can serialize to
    // `{}` — the schema must accept it, not reject as "missing required field".
    const withRel = {
      ...baseAnnotation,
      relRange: { fromRel: {}, toRel: {} },
    };
    const result = AnnotationRecordSchemaV1.safeParse(withRel);
    expect(result.success).toBe(true);
  });

  it("accepts assoc: 0 (falsy but valid)", () => {
    // Zod's `.optional()` uses `=== undefined` for the presence check, so a
    // falsy-but-defined value like `0` is distinct from omitted and must
    // pass. Guards against anyone "simplifying" to `z.number().positive()`.
    const withRel = {
      ...baseAnnotation,
      relRange: {
        fromRel: { assoc: 0 },
        toRel: { assoc: 0 },
      },
    };
    const result = AnnotationRecordSchemaV1.safeParse(withRel);
    expect(result.success).toBe(true);
  });

  it("round-trips a relRange with only assoc through JSON", () => {
    // Passthrough on SerializedRelPosSchema must preserve the Yjs-opaque
    // `item` field untouched; round-trip guards against a future `.strict()`
    // change silently stripping it.
    const withRel = {
      ...baseAnnotation,
      relRange: {
        fromRel: { item: { client: 42, clock: 100 }, assoc: 0 },
        toRel: { item: { client: 42, clock: 105 }, assoc: 0, tname: "body" },
      },
    };
    const parsed = parseAnnotationDoc({ ...validDoc, annotations: [withRel] });
    if (!parsed.ok) throw new Error("expected success");
    const ann = parsed.doc.annotations[0] as Record<string, unknown> & { relRange?: unknown };
    expect(ann.relRange).toEqual(withRel.relRange);
  });

  it("rejects a record that still carries directedAt (ADR-027 regression)", () => {
    // Production paths (parseAnnotationDoc, migrateToV1) strip directedAt via
    // migrateFlagAndDirectedAt before reaching safeParse. This test verifies
    // that any caller bypassing migration is caught by the schema refine.
    const stale = { ...baseAnnotation, directedAt: "claude" };
    const result = AnnotationRecordSchemaV1.safeParse(stale);
    expect(result.success).toBe(false);
    if (!result.success) {
      const paths = result.error.issues.map((i) => i.path.join("."));
      expect(paths).toContain("directedAt");
    }
  });
});

describe("parseAnnotationDoc — console.error on corrupt input", () => {
  it("logs schema validation issues when the envelope is corrupt", () => {
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const bad = { ...validDoc, annotations: "not an array" };
    const result = parseAnnotationDoc(bad);
    expect(result).toEqual({ ok: false, error: "corrupt" });
    expect(errorSpy).toHaveBeenCalled();
    errorSpy.mockRestore();
  });

  it("logs when JSON.parse fails on a string input", () => {
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const result = parseAnnotationDoc("{not valid json");
    expect(result).toEqual({ ok: false, error: "corrupt" });
    expect(errorSpy).toHaveBeenCalled();
    errorSpy.mockRestore();
  });

  it("logs when input is non-object (number, boolean, null)", () => {
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    expect(parseAnnotationDoc(42)).toEqual({ ok: false, error: "corrupt" });
    expect(parseAnnotationDoc(null)).toEqual({ ok: false, error: "corrupt" });
    expect(errorSpy).toHaveBeenCalledTimes(2);
    errorSpy.mockRestore();
  });
});

describe("parseAnnotationDoc — heterogeneous-envelope migration", () => {
  it("migrates a mixed envelope: flag→note, strips directedAt, leaves canonical records intact", () => {
    // Construct a single envelope whose annotations array contains four records
    // in different pre-migration states. parseAnnotationDoc must migrate all of
    // them before schema validation and return a fully canonical doc.
    const envelope = {
      schemaVersion: 1 as const,
      docHash: "sha256:aabbccdd",
      meta: { filePath: "/docs/mixed.md", lastUpdated: 1_744_819_200_000 },
      tombstones: [],
      replies: [],
      annotations: [
        // 1. Legacy flag type (no directedAt)
        {
          id: "ann_flag",
          author: "user",
          type: "flag",
          range: { from: 0, to: 5 },
          content: "check this",
          status: "pending",
          timestamp: 1_700_000_000_000,
          rev: 1,
        },
        // 2. Canonical note (already correct shape)
        {
          id: "ann_note",
          author: "user",
          type: "note",
          range: { from: 6, to: 11 },
          content: "personal note",
          status: "pending",
          timestamp: 1_700_000_000_001,
          rev: 0,
        },
        // 3. Comment with stray directedAt (pre-ADR-027 on-disk record)
        {
          id: "ann_stale",
          author: "claude",
          type: "comment",
          range: { from: 12, to: 20 },
          content: "please clarify",
          status: "pending",
          timestamp: 1_700_000_000_002,
          rev: 3,
          directedAt: "claude",
        },
        // 4. Canonical comment (nothing to migrate)
        {
          id: "ann_canonical",
          author: "claude",
          type: "comment",
          range: { from: 21, to: 30 },
          content: "looks good",
          status: "pending",
          timestamp: 1_700_000_000_003,
          rev: 2,
        },
      ],
    };

    const result = parseAnnotationDoc(envelope);
    if (!result.ok) throw new Error(`expected success, got: ${result.error}`);

    expect(result.doc.annotations).toHaveLength(4);

    // Record 1: flag → note
    const rec1 = result.doc.annotations[0] as Record<string, unknown>;
    expect(rec1.id).toBe("ann_flag");
    expect(rec1.type).toBe("note");

    // Record 2: canonical note — unchanged
    const rec2 = result.doc.annotations[1] as Record<string, unknown>;
    expect(rec2.id).toBe("ann_note");
    expect(rec2.type).toBe("note");

    // Record 3: stray directedAt stripped
    const rec3 = result.doc.annotations[2] as Record<string, unknown>;
    expect(rec3.id).toBe("ann_stale");
    expect(rec3.type).toBe("comment");
    expect(rec3.directedAt).toBeUndefined();

    // Record 4: canonical comment — unchanged
    const rec4 = result.doc.annotations[3] as Record<string, unknown>;
    expect(rec4.id).toBe("ann_canonical");
    expect(rec4.type).toBe("comment");
    expect(rec4.directedAt).toBeUndefined();
  });
});

describe("migrateToV1 — drop logging", () => {
  afterEach(() => resetMigrationLog());

  it("logs dropped annotations with their id and Zod issues", () => {
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const result = migrateToV1({
      annotations: [
        {
          id: "ann_bad",
          type: "comment",
          range: { from: 0, to: 5 } /* missing content/status/etc */,
        },
      ],
      replies: [],
    });
    expect(result.droppedAnnotations).toBe(1);
    const found = errorSpy.mock.calls.some(
      (args) =>
        String(args[0]).includes("dropping annotation id=ann_bad") && Array.isArray(args[1]),
    );
    expect(found).toBe(true);
    errorSpy.mockRestore();
  });

  it("logs dropped replies with their id and Zod issues", () => {
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const result = migrateToV1({
      annotations: [],
      replies: [{ id: "rep_bad" /* missing annotationId/author/text/timestamp */ }],
    });
    expect(result.droppedReplies).toBe(1);
    const found = errorSpy.mock.calls.some(
      (args) => String(args[0]).includes("dropping reply id=rep_bad") && Array.isArray(args[1]),
    );
    expect(found).toBe(true);
    errorSpy.mockRestore();
  });
});

describe("migrateFlagAndDirectedAt — dedup via parseAnnotationDoc", () => {
  afterEach(() => resetMigrationLog());

  it("logs flag→note migration once per doc, even with multiple flag records", () => {
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const envelope = {
      schemaVersion: 1 as const,
      docHash: "sha256:dedup-flag",
      meta: { filePath: "/d.md", lastUpdated: 0 },
      tombstones: [],
      replies: [],
      annotations: [
        {
          id: "f1",
          author: "user",
          type: "flag",
          range: { from: 0, to: 1 },
          content: "",
          status: "pending",
          timestamp: 0,
          rev: 1,
        },
        {
          id: "f2",
          author: "user",
          type: "flag",
          range: { from: 2, to: 3 },
          content: "",
          status: "pending",
          timestamp: 0,
          rev: 1,
        },
      ],
    };
    const result = parseAnnotationDoc(envelope);
    expect(result.ok).toBe(true);
    const flagLogs = errorSpy.mock.calls.filter((args) =>
      String(args[0]).includes("legacy migration: flag in sha256:dedup-flag"),
    );
    expect(flagLogs).toHaveLength(1);
    errorSpy.mockRestore();
  });

  it("logs flag and directedAt independently for the same doc", () => {
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const envelope = {
      schemaVersion: 1 as const,
      docHash: "sha256:dedup-both",
      meta: { filePath: "/d.md", lastUpdated: 0 },
      tombstones: [],
      replies: [],
      annotations: [
        {
          id: "f1",
          author: "user",
          type: "flag",
          range: { from: 0, to: 1 },
          content: "",
          status: "pending",
          timestamp: 0,
          rev: 1,
          directedAt: "claude",
        },
      ],
    };
    parseAnnotationDoc(envelope);
    const flagLogs = errorSpy.mock.calls.filter((args) =>
      String(args[0]).includes("legacy migration: flag in sha256:dedup-both"),
    );
    const directedAtLogs = errorSpy.mock.calls.filter((args) =>
      String(args[0]).includes("legacy migration: directedAt in sha256:dedup-both"),
    );
    expect(flagLogs).toHaveLength(1);
    expect(directedAtLogs).toHaveLength(1);
    errorSpy.mockRestore();
  });
});
