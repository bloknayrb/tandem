import { describe, expect, it } from "vitest";
import { resolveDefaultModelChip } from "../../src/client/utils/model-chip";

const MODELS = [
  { id: "m1", displayName: "Qwen 2.5" },
  { id: "m2", displayName: "Llama 3.1" },
];

describe("resolveDefaultModelChip (#1123 M4 chip loading-gate)", () => {
  it("hides the chip while a registry load is in flight (kills the empty→label pop)", () => {
    // Even with a resolvable default, loading:true must yield null so the chip
    // never flashes before the async load settles.
    expect(
      resolveDefaultModelChip({ defaultModelId: "m1", models: MODELS, loading: true }),
    ).toBeNull();
  });

  it("shows the default entry's displayName once loaded", () => {
    expect(resolveDefaultModelChip({ defaultModelId: "m2", models: MODELS, loading: false })).toBe(
      "Llama 3.1",
    );
  });

  it("hides the chip when there is no configured default", () => {
    expect(
      resolveDefaultModelChip({ defaultModelId: null, models: MODELS, loading: false }),
    ).toBeNull();
  });

  it("hides the chip when the default id resolves to no entry", () => {
    expect(
      resolveDefaultModelChip({ defaultModelId: "gone", models: MODELS, loading: false }),
    ).toBeNull();
  });

  it("is null in the dark shape (no models, not loading, no default) — byte-identical", () => {
    expect(
      resolveDefaultModelChip({ defaultModelId: null, models: [], loading: false }),
    ).toBeNull();
  });
});
