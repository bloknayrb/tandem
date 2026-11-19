/**
 * `modelRowName` and `rowControlName` (#1123, ADR-039 item 27): the name a
 * Models-tab row is known by, and its controls' accessible names.
 */
import { describe, expect, it } from "vitest";
import { modelRowName, rowControlName } from "../../src/client/utils/local-model-copy";

describe("modelRowName", () => {
  it("the display name first", () => {
    expect(modelRowName({ displayName: "Mine", modelId: "m", id: "i" })).toBe("Mine");
  });
  it("then the model ID, when the name is empty or only spaces", () => {
    expect(modelRowName({ displayName: "", modelId: "m", id: "i" })).toBe("m");
    expect(modelRowName({ displayName: "   ", modelId: "m", id: "i" })).toBe("m");
    expect(modelRowName({ modelId: "m", id: "i" })).toBe("m");
  });
  it("then the id, when both are blank", () => {
    expect(modelRowName({ displayName: " ", modelId: "", id: "i" })).toBe("i");
  });
  it("trimmed", () => {
    expect(modelRowName({ displayName: "  Ollama  ", modelId: "m", id: "i" })).toBe("Ollama");
  });
  it('"" when all three are blank', () => {
    expect(modelRowName({ displayName: " ", modelId: "", id: "  " })).toBe("");
    expect(modelRowName({})).toBe("");
  });
});

describe("rowControlName", () => {
  it("starts with the visible word", () => {
    expect(rowControlName("Edit", "Qwen")).toBe("Edit Qwen");
    expect(rowControlName("Default", "Qwen", ": ")).toBe("Default: Qwen");
  });
  it("is the bare visible word without a row name, never a dangling separator", () => {
    expect(rowControlName("Edit", "")).toBe("Edit");
    expect(rowControlName("On", "", ": ")).toBe("On");
  });
});
