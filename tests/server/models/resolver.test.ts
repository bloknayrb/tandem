import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  type EndpointRejectCode,
  validateEndpoint,
} from "../../../src/server/local-model/config.js";
import {
  answeringLocalModel,
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

  it("no default + the only enabled local model → that model answers (round 2)", async () => {
    // Round 2 replaced "no default → null": adding a model from Settings marks
    // no default, and a lone local model is the one the client already labels
    // as active.
    await persistModelsFile(fileWith([local], null));
    expect(resolveLocalModelConfig()).toEqual({
      endpoint: "http://127.0.0.1:11434",
      modelId: "qwen2.5:14b-instruct",
      transport: "v1",
      agentIdentity: { provider: "local-ollama", displayName: "Local" },
    });
  });

  it("no default + two enabled local models → null (nothing says which)", async () => {
    await persistModelsFile(fileWith([local, { ...local, id: "m-local-2" }], null));
    expect(resolveLocalModelConfig()).toBeNull();
  });

  it("no default + no enabled local model → null", async () => {
    await persistModelsFile(fileWith([{ ...local, enabled: false }, cloud], null));
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

  /** Resolve, and require the four entry points to tell the same story. */
  function resolveAll(): LocalModelResolution {
    const r = resolveLocalModel();
    const config = resolveLocalModelConfig();
    const diagnosis = diagnoseLocalModel();
    const answering = answeringLocalModel();
    if (r.kind === "ok") {
      expect(config).toEqual(r.config);
      expect(diagnosis).toBeNull();
      expect(answering).toEqual({
        entryId: r.entryId,
        endpoint: r.config.endpoint,
        modelId: r.config.modelId,
        displayName: r.config.agentIdentity.displayName,
      });
    } else if (r.kind === "unusable") {
      expect(config).toBeNull();
      expect(diagnosis).toEqual({ reason: r.reason, stateKey: r.stateKey, detail: r.detail });
      expect(answering).toBeNull();
    } else {
      expect(config).toBeNull();
      expect(diagnosis).toBeNull();
      expect(answering).toBeNull();
    }
    return r;
  }

  function okNow(): Extract<LocalModelResolution, { kind: "ok" }> {
    const r = resolveAll();
    if (r.kind !== "ok") throw new Error(`expected ok, got ${r.kind}`);
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

  describe("no default — a sole enabled local model answers unmarked (round 2)", () => {
    it("null default with one enabled local model → ok, naming that entry", async () => {
      await persistModelsFile(fileWith([local], null));
      expect(resolveAll()).toEqual({ kind: "ok", entryId: "m-local", config: OK_CONFIG });
    });

    it("null default with one enabled local model among cloud and disabled ones → that model", async () => {
      // Listed last, so a `models[0]` shortcut would land on the cloud entry.
      await persistModelsFile(fileWith([cloud, disabledLocal, local2], null));
      const r = okNow();
      expect(r.entryId).toBe("m-local-2");
      expect(r.config.agentIdentity).toEqual({
        provider: "local-ollama",
        displayName: "Second local",
      });
    });

    it("the store clears a dangling default, so through the store it is the same state", async () => {
      await persistModelsFile(fileWith([local], "m-gone"));
      expect(getCachedModelsFile().defaultModelId).toBeNull();
      expect(resolveAll()).toEqual({ kind: "ok", entryId: "m-local", config: OK_CONFIG });
    });

    it("a DANGLING default at the resolver seam behaves as no default, for 0, 1 and 2 locals", async () => {
      await persistModelsFile(fileWith([local], null));
      const oneViaNull = okNow();
      cacheOverride.file = fileWith([local], "m-gone");
      expect(okNow()).toEqual(oneViaNull);

      cacheOverride.file = null;
      await persistModelsFile(fileWith([local, local2], null));
      const twoViaNull = unusableNow();
      cacheOverride.file = fileWith([local, local2], "m-gone");
      expect(unusableNow()).toEqual(twoViaNull); // same reason, stateKey and detail

      cacheOverride.file = fileWith([cloud], "m-gone");
      expect(resolveAll()).toEqual({ kind: "none" });
      cacheOverride.file = fileWith([disabledLocal], "m-gone");
      expect(resolveAll()).toEqual({ kind: "none" });
      cacheOverride.file = fileWith([], "m-gone");
      expect(resolveAll()).toEqual({ kind: "none" });
    });

    it("the endpoint checks apply to the sole local model exactly as to a default", async () => {
      await persistModelsFile(fileWith([{ ...local, endpoint: undefined }], null));
      const missing = unusableNow();
      expect(missing.reason).toBe("no-endpoint");
      expect(missing.detail).toContain("m-local");

      await persistModelsFile(fileWith([{ ...local, endpoint: REJECTED.NON_LOOPBACK_HOST }], null));
      const rejected = unusableNow();
      expect(rejected.reason).toBe("endpoint-rejected");
      expect(rejected.detail).toContain("NON_LOOPBACK_HOST");

      // And it is the SAME state as that entry marked default: one notice, not
      // a second one when the user then marks it.
      await persistModelsFile(
        fileWith([{ ...local, endpoint: REJECTED.NON_LOOPBACK_HOST }], "m-local"),
      );
      expect(unusableNow()).toEqual(rejected);
    });
  });

  describe("unusable — no-default-chosen", () => {
    it("null default with two enabled local models", async () => {
      await persistModelsFile(fileWith([local, local2], null));
      const r = unusableNow();
      expect(r.reason).toBe("no-default-chosen");
      expect(r.detail).not.toContain("m-local"); // names neither candidate
    });

    it("null default with three, among cloud and disabled ones", async () => {
      const local3: ModelsEntry = { ...local, id: "m-local-3" };
      await persistModelsFile(fileWith([cloud, local, disabledLocal, local2, local3], null));
      expect(unusableNow().reason).toBe("no-default-chosen");
    });

    it("is not rescued by the endpoints: two locals with unusable endpoints is still 'choose a default'", async () => {
      await persistModelsFile(
        fileWith(
          [
            { ...local, endpoint: undefined },
            { ...local2, endpoint: REJECTED.NON_LOOPBACK_HOST },
          ],
          null,
        ),
      );
      expect(unusableNow().reason).toBe("no-default-chosen");
    });

    it("disabling one of two leaves a sole local model, which answers", async () => {
      await persistModelsFile(fileWith([local, local2], null));
      expect(unusableNow().reason).toBe("no-default-chosen");
      await persistModelsFile(fileWith([{ ...local, enabled: false }, local2], null));
      expect(okNow().entryId).toBe("m-local-2");
    });
  });

  // The whole rule as one table. Each cell is written out by hand rather than
  // computed, so the table cannot agree with the resolver by sharing its logic.
  describe("the full table — default × enabled local models × endpoint (round 2)", () => {
    type DefaultKind = "null" | "dangling" | "enabled-local" | "disabled" | "cloud";
    type EndpointKind = "good" | "rejected" | "missing";
    type Count = 0 | 1 | 2 | 3;
    /** "none", "ok:<entry id>", "unusable:<reason>", or "n/a" (cannot exist). */
    type Cell = string;

    const NONE: Record<EndpointKind, Cell> = { good: "none", rejected: "none", missing: "none" };
    const CHOOSE: Record<EndpointKind, Cell> = {
      good: "unusable:no-default-chosen",
      rejected: "unusable:no-default-chosen",
      missing: "unusable:no-default-chosen",
    };
    const N_A: Record<EndpointKind, Cell> = { good: "n/a", rejected: "n/a", missing: "n/a" };
    /** The entry `id` is the candidate, so its endpoint decides. */
    const candidate = (id: string): Record<EndpointKind, Cell> => ({
      good: `ok:${id}`,
      rejected: "unusable:endpoint-rejected",
      missing: "unusable:no-endpoint",
    });

    const TABLE: Record<DefaultKind, Record<Count, Record<EndpointKind, Cell>>> = {
      null: { 0: NONE, 1: candidate("m-1"), 2: CHOOSE, 3: CHOOSE },
      dangling: { 0: NONE, 1: candidate("m-1"), 2: CHOOSE, 3: CHOOSE },
      // The default is itself an enabled local model, so "0" cannot exist.
      "enabled-local": {
        0: N_A,
        1: candidate("m-default"),
        2: candidate("m-default"),
        3: candidate("m-default"),
      },
      // A set default that is disabled or cloud is "Claude is my collaborator":
      // never overridden by a spare local model, whatever else is saved.
      disabled: { 0: NONE, 1: NONE, 2: NONE, 3: NONE },
      cloud: { 0: NONE, 1: NONE, 2: NONE, 3: NONE },
    };

    const ENDPOINTS: Record<EndpointKind, string | undefined> = {
      good: "http://127.0.0.1:11434",
      rejected: "http://10.0.0.5:11434",
      missing: undefined,
    };

    /**
     * `count` enabled local models in total. `endpoint` is given to the model
     * that would be the candidate; with a set enabled-local default the OTHER
     * locals keep a good endpoint, so a rescue by a spare model would show.
     */
    function build(kind: DefaultKind, count: Count, endpoint: EndpointKind): ModelsFile {
      const ep = ENDPOINTS[endpoint];
      const models: ModelsEntry[] = [cloud];
      let defaultModelId: string | null = null;
      let spare = count;
      if (kind === "enabled-local") {
        spare = (count - 1) as Count;
      }
      for (let i = 1; i <= spare; i++) {
        models.push({
          ...local,
          id: `m-${i}`,
          endpoint: kind === "enabled-local" ? ENDPOINTS.good : ep,
        });
      }
      if (kind === "enabled-local") {
        // Last, so it is found by id and not by position.
        models.push({ ...local, id: "m-default", endpoint: ep });
        defaultModelId = "m-default";
      } else if (kind === "disabled") {
        models.push({ ...local, id: "m-default", enabled: false, endpoint: ep });
        defaultModelId = "m-default";
      } else if (kind === "cloud") {
        defaultModelId = "m-cloud";
      } else if (kind === "dangling") {
        defaultModelId = "m-gone";
      }
      return fileWith(models, defaultModelId);
    }

    function describeResolution(r: LocalModelResolution): Cell {
      if (r.kind === "ok") return `ok:${r.entryId}`;
      if (r.kind === "unusable") return `unusable:${r.reason}`;
      return "none";
    }

    const rows: [DefaultKind, Count, EndpointKind, Cell][] = [];
    for (const kind of Object.keys(TABLE) as DefaultKind[]) {
      for (const count of [0, 1, 2, 3] as const) {
        for (const endpoint of ["good", "rejected", "missing"] as const) {
          const cell = TABLE[kind][count][endpoint];
          if (cell !== "n/a") rows.push([kind, count, endpoint, cell]);
        }
      }
    }

    it("covers every cell that can exist", () => {
      // 5 defaults × 4 counts × 3 endpoints, less the 3 impossible cells.
      expect(rows).toHaveLength(57);
    });

    it.each(rows)(
      "default %s, %i enabled local(s), endpoint %s → %s",
      async (kind, count, endpoint, cell) => {
        const file = build(kind, count, endpoint);
        // The fixture is what the row says it is.
        expect(file.models.filter((m) => m.enabled && m.provider === "local-ollama")).toHaveLength(
          count,
        );
        if (kind === "dangling") {
          // The store clears a dangling default; only the seam can hold one.
          cacheOverride.file = file;
          expect(file.models.some((m) => m.id === file.defaultModelId)).toBe(false);
        } else {
          await persistModelsFile(file);
          expect(getCachedModelsFile().defaultModelId).toBe(file.defaultModelId);
        }

        const r = resolveAll();
        expect(describeResolution(r)).toBe(cell);
        if (r.kind === "ok") {
          expect(r.config.endpoint).toBe(ENDPOINTS.good);
          expect(validateEndpoint(r.config.endpoint).ok).toBe(true);
        }
      },
    );
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
      expect(resolveAll()).toEqual({ kind: "ok", entryId: "m-local", config: OK_CONFIG });
    });

    it("entryId is the entry that answers, not the first one saved", async () => {
      await persistModelsFile(fileWith([local, local2], "m-local-2"));
      expect(okNow().entryId).toBe("m-local-2");
      await persistModelsFile(fileWith([local, local2], "m-local"));
      expect(okNow().entryId).toBe("m-local");
    });

    it("is re-read on every call: a later write is seen with no restart", async () => {
      // Two locals, because one with no default is no longer unusable (round 2).
      await persistModelsFile(fileWith([local, local2], null));
      expect(resolveAll().kind).toBe("unusable");
      await persistModelsFile(fileWith([local, local2], "m-local"));
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
      await persistModelsFile(fileWith([local, local2], null));
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

    it("stateKey for no-default-chosen does NOT change when another local model is added or swapped", async () => {
      // Starts at two: one local with no default now answers (round 2).
      const local3: ModelsEntry = { ...local, id: "m-local-3" };
      await persistModelsFile(fileWith([local, local2], null));
      const two = unusableNow();
      await persistModelsFile(fileWith([local, local2, local3], null));
      const three = unusableNow();
      await persistModelsFile(fileWith([local2, local3], null));
      const otherTwo = unusableNow();
      expect(three.stateKey).toBe(two.stateKey);
      expect(otherTwo.stateKey).toBe(two.stateKey);
      expect(three.detail).toBe(two.detail);
      expect(two.stateKey).toMatch(/^[0-9a-f]{64}$/);
    });

    it("neither stateKey nor detail carries the endpoint, its user name or its password", async () => {
      const endpoint = "http://alice:s3cretpw@evil.example:11434/v1";
      const rejectedBy: string[] = [];
      // Marked default, and (round 2) the sole local model with no default: the
      // second route reaches the same endpoint check by a different branch.
      for (const defaultModelId of ["m-local", null]) {
        for (const candidate of [endpoint, REJECTED.HAS_CREDENTIALS]) {
          await persistModelsFile(fileWith([{ ...local, endpoint: candidate }], defaultModelId));
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
      }
      expect(rejectedBy).toHaveLength(4);
      expect(rejectedBy.every((d) => d.includes("HAS_CREDENTIALS"))).toBe(true);
    });

    it("no unusable state's stateKey or detail carries a GOOD endpoint either", async () => {
      // no-default-chosen is reached with usable endpoints on file.
      await persistModelsFile(
        fileWith([{ ...local, endpoint: "http://127.0.0.1:23456" }, local2], null),
      );
      const r = unusableNow();
      for (const text of [r.stateKey, r.detail]) {
        expect(text).not.toContain("127.0.0.1");
        expect(text).not.toContain("23456");
        expect(text).not.toContain("11434");
      }
    });

    it("resolving logs nothing on any ordinary path", async () => {
      const spy = vi.mocked(console.error);
      const states: ModelsFile[] = [
        fileWith([], null),
        fileWith([local], null),
        fileWith([local, local2], null),
        fileWith([cloud, local], null),
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

  describe("answeringLocalModel (round 2)", () => {
    it("names the entry, where it points and what it is called", async () => {
      await persistModelsFile(
        fileWith(
          [cloud, { ...local, displayName: "Qwen 2.5 (14B)", endpoint: "http://localhost:8080" }],
          "m-local",
        ),
      );
      expect(answeringLocalModel()).toEqual({
        entryId: "m-local",
        endpoint: "http://localhost:8080",
        modelId: "qwen2.5:14b-instruct",
        displayName: "Qwen 2.5 (14B)",
      });
      resolveAll();
    });

    it("is the sole enabled local model when no default is set", async () => {
      await persistModelsFile(fileWith([cloud, disabledLocal, local2], null));
      expect(answeringLocalModel()).toEqual({
        entryId: "m-local-2",
        endpoint: "http://127.0.0.1:11434",
        modelId: "qwen2.5:14b-instruct",
        displayName: "Second local",
      });
    });

    it("clamps the display name to the durable bound, like the byline", async () => {
      await persistModelsFile(fileWith([{ ...local, displayName: "N".repeat(300) }], "m-local"));
      const answering = answeringLocalModel();
      expect(answering?.displayName).toBe("N".repeat(120));
      expect(answering?.displayName).toBe(resolveLocalModelConfig()?.agentIdentity.displayName);
    });

    it("is null whenever no local model would answer", async () => {
      const states: ModelsFile[] = [
        fileWith([], null),
        fileWith([cloud], null),
        fileWith([cloud, local], "m-cloud"),
        fileWith([disabledLocal, local], "m-off"),
        fileWith([local, local2], null),
        fileWith([{ ...local, endpoint: undefined }], "m-local"),
        fileWith([{ ...local, endpoint: undefined }], null),
        fileWith([{ ...local, endpoint: REJECTED.HAS_CREDENTIALS }], "m-local"),
        fileWith([{ ...local, endpoint: REJECTED.NON_LOOPBACK_HOST }], null),
      ];
      for (const state of states) {
        await persistModelsFile(state);
        expect(answeringLocalModel(), JSON.stringify(state)).toBeNull();
        expect(resolveAll().kind).not.toBe("ok");
      }
    });

    it("follows a registry write with no restart", async () => {
      await persistModelsFile(fileWith([local, local2], "m-local"));
      expect(answeringLocalModel()?.entryId).toBe("m-local");
      await persistModelsFile(fileWith([local, local2], "m-local-2"));
      expect(answeringLocalModel()?.entryId).toBe("m-local-2");
      await persistModelsFile(fileWith([local, { ...local2, modelId: "other:7b" }], "m-local-2"));
      expect(answeringLocalModel()?.modelId).toBe("other:7b");
      await persistModelsFile(fileWith([local, local2], null));
      expect(answeringLocalModel()).toBeNull();
    });
  });
});
