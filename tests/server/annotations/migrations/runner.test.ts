import { describe, expect, it } from "vitest";

import { migrateUp, migrateV1ToV2 } from "../../../../src/server/annotations/migrations/index.js";
import {
  type AnnotationDocV1,
  parseAnnotationDoc,
} from "../../../../src/server/annotations/schema.js";

/**
 * A minimal, well-formed v1 envelope. Mirrors the shape exercised by
 * `schema.test.ts`'s `validDoc` but kept local so this suite stands alone.
 */
const v1Doc: AnnotationDocV1 = {
  schemaVersion: 1,
  docHash: "sha256:deadbeef",
  meta: { filePath: "/path/to/doc.md", lastUpdated: 1_744_819_200_000 },
  annotations: [
    {
      id: "ann_1_abc",
      author: "claude",
      type: "comment",
      range: { from: 0, to: 10 },
      content: "hello",
      status: "pending",
      timestamp: 1_700_000_000_000,
      rev: 2,
    },
  ],
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

describe("migrateUp (runner)", () => {
  it("is a no-op (returns the input by reference) when fromVersion === toVersion", () => {
    const input = { schemaVersion: 1, annotations: [] };
    expect(migrateUp(input, 1, 1)).toBe(input);
  });

  it("throws when toVersion < fromVersion", () => {
    expect(() => migrateUp({}, 2, 1)).toThrow(/Cannot migrate down/);
  });

  it("throws when no migration is registered for the requested step", () => {
    // The chain registers v1 → v2 only; asking for v2 → v3 must fail loudly
    // rather than silently default.
    expect(() => migrateUp(v1Doc, 2, 3)).toThrow(/No migration registered from v2 to v3/);
  });
});

describe("migrateV1ToV2 (pairwise)", () => {
  it("re-stamps schemaVersion to 2 and otherwise preserves the payload", () => {
    const out = migrateV1ToV2(v1Doc) as AnnotationDocV1;
    expect(out.schemaVersion).toBe(2);
    // Everything except schemaVersion is identical.
    expect({ ...out, schemaVersion: 1 }).toEqual(v1Doc);
  });

  it("preserves forward-compatible passthrough fields", () => {
    const withExtra = { ...v1Doc, futureField: { keep: true } };
    const out = migrateV1ToV2(withExtra) as Record<string, unknown>;
    expect(out.schemaVersion).toBe(2);
    expect(out.futureField).toEqual({ keep: true });
  });

  it("does not mutate its input", () => {
    const snapshot = structuredClone(v1Doc);
    migrateV1ToV2(v1Doc);
    expect(v1Doc).toEqual(snapshot);
  });

  it("rejects a malformed v1 payload (input contract is enforced)", () => {
    // `rev` is required on every annotation record; omitting it is invalid v1.
    const bad = {
      ...v1Doc,
      annotations: [{ ...v1Doc.annotations[0], rev: undefined }],
    };
    expect(() => migrateV1ToV2(bad)).toThrow();
  });

  it("rejects a non-object input", () => {
    expect(() => migrateV1ToV2(null)).toThrow();
    expect(() => migrateV1ToV2("nope")).toThrow();
  });

  // Regression tripwire for the frozen-input contract. The migration's input
  // version must be pinned to the literal `1`, NOT the live `SCHEMA_VERSION`.
  // If a future PR bumps `SCHEMA_VERSION` to 2 and someone reverts this
  // migration to validate against `AnnotationDocSchemaV1` (which tracks the
  // live constant), these two assertions flip and fail: the live schema would
  // start accepting `schemaVersion: 2` and rejecting the genuine v1 input the
  // migration is supposed to consume — silently quarantining all annotations
  // as corrupt on the first post-upgrade load.
  it("pins its input contract to schemaVersion === 1, independent of SCHEMA_VERSION", () => {
    expect(() => migrateV1ToV2(v1Doc)).not.toThrow();
    expect(() => migrateV1ToV2({ ...v1Doc, schemaVersion: 2 })).toThrow();
  });
});

describe("migrateUp (composition)", () => {
  it("drives v1 → v2 through the registered chain", () => {
    const out = migrateUp(v1Doc, 1, 2) as AnnotationDocV1;
    expect(out.schemaVersion).toBe(2);
    expect({ ...out, schemaVersion: 1 }).toEqual(v1Doc);
  });

  it("composed path matches calling the pairwise migration directly", () => {
    expect(migrateUp(v1Doc, 1, 2)).toEqual(migrateV1ToV2(v1Doc));
  });
});

describe("parseAnnotationDoc — migration wiring is dormant at SCHEMA_VERSION 1", () => {
  it("loads a v1 file unchanged (the dormant v1 → v2 migration never fires)", () => {
    const result = parseAnnotationDoc(v1Doc);
    if (!result.ok) throw new Error("expected success");
    // schemaVersion stays 1: migrateUp(candidate, 1, SCHEMA_VERSION=1) is a no-op.
    expect(result.doc.schemaVersion).toBe(1);
    expect(result.doc).toEqual(v1Doc);
  });
});
