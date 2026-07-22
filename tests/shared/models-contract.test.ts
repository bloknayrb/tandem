import { describe, expect, expectTypeOf, it } from "vitest";
import { z } from "zod";
import type { ModelRegistryEntry } from "../../src/client/hooks/useTandemSettings.js";
import { ModelsEntrySchema, ModelsFileSchema } from "../../src/server/models/schema.js";
import type { ModelsEntry, ModelsFile } from "../../src/shared/models/contract.js";

/**
 * Contract conformance for the relocated Models registry (#1123 M1a):
 *  - the server's Zod-derived types stay assignable to the shared wire types;
 *  - the shared persisted entry is the client entry minus the transient
 *    `_legacyApiKey` (so the one-time migration's projection is total);
 *  - `.strict()` rejects a plaintext key at the schema level.
 */
describe("models contract conformance", () => {
  it("z.infer<ModelsFileSchema> matches shared ModelsFile", () => {
    expectTypeOf<z.infer<typeof ModelsFileSchema>>().toMatchTypeOf<ModelsFile>();
  });

  it("z.infer<ModelsEntrySchema> matches shared ModelsEntry", () => {
    expectTypeOf<z.infer<typeof ModelsEntrySchema>>().toMatchTypeOf<ModelsEntry>();
  });

  it("shared ModelsEntry is the client entry minus _legacyApiKey", () => {
    expectTypeOf<ModelsEntry>().toMatchTypeOf<Omit<ModelRegistryEntry, "_legacyApiKey">>();
  });

  it("parses a valid file", () => {
    const ok = ModelsFileSchema.safeParse({
      schemaVersion: 1,
      models: [
        {
          id: "m-1",
          provider: "local-ollama",
          displayName: "Local",
          modelId: "qwen2.5:14b",
          endpoint: "http://127.0.0.1:11434",
          enabled: true,
        },
      ],
      defaultModelId: "m-1",
    });
    expect(ok.success).toBe(true);
  });

  it("rejects a plaintext apiKey / _legacyApiKey (.strict)", () => {
    for (const bad of [{ apiKey: "sk-x" }, { _legacyApiKey: "sk-x" }]) {
      const res = ModelsEntrySchema.safeParse({
        id: "m-1",
        provider: "anthropic",
        displayName: "C",
        modelId: "claude",
        enabled: true,
        ...bad,
      });
      expect(res.success).toBe(false);
    }
  });
});
