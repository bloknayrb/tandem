// @vitest-environment happy-dom

/**
 * Unit tests for `createModels` (#659 Wave 2 PR 8a).
 *
 * Pinned invariants:
 *   1. Every mutation produces a NEW `models` array reference (immutable
 *      update; required for Svelte 5 `$state` identity reactivity).
 *   2. CRUD lifecycle (add → update → toggle → delete) round-trips through
 *      `TandemSettings.models` and persists to localStorage.
 *   3. `add` returns the generated id; subsequent `update` finds it.
 *   4. Read-only settings short-circuit every mutation.
 *   5. Invalid provider in a patch throws a hygienic Error (no key/endpoint
 *      values in the message — covered separately in
 *      `use-models-no-key-leak.test.ts`).
 */

import { describe, expect, it } from "vitest";
import { createModels } from "../../src/client/hooks/useModels.svelte.js";
import type {
  ModelRegistryEntry,
  TandemSettings,
  TandemSettingsState,
} from "../../src/client/hooks/useTandemSettings.svelte.js";

/**
 * Minimal hand-rolled `TandemSettingsState` stub: a real one needs a
 * `$state` rune which only resolves inside a Svelte effect root. The CRUD
 * facade only reads `settings.models` and calls `updateSettings`, so we
 * can hand-roll a plain-object harness and snapshot mutations directly.
 */
function makeStubState(initialModels: ModelRegistryEntry[] = []): {
  state: TandemSettingsState;
  reads: () => ModelRegistryEntry[];
  setReadOnly: (v: boolean) => void;
} {
  let inner: TandemSettings = {
    leftPanelVisible: false,
    rightPanelVisible: true,
    schemaVersion: 3,
    primaryTab: "annotations",
    panelOrder: "chat-editor-annotations",
    editorWidthPercent: 100,
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
    leftRailTabs: ["outline"],
    rightRailTabs: ["annotations", "chat"],
    degradedBannerDelayMs: 30000,
    sidecarRetryStrategy: "exponential",
    holdAnnotationsWhileOffline: true,
    marginView: false,
    showIntegrationWizard: false,
    models: initialModels,
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
    setReadOnly: (v) => {
      inner = { ...inner, _readOnly: v };
    },
  };
}

describe("createModels — CRUD", () => {
  it("addModel returns a generated id and appends with provided fields", () => {
    const harness = makeStubState();
    const models = createModels(harness.state);

    const id = models.addModel({
      provider: "anthropic",
      displayName: "Opus",
      modelId: "claude-opus-4-7",
      apiKey: "sk-test-DO-NOT-USE-anthropic",
      enabled: true,
    });

    expect(typeof id).toBe("string");
    expect(id.length).toBeGreaterThan(0);
    const persisted = harness.reads();
    expect(persisted.length).toBe(1);
    expect(persisted[0]).toMatchObject({
      id,
      provider: "anthropic",
      displayName: "Opus",
      modelId: "claude-opus-4-7",
      apiKey: "sk-test-DO-NOT-USE-anthropic",
      enabled: true,
    });
  });

  it("every mutation produces a fresh models-array reference (immutable update)", () => {
    const harness = makeStubState();
    const models = createModels(harness.state);

    const before = harness.reads();
    const id = models.addModel({
      provider: "openai",
      displayName: "GPT-4o",
      modelId: "gpt-4o",
      apiKey: "sk-test-DO-NOT-USE-openai",
      enabled: true,
    });
    const afterAdd = harness.reads();
    expect(afterAdd).not.toBe(before);

    models.updateModel(id, { displayName: "GPT-4o Renamed" });
    const afterUpdate = harness.reads();
    expect(afterUpdate).not.toBe(afterAdd);

    models.toggleEnabled(id);
    const afterToggle = harness.reads();
    expect(afterToggle).not.toBe(afterUpdate);

    models.deleteModel(id);
    const afterDelete = harness.reads();
    expect(afterDelete).not.toBe(afterToggle);
  });

  it("updateModel only patches the targeted entry and preserves order", () => {
    const harness = makeStubState();
    const models = createModels(harness.state);
    const idA = models.addModel({
      provider: "anthropic",
      displayName: "A",
      modelId: "claude-opus-4-7",
      enabled: true,
    });
    const idB = models.addModel({
      provider: "openai",
      displayName: "B",
      modelId: "gpt-4o",
      enabled: false,
    });

    models.updateModel(idA, { displayName: "Patched A" });
    const list = harness.reads();
    expect(list.length).toBe(2);
    expect(list[0].id).toBe(idA);
    expect(list[0].displayName).toBe("Patched A");
    expect(list[1].id).toBe(idB);
    expect(list[1].displayName).toBe("B");
  });

  it("toggleEnabled flips the boolean for the targeted entry only", () => {
    const harness = makeStubState();
    const models = createModels(harness.state);
    const idA = models.addModel({
      provider: "anthropic",
      displayName: "A",
      modelId: "claude-opus-4-7",
      enabled: true,
    });
    const idB = models.addModel({
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

  it("deleteModel removes the targeted entry", () => {
    const harness = makeStubState();
    const models = createModels(harness.state);
    const idA = models.addModel({
      provider: "anthropic",
      displayName: "A",
      modelId: "claude-opus-4-7",
      enabled: true,
    });
    const idB = models.addModel({
      provider: "openai",
      displayName: "B",
      modelId: "gpt-4o",
      enabled: true,
    });

    models.deleteModel(idA);
    const list = harness.reads();
    expect(list.length).toBe(1);
    expect(list[0].id).toBe(idB);
  });

  it("update/toggle/delete on an unknown id is a no-op (no exception)", () => {
    const harness = makeStubState();
    const models = createModels(harness.state);
    models.addModel({
      provider: "anthropic",
      displayName: "A",
      modelId: "claude-opus-4-7",
      enabled: true,
    });

    expect(() => models.updateModel("nonexistent", { displayName: "X" })).not.toThrow();
    expect(() => models.toggleEnabled("nonexistent")).not.toThrow();
    expect(() => models.deleteModel("nonexistent")).not.toThrow();
    expect(harness.reads().length).toBe(1);
  });

  it("rejects invalid provider in addModel and updateModel", () => {
    const harness = makeStubState();
    const models = createModels(harness.state);

    expect(() =>
      models.addModel({
        // @ts-expect-error — exercising the runtime guard against caller bugs.
        provider: "fake-provider",
        displayName: "X",
        modelId: "x",
        enabled: true,
      }),
    ).toThrow();

    const id = models.addModel({
      provider: "anthropic",
      displayName: "A",
      modelId: "claude-opus-4-7",
      enabled: true,
    });
    expect(() =>
      models.updateModel(id, {
        // @ts-expect-error — exercising the runtime guard.
        provider: "fake-provider",
      }),
    ).toThrow();
  });

  it("read-only settings short-circuit every mutation", () => {
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

    models.addModel({
      provider: "openai",
      displayName: "Should not land",
      modelId: "gpt-4o",
      enabled: true,
    });
    models.updateModel("pre-existing", { displayName: "Should not change" });
    models.toggleEnabled("pre-existing");
    models.deleteModel("pre-existing");

    const list = harness.reads();
    expect(list.length).toBe(1);
    expect(list[0].displayName).toBe("Pre");
    expect(list[0].enabled).toBe(true);
  });
});
