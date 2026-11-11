import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  type EndpointRejectCode,
  validateEndpoint,
} from "../../../src/server/local-model/config.js";
import {
  diagnoseLocalModel,
  type LocalModelResolution,
  resolveLocalModel,
  resolveLocalModelConfig,
} from "../../../src/server/local-model/config-source.js";
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

/**
 * The resolver's own seam. The store clears a dangling default and the schema
 * is the only thing that decides what an endpoint may hold, so two states are
 * reachable only by handing the resolver a registry directly: set `file` and
 * `getCachedModelsFile` answers it; leave it null and the real cache answers.
 */
const cacheOverride = vi.hoisted(() => ({ file: null as unknown }));
vi.mock("../../../src/server/models/registry.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../../src/server/models/registry.js")>();
  return {
    ...actual,
    getCachedModelsFile: () =>
      cacheOverride.file === null
        ? actual.getCachedModelsFile()
        : (cacheOverride.file as ReturnType<typeof actual.getCachedModelsFile>),
  };
});

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

describe("resolveLocalModel — every registry state (#1123)", () => {
  let tmpDir: string;

  const local2: ModelsEntry = { ...local, id: "m-local-2", displayName: "Second local" };
  const disabledLocal: ModelsEntry = { ...local, id: "m-off", enabled: false };
  const OK_CONFIG = {
    endpoint: "http://127.0.0.1:11434",
    modelId: "qwen2.5:14b-instruct",
    transport: "v1",
    agentIdentity: { provider: "local-ollama", displayName: "Local" },
  };

  /** One endpoint per reject code; the keys are checked against `validateEndpoint`. */
  const REJECTED: Record<EndpointRejectCode, string> = {
    MALFORMED_URL: "not a url",
    NON_HTTP: "https://127.0.0.1:11434",
    HAS_CREDENTIALS: "http://alice:s3cretpw@127.0.0.1:11434",
    NON_LOOPBACK_HOST: "http://10.0.0.5:11434",
  };

  type Unusable = Extract<LocalModelResolution, { kind: "unusable" }>;

  /** Resolve, and require the three entry points to tell the same story. */
  function resolveAll(): LocalModelResolution {
    const r = resolveLocalModel();
    const config = resolveLocalModelConfig();
    const diagnosis = diagnoseLocalModel();
    if (r.kind === "ok") {
      expect(config).toEqual(r.config);
      expect(diagnosis).toBeNull();
    } else if (r.kind === "unusable") {
      expect(config).toBeNull();
      expect(diagnosis).toEqual({ reason: r.reason, stateKey: r.stateKey, detail: r.detail });
    } else {
      expect(config).toBeNull();
      expect(diagnosis).toBeNull();
    }
    return r;
  }

  function unusableNow(): Unusable {
    const r = resolveAll();
    if (r.kind !== "unusable") throw new Error(`expected unusable, got ${r.kind}`);
    return r;
  }

  beforeEach(async () => {
    tmpDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), "tandem-resolver-states-"));
    __resetModelRegistryForTests(tmpDir);
    cacheOverride.file = null;
    vi.spyOn(console, "error").mockImplementation(() => {});
  });

  afterEach(async () => {
    cacheOverride.file = null;
    __resetModelRegistryForTests();
    vi.restoreAllMocks();
    if (tmpDir) await fs.promises.rm(tmpDir, { recursive: true, force: true });
  });

  describe("none — nothing to tell the user", () => {
    it("no models", async () => {
      expect(resolveAll()).toEqual({ kind: "none" }); // cold, empty cache
      await persistModelsFile(fileWith([], null));
      expect(resolveAll()).toEqual({ kind: "none" });
    });

    it("only cloud models, no default", async () => {
      await persistModelsFile(fileWith([cloud], null));
      expect(resolveAll()).toEqual({ kind: "none" });
    });

    it("only disabled models, no default", async () => {
      await persistModelsFile(fileWith([disabledLocal, { ...cloud, enabled: false }], null));
      expect(resolveAll()).toEqual({ kind: "none" });
    });

    it("no default with a disabled local and an enabled cloud model", async () => {
      await persistModelsFile(fileWith([disabledLocal, cloud], null));
      expect(resolveAll()).toEqual({ kind: "none" });
    });

    it("cloud default, even with an enabled local model beside it", async () => {
      await persistModelsFile(fileWith([cloud], "m-cloud"));
      expect(resolveAll()).toEqual({ kind: "none" });
      await persistModelsFile(fileWith([cloud, local], "m-cloud"));
      expect(resolveAll()).toEqual({ kind: "none" });
    });

    it("disabled default, even when another enabled local model exists", async () => {
      await persistModelsFile(fileWith([disabledLocal], "m-off"));
      expect(resolveAll()).toEqual({ kind: "none" });
      await persistModelsFile(fileWith([disabledLocal, local], "m-off"));
      expect(resolveAll()).toEqual({ kind: "none" });
    });
  });

  describe("unusable — no-default-chosen", () => {
    it("null default with one enabled local model", async () => {
      await persistModelsFile(fileWith([local], null));
      expect(unusableNow().reason).toBe("no-default-chosen");
    });

    it("null default with an enabled local model among cloud and disabled ones", async () => {
      await persistModelsFile(fileWith([cloud, disabledLocal, local], null));
      expect(unusableNow().reason).toBe("no-default-chosen");
    });

    it("the store clears a dangling default, so through the store it is the same state", async () => {
      await persistModelsFile(fileWith([local], "m-gone"));
      expect(getCachedModelsFile().defaultModelId).toBeNull();
      expect(unusableNow().reason).toBe("no-default-chosen");
    });

    it("a DANGLING default at the resolver seam behaves as no default", async () => {
      await persistModelsFile(fileWith([local], null));
      const viaNull = unusableNow();

      cacheOverride.file = fileWith([local], "m-gone");
      const dangling = unusableNow();
      expect(dangling).toEqual(viaNull); // same reason, stateKey and detail

      cacheOverride.file = fileWith([cloud], "m-gone");
      expect(resolveAll()).toEqual({ kind: "none" });
      cacheOverride.file = fileWith([disabledLocal], "m-gone");
      expect(resolveAll()).toEqual({ kind: "none" });
      cacheOverride.file = fileWith([], "m-gone");
      expect(resolveAll()).toEqual({ kind: "none" });
    });
  });

  describe("unusable — no-endpoint", () => {
    it("enabled local default with an absent endpoint", async () => {
      await persistModelsFile(fileWith([{ ...local, endpoint: undefined }], "m-local"));
      const r = unusableNow();
      expect(r.reason).toBe("no-endpoint");
      expect(r.detail).toContain("m-local");
    });

    it("enabled local default with an empty endpoint (resolver seam only)", () => {
      cacheOverride.file = fileWith([{ ...local, endpoint: "" }], "m-local");
      expect(unusableNow().reason).toBe("no-endpoint");
    });

    it("absent and empty are one state", () => {
      cacheOverride.file = fileWith([{ ...local, endpoint: undefined }], "m-local");
      const absent = unusableNow();
      cacheOverride.file = fileWith([{ ...local, endpoint: "" }], "m-local");
      expect(unusableNow()).toEqual(absent);
    });
  });

  describe("unusable — endpoint-rejected", () => {
    it.each(Object.entries(REJECTED) as [EndpointRejectCode, string][])(
      "%s",
      async (code, endpoint) => {
        // The fixture must really be rejected with this code by the validator.
        const check = validateEndpoint(endpoint);
        expect(check.ok === false && check.code).toBe(code);

        await persistModelsFile(fileWith([{ ...local, endpoint }], "m-local"));
        const r = unusableNow();
        expect(r.reason).toBe("endpoint-rejected");
        expect(r.detail).toContain(code);
        expect(r.detail).toContain("m-local");
      },
    );

    it("another usable local model does not rescue a rejected default", async () => {
      await persistModelsFile(
        fileWith([{ ...local, endpoint: REJECTED.NON_LOOPBACK_HOST }, local2], "m-local"),
      );
      expect(unusableNow().reason).toBe("endpoint-rejected");
    });
  });

  describe("ok", () => {
    it("enabled local default with a loopback endpoint", async () => {
      await persistModelsFile(fileWith([local], "m-local"));
      expect(resolveAll()).toEqual({ kind: "ok", config: OK_CONFIG });
    });

    it("is re-read on every call: a later write is seen with no restart", async () => {
      await persistModelsFile(fileWith([local], null));
      expect(resolveAll().kind).toBe("unusable");
      await persistModelsFile(fileWith([local], "m-local"));
      expect(resolveAll().kind).toBe("ok");
      await persistModelsFile(fileWith([{ ...local, modelId: "other:7b" }], "m-local"));
      expect(resolveLocalModelConfig()?.modelId).toBe("other:7b");
    });
  });

  describe("stateKey and detail", () => {
    const rejectedFile = (endpoint: string) => fileWith([{ ...local, endpoint }], "m-local");

    it("stateKey is stable for the same state, across calls and across a rewrite", async () => {
      await persistModelsFile(rejectedFile(REJECTED.NON_LOOPBACK_HOST));
      const first = unusableNow();
      expect(unusableNow().stateKey).toBe(first.stateKey);
      await persistModelsFile(fileWith([], null));
      await persistModelsFile(rejectedFile(REJECTED.NON_LOOPBACK_HOST));
      expect(unusableNow().stateKey).toBe(first.stateKey);
      expect(first.stateKey).toMatch(/^[0-9a-f]{64}$/); // a hash, not a description
    });

    it("stateKey differs between the three reasons", async () => {
      await persistModelsFile(fileWith([local], null));
      const noDefault = unusableNow();
      await persistModelsFile(fileWith([{ ...local, endpoint: undefined }], "m-local"));
      const noEndpoint = unusableNow();
      await persistModelsFile(rejectedFile(REJECTED.NON_LOOPBACK_HOST));
      const rejected = unusableNow();

      expect([noDefault.reason, noEndpoint.reason, rejected.reason]).toEqual([
        "no-default-chosen",
        "no-endpoint",
        "endpoint-rejected",
      ]);
      expect(new Set([noDefault.stateKey, noEndpoint.stateKey, rejected.stateKey]).size).toBe(3);
    });

    it("stateKey changes when the rejected endpoint string changes, even with the same code", async () => {
      await persistModelsFile(rejectedFile("http://10.0.0.5:11434"));
      const a = unusableNow();
      await persistModelsFile(rejectedFile("http://10.0.0.6:11434"));
      const b = unusableNow();
      expect(b.reason).toBe(a.reason);
      expect(b.detail).toBe(a.detail); // same id, same code
      expect(b.stateKey).not.toBe(a.stateKey);
    });

    it("stateKey for no-default-chosen does NOT change when another local model is added or removed", async () => {
      await persistModelsFile(fileWith([local], null));
      const one = unusableNow();
      await persistModelsFile(fileWith([local, local2], null));
      const two = unusableNow();
      await persistModelsFile(fileWith([local2], null));
      const other = unusableNow();
      expect(two.stateKey).toBe(one.stateKey);
      expect(other.stateKey).toBe(one.stateKey);
      expect(two.detail).toBe(one.detail);
    });

    it("neither stateKey nor detail carries the endpoint, its user name or its password", async () => {
      const endpoint = "http://alice:s3cretpw@evil.example:11434/v1";
      const rejectedBy: string[] = [];
      for (const candidate of [endpoint, REJECTED.HAS_CREDENTIALS]) {
        await persistModelsFile(rejectedFile(candidate));
        const r = unusableNow();
        rejectedBy.push(r.detail);
        for (const text of [r.stateKey, r.detail, JSON.stringify(diagnoseLocalModel())]) {
          expect(text).not.toContain(candidate);
          expect(text).not.toContain("alice");
          expect(text).not.toContain("s3cretpw");
          expect(text).not.toContain("evil.example");
          expect(text).not.toContain("11434");
        }
      }
      expect(rejectedBy.every((d) => d.includes("HAS_CREDENTIALS"))).toBe(true);
    });

    it("resolving logs nothing on any ordinary path", async () => {
      const spy = vi.mocked(console.error);
      const states: ModelsFile[] = [
        fileWith([], null),
        fileWith([local], null),
        fileWith([cloud], "m-cloud"),
        fileWith([disabledLocal], "m-off"),
        fileWith([{ ...local, endpoint: undefined }], "m-local"),
        rejectedFile(REJECTED.HAS_CREDENTIALS),
        fileWith([local], "m-local"),
      ];
      for (const state of states) {
        await persistModelsFile(state);
        spy.mockClear();
        resolveAll();
        expect(spy).not.toHaveBeenCalled();
      }
    });
  });
});
