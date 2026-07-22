import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { resolveLocalModelConfig } from "../../../src/server/local-model/config-source.js";
import {
  __resetModelRegistryForTests,
  getCachedModelsFile,
  persistModelsFile,
  primeModelStoreCache,
} from "../../../src/server/models/registry.js";
import { createModelStore } from "../../../src/server/models/store.js";
import type { ModelsEntry, ModelsFile } from "../../../src/shared/models/contract.js";
import { AgentIdentitySchema } from "../../../src/shared/types.js";

const local: ModelsEntry = {
  id: "m-local",
  provider: "local-ollama",
  displayName: "Local",
  modelId: "qwen2.5:14b-instruct",
  endpoint: "http://127.0.0.1:11434",
  enabled: true,
};
const cloud: ModelsEntry = {
  id: "m-cloud",
  provider: "anthropic",
  displayName: "Claude",
  modelId: "claude-opus-4-8",
  apiKeyRef: "ref-abc",
  enabled: true,
};

function fileWith(models: ModelsEntry[], defaultModelId: string | null): ModelsFile {
  return { schemaVersion: 1, models, defaultModelId };
}

describe("resolveLocalModelConfig (via server-side registry)", () => {
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), "tandem-resolver-"));
    __resetModelRegistryForTests(tmpDir);
    vi.spyOn(console, "error").mockImplementation(() => {});
  });

  afterEach(async () => {
    __resetModelRegistryForTests();
    vi.restoreAllMocks();
    if (tmpDir) await fs.promises.rm(tmpDir, { recursive: true, force: true });
  });

  it("BOOT-WARM: a valid models.json on disk resolves on the FIRST sync call (cold cache)", async () => {
    // Seed the file WITHOUT touching the singleton cache (write via a separate
    // store), then prime from disk — this is exactly the fresh-boot path. A
    // write-only-refreshed cache would return null here.
    await createModelStore(tmpDir).write(fileWith([local], "m-local"));
    expect(resolveLocalModelConfig()).toBeNull(); // cache cold before prime
    await primeModelStoreCache();
    expect(resolveLocalModelConfig()).toEqual({
      endpoint: "http://127.0.0.1:11434",
      modelId: "qwen2.5:14b-instruct",
      transport: "v1",
      // #1123 M3: identity carried through for the byline.
      agentIdentity: { provider: "local-ollama", displayName: "Local" },
    });
  });

  it("no default → null", async () => {
    await persistModelsFile(fileWith([local], null));
    expect(resolveLocalModelConfig()).toBeNull();
  });

  it("cloud default → inert (null); the loop only drives local endpoints", async () => {
    await persistModelsFile(fileWith([cloud], "m-cloud"));
    expect(resolveLocalModelConfig()).toBeNull();
  });

  it("disabled default → null", async () => {
    await persistModelsFile(fileWith([{ ...local, enabled: false }], "m-local"));
    expect(resolveLocalModelConfig()).toBeNull();
  });

  it("local default without endpoint → null", async () => {
    await persistModelsFile(fileWith([{ ...local, endpoint: undefined }], "m-local"));
    expect(resolveLocalModelConfig()).toBeNull();
  });

  it("non-loopback endpoint → null (SSRF defense at resolve time)", async () => {
    await persistModelsFile(fileWith([{ ...local, endpoint: "http://10.0.0.5:11434" }], "m-local"));
    expect(resolveLocalModelConfig()).toBeNull();
  });

  it("prime swallows a read failure → empty cache, resolver null (never throws at boot)", async () => {
    await fs.promises.writeFile(createModelStore(tmpDir).filePath, "{broken", "utf8");
    await primeModelStoreCache();
    expect(getCachedModelsFile().models).toHaveLength(0);
    expect(resolveLocalModelConfig()).toBeNull();
  });

  it("persist keeps the cache coherent (write-through)", async () => {
    await persistModelsFile(fileWith([local], "m-local"));
    expect(resolveLocalModelConfig()?.modelId).toBe("qwen2.5:14b-instruct");
  });

  it("selects the default by id, not by position (cloud entry first, local default second)", async () => {
    // A `models[0]` regression would resolve the cloud entry here → null,
    // instead of finding the local default at index 1. The single-entry cases
    // above cannot catch that; this one can.
    await persistModelsFile(fileWith([cloud, local], "m-local"));
    expect(resolveLocalModelConfig()).toEqual({
      endpoint: "http://127.0.0.1:11434",
      modelId: "qwen2.5:14b-instruct",
      transport: "v1",
      agentIdentity: { provider: "local-ollama", displayName: "Local" },
    });
  });

  it("carries the resolved entry's provider + displayName (#1123 M3 byline source)", async () => {
    // The identity previously read-and-discarded is now surfaced so the loop can
    // stamp `agentIdentity`. Distinct displayName so a hardcoded default can't
    // pass this by accident.
    await persistModelsFile(fileWith([{ ...local, displayName: "Qwen 2.5 (14B)" }], "m-local"));
    const config = resolveLocalModelConfig();
    expect(config?.agentIdentity).toEqual({
      provider: "local-ollama",
      displayName: "Qwen 2.5 (14B)",
    });
  });

  it("clamps an over-long displayName to the durable bound (#1123 M3 corruption guard)", async () => {
    // The registry permits a longer displayName (client ≤256, server unbounded)
    // than AgentIdentitySchema (120). Without the clamp, a stamped over-long name
    // fails AnnotationRecordSchemaV1 on reload and quarantines the WHOLE
    // annotations file. The resolver is the sole builder, so it must clamp.
    const longName = "M".repeat(200);
    await persistModelsFile(fileWith([{ ...local, displayName: longName }], "m-local"));
    const config = resolveLocalModelConfig();
    expect(config?.agentIdentity?.displayName.length).toBe(120);
    expect(config?.agentIdentity?.displayName).toBe("M".repeat(120));
    // And the clamped value validates against the durable schema.
    expect(AgentIdentitySchema.safeParse(config?.agentIdentity).success).toBe(true);
  });
});
