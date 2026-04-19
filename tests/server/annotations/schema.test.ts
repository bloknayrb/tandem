import { describe, expect, it } from "vitest";
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

    const migrated = migrateToV1(legacy);

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
        },
      ],
      replies: [],
    };
    const migrated = migrateToV1(legacy);
    const round = AnnotationDocSchemaV1.safeParse(migrated);
    expect(round.success).toBe(true);
  });

  it("tolerates completely empty input", () => {
    const migrated = migrateToV1({});
    expect(migrated.annotations).toEqual([]);
    expect(migrated.replies).toEqual([]);
    expect(migrated.tombstones).toEqual([]);
    expect(migrated.schemaVersion).toBe(1);
  });

  it("skips malformed annotation records silently (lossy upgrade)", () => {
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
    const migrated = migrateToV1(legacy);
    expect(migrated.annotations).toHaveLength(1);
    expect(migrated.annotations[0]?.id).toBe("good");
  });

  it("tolerates non-object input without throwing", () => {
    expect(() => migrateToV1(null)).not.toThrow();
    expect(() => migrateToV1("nope")).not.toThrow();
    expect(() => migrateToV1(42)).not.toThrow();
    const migrated = migrateToV1(null);
    expect(migrated.annotations).toEqual([]);
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
});
