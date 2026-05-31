import { describe, expect, it } from "vitest";
import { migrateV1ToV2, V2 } from "../../../../src/server/annotations/migrations/v1_to_v2.js";

/**
 * Regression for the #947 review HIGH finding: `migrateV1ToV2`'s input contract
 * must be FROZEN to `schemaVersion === 1`, not tracking the live `SCHEMA_VERSION`.
 *
 * If the input schema tracked the const, the day a future PR bumps
 * `SCHEMA_VERSION` to 2 to activate the chain, this migration would start
 * requiring `schemaVersion === 2` and reject every genuine v1 file —
 * quarantining the whole store as `corrupt`. The frozen `z.literal(V1)` input
 * keeps the "bump the const, no further wiring" promise true.
 */
const validV1 = () => ({
  schemaVersion: 1,
  annotations: [
    {
      id: "a1",
      author: "claude",
      type: "comment",
      status: "open",
      range: { start: 0, end: 5 },
      rev: 1,
      createdAt: 1,
      updatedAt: 1,
    },
  ],
  replies: [],
  tombstones: [],
});

describe("migrateV1ToV2 input contract (frozen to v1)", () => {
  it("accepts a genuine v1 envelope and re-stamps to v2", () => {
    const out = migrateV1ToV2(validV1()) as { schemaVersion: number };
    expect(out.schemaVersion).toBe(V2);
  });

  it("rejects a non-v1 schemaVersion (input pinned to literal 1, not SCHEMA_VERSION)", () => {
    expect(() => migrateV1ToV2({ ...validV1(), schemaVersion: 2 })).toThrow();
    expect(() => migrateV1ToV2({ ...validV1(), schemaVersion: 3 })).toThrow();
  });

  it("preserves passthrough/unknown fields across the migration", () => {
    const out = migrateV1ToV2({ ...validV1(), futureField: "keep" }) as Record<string, unknown>;
    expect(out.futureField).toBe("keep");
    expect(out.schemaVersion).toBe(V2);
  });
});
