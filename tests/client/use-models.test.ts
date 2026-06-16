// @vitest-environment happy-dom

/**
 * Unit tests for `createModels` (#659).
 *
 * Pinned invariants:
 *   1. Every mutation produces a NEW `models` array reference (immutable
 *      update; required for Svelte 5 `$state` identity reactivity).
 *   2. CRUD lifecycle (add → update → toggle → delete) round-trips through
 *      `TandemSettings.models` and persists to localStorage.
 *   3. `add` resolves with the generated id; subsequent `update` finds it.
 *   4. Read-only settings short-circuit every mutation.
 *   5. Invalid provider in a patch rejects with a hygienic Error (no
 *      key/endpoint values in the message — covered separately in
 *      `use-models-no-key-leak.test.ts`).
 *   6. Plaintext API keys are POSTed to the keychain endpoint and replaced
 *      with the opaque `apiKeyRef` on the persisted entry.
 *   7. `defaultModelId` lifecycle: `setDefault` writes through;
 *      `deleteModel` clears it when the deleted id matches.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createModels } from "../../src/client/hooks/useModels.svelte.js";
import type {
  ModelRegistryEntry,
  TandemSettings,
  TandemSettingsState,
} from "../../src/client/hooks/useTandemSettings.svelte.js";

function makeStubState(initialModels: ModelRegistryEntry[] = []): {
  state: TandemSettingsState;
  reads: () => ModelRegistryEntry[];
  readsDefault: () => string | null;
  setReadOnly: (v: boolean) => void;
} {
  let inner: TandemSettings = {
    leftPanelVisible: false,
    rightPanelVisible: true,
    schemaVersion: 7,
    primaryTab: "annotations",
    panelOrder: "chat-editor-annotations",
    editorMeasure: "comfortable",
    selectionDwellMs: 1000,
    showAuthorship: true,
    reduceMotion: false,
    textSize: "m",
    theme: "system",
    accentHue: 275,
    editorFont: "serif",
    density: "cozy",
    defaultMode: "tandem",
    highContrast: false,
    annotationPatterns: false,
    selectionToolbar: true,
    soloRailHidden: true,
    degradedBannerDelayMs: 30000,
    sidecarRetryStrategy: "exponential",
    marginView: false,
    models: initialModels,
    defaultModelId: null,
  };
  const state: TandemSettingsState = {
    get settings() {
      return inner;
    },
    updateSettings(partial) {
      if (inner._readOnly) return;
      inner = { ...inner, ...partial };
    },
  };
  return {
    state,
    reads: () => inner.models,
    readsDefault: () => inner.defaultModelId,
    setReadOnly: (v) => {
      inner = { ...inner, _readOnly: v };
    },
  };
}

beforeEach(() => {
  // Default stub: 204 No Content for keychain stores. Individual tests can
  // override to exercise the error branches.
  vi.stubGlobal(
    "fetch",
    vi.fn(async (_url: string, init?: { method?: string }) => {
      const method = (init?.method ?? "GET").toUpperCase();
      return new Response(method === "DELETE" ? '{"existed":true}' : null, {
        status: method === "DELETE" ? 200 : 204,
      });
    }),
  );
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("createModels — CRUD", () => {
  it("addModel resolves with a generated id and appends with provided fields", async () => {
    const harness = makeStubState();
    const models = createModels(harness.state);

    const id = await models.addModel(
      {
        provider: "anthropic",
        displayName: "Opus",
        modelId: "claude-opus-4-7",
        enabled: true,
      },
      "sk-test-DO-NOT-USE-anthropic",
    );

    expect(typeof id).toBe("string");
    expect(id.length).toBeGreaterThan(0);
    const persisted = harness.reads();
    expect(persisted.length).toBe(1);
    expect(persisted[0]).toMatchObject({
      id,
      provider: "anthropic",
      displayName: "Opus",
      modelId: "claude-opus-4-7",
      enabled: true,
    });
    // Plaintext NEVER appears on the persisted entry; only the opaque ref does.
    expect(persisted[0].apiKeyRef).toBeDefined();
    expect(typeof persisted[0].apiKeyRef).toBe("string");
    expect(persisted[0].apiKeyRef!.length).toBeGreaterThan(0);
    // @ts-expect-error — `apiKey` field is gone from the type but assert at runtime too.
    expect(persisted[0].apiKey).toBeUndefined();
  });

  it("every mutation produces a fresh models-array reference (immutable update)", async () => {
    const harness = makeStubState();
    const models = createModels(harness.state);

    const before = harness.reads();
    const id = await models.addModel(
      {
        provider: "openai",
        displayName: "GPT-4o",
        modelId: "gpt-4o",
        enabled: true,
      },
      "sk-test-DO-NOT-USE-openai",
    );
    const afterAdd = harness.reads();
    expect(afterAdd).not.toBe(before);

    await models.updateModel(id, { displayName: "GPT-4o Renamed" });
    const afterUpdate = harness.reads();
    expect(afterUpdate).not.toBe(afterAdd);

    models.toggleEnabled(id);
    const afterToggle = harness.reads();
    expect(afterToggle).not.toBe(afterUpdate);

    await models.deleteModel(id);
    const afterDelete = harness.reads();
    expect(afterDelete).not.toBe(afterToggle);
  });

  it("updateModel only patches the targeted entry and preserves order", async () => {
    const harness = makeStubState();
    const models = createModels(harness.state);
    const idA = await models.addModel({
      provider: "anthropic",
      displayName: "A",
      modelId: "claude-opus-4-7",
      enabled: true,
    });
    const idB = await models.addModel({
      provider: "openai",
      displayName: "B",
      modelId: "gpt-4o",
      enabled: false,
    });

    await models.updateModel(idA, { displayName: "Patched A" });
    const list = harness.reads();
    expect(list.length).toBe(2);
    expect(list[0].id).toBe(idA);
    expect(list[0].displayName).toBe("Patched A");
    expect(list[1].id).toBe(idB);
    expect(list[1].displayName).toBe("B");
  });

  it("updateModel with a fresh plaintext key replaces the existing ref", async () => {
    const harness = makeStubState();
    const models = createModels(harness.state);
    const id = await models.addModel(
      {
        provider: "anthropic",
        displayName: "A",
        modelId: "claude-opus-4-7",
        enabled: true,
      },
      "first-secret",
    );
    const refBefore = harness.reads()[0].apiKeyRef;
    expect(refBefore).toBeDefined();

    await models.updateModel(id, {}, "second-secret");
    const refAfter = harness.reads()[0].apiKeyRef;
    expect(refAfter).toBeDefined();
    expect(refAfter).not.toBe(refBefore);
  });

  it("toggleEnabled flips the boolean for the targeted entry only", async () => {
    const harness = makeStubState();
    const models = createModels(harness.state);
    const idA = await models.addModel({
      provider: "anthropic",
      displayName: "A",
      modelId: "claude-opus-4-7",
      enabled: true,
    });
    const idB = await models.addModel({
      provider: "openai",
      displayName: "B",
      modelId: "gpt-4o",
      enabled: false,
    });

    models.toggleEnabled(idA);
    let list = harness.reads();
    expect(list.find((m) => m.id === idA)?.enabled).toBe(false);
    expect(list.find((m) => m.id === idB)?.enabled).toBe(false);

    models.toggleEnabled(idB);
    list = harness.reads();
    expect(list.find((m) => m.id === idB)?.enabled).toBe(true);
  });

  it("deleteModel removes the targeted entry and clears defaultModelId when matched", async () => {
    const harness = makeStubState();
    const models = createModels(harness.state);
    const idA = await models.addModel({
      provider: "anthropic",
      displayName: "A",
      modelId: "claude-opus-4-7",
      enabled: true,
    });
    const idB = await models.addModel({
      provider: "openai",
      displayName: "B",
      modelId: "gpt-4o",
      enabled: true,
    });
    models.setDefault(idA);
    expect(harness.readsDefault()).toBe(idA);

    await models.deleteModel(idA);
    expect(harness.reads().length).toBe(1);
    expect(harness.reads()[0].id).toBe(idB);
    // Default was cleared because the deleted id matched.
    expect(harness.readsDefault()).toBeNull();

    // Deleting an unrelated entry does NOT clear an unrelated default.
    models.setDefault(idB);
    await models.deleteModel("unknown-id");
    expect(harness.readsDefault()).toBe(idB);
  });

  it("update/toggle/delete on an unknown id is a no-op (no exception)", async () => {
    const harness = makeStubState();
    const models = createModels(harness.state);
    await models.addModel({
      provider: "anthropic",
      displayName: "A",
      modelId: "claude-opus-4-7",
      enabled: true,
    });

    await expect(models.updateModel("nonexistent", { displayName: "X" })).resolves.toBeUndefined();
    expect(() => models.toggleEnabled("nonexistent")).not.toThrow();
    await expect(models.deleteModel("nonexistent")).resolves.toBeUndefined();
    expect(harness.reads().length).toBe(1);
  });

  it("rejects invalid provider in addModel and updateModel", async () => {
    const harness = makeStubState();
    const models = createModels(harness.state);

    await expect(
      models.addModel({
        // @ts-expect-error — exercising the runtime guard against caller bugs.
        provider: "fake-provider",
        displayName: "X",
        modelId: "x",
        enabled: true,
      }),
    ).rejects.toThrow();

    const id = await models.addModel({
      provider: "anthropic",
      displayName: "A",
      modelId: "claude-opus-4-7",
      enabled: true,
    });
    await expect(
      models.updateModel(id, {
        // @ts-expect-error — exercising the runtime guard.
        provider: "fake-provider",
      }),
    ).rejects.toThrow();
  });

  it("read-only settings short-circuit every mutation", async () => {
    const harness = makeStubState([
      {
        id: "pre-existing",
        provider: "anthropic",
        displayName: "Pre",
        modelId: "claude-opus-4-7",
        enabled: true,
      },
    ]);
    harness.setReadOnly(true);
    const models = createModels(harness.state);

    await models.addModel({
      provider: "openai",
      displayName: "Should not land",
      modelId: "gpt-4o",
      enabled: true,
    });
    await models.updateModel("pre-existing", { displayName: "Should not change" });
    models.toggleEnabled("pre-existing");
    await models.deleteModel("pre-existing");

    const list = harness.reads();
    expect(list.length).toBe(1);
    expect(list[0].displayName).toBe("Pre");
    expect(list[0].enabled).toBe(true);
  });
});

describe("createModels — defaults", () => {
  it("setDefault writes through to settings.defaultModelId", async () => {
    const harness = makeStubState();
    const models = createModels(harness.state);
    const id = await models.addModel({
      provider: "anthropic",
      displayName: "A",
      modelId: "claude-opus-4-7",
      enabled: true,
    });

    expect(models.defaultModelId).toBeNull();
    models.setDefault(id);
    expect(harness.readsDefault()).toBe(id);
    expect(models.defaultModelId).toBe(id);

    models.setDefault(null);
    expect(harness.readsDefault()).toBeNull();
  });
});

describe("createModels — legacy key migration", () => {
  it("migrateLegacyKeys stores plaintext via fetch and rewrites entry with apiKeyRef", async () => {
    const harness = makeStubState([
      {
        id: "legacy-1",
        provider: "anthropic",
        displayName: "Legacy",
        modelId: "claude-opus-4-7",
        enabled: true,
        _legacyApiKey: "legacy-plaintext-1",
      },
      {
        id: "legacy-2",
        provider: "openai",
        displayName: "Legacy 2",
        modelId: "gpt-4o",
        enabled: true,
        _legacyApiKey: "legacy-plaintext-2",
      },
    ]);
    const models = createModels(harness.state);
    expect(models.hasLegacyKeys).toBe(true);

    const result = await models.migrateLegacyKeys();
    expect(result).toEqual({ migrated: 2, failed: 0 });
    const list = harness.reads();
    expect(list[0]._legacyApiKey).toBeUndefined();
    expect(list[1]._legacyApiKey).toBeUndefined();
    expect(list[0].apiKeyRef).toBeDefined();
    expect(list[1].apiKeyRef).toBeDefined();
  });

  it("migrateLegacyKeys is a no-op when no legacy entries exist", async () => {
    const harness = makeStubState();
    const models = createModels(harness.state);
    const result = await models.migrateLegacyKeys();
    expect(result).toEqual({ migrated: 0, failed: 0 });
  });
});
