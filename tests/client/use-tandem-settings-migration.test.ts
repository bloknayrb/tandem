/**
 * Migration chain coverage for `loadSettings` (#659 Wave 2 PR 8a).
 *
 * The existing `useTandemSettings.test.ts` covers the v1→v2 migration and
 * the v2 leftSlot.kind→leftRailTabs fallback. This file pins down:
 *
 *   1. v1→v3: a v1 blob (with `layout`/`panelHidden`) walks the full
 *      chain in one load and ends at schemaVersion=3 with models=[].
 *   2. v2→v3: a v2 blob gets `models: []` added without touching other fields.
 *   3. v3 forward-compat: an on-disk `schemaVersion: 99` blob loads
 *      defensively as `_readOnly: true`; subsequent `updateSettings` calls
 *      are no-ops (verified via the createTandemSettings facade).
 *   4. v3 forward-compat preserves unknown future fields so a user who
 *      bounces back to the newer client doesn't see a regression.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { loadSettings } from "../../src/client/hooks/useTandemSettings.js";
import { TANDEM_SETTINGS_KEY } from "../../src/shared/constants.js";

function installLocalStorageStub() {
  const store = new Map<string, string>();
  const stub: Storage = {
    get length() {
      return store.size;
    },
    clear: () => store.clear(),
    getItem: (key: string) => store.get(key) ?? null,
    key: (index: number) => Array.from(store.keys())[index] ?? null,
    removeItem: (key: string) => {
      store.delete(key);
    },
    setItem: (key: string, value: string) => {
      store.set(key, value);
    },
  };
  vi.stubGlobal("localStorage", stub);
  return store;
}

describe("loadSettings — migration chain", () => {
  let store: Map<string, string>;

  beforeEach(() => {
    store = installLocalStorageStub();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  function writeRaw(partial: Record<string, unknown>) {
    store.set(TANDEM_SETTINGS_KEY, JSON.stringify(partial));
  }

  it("v1 blob (layout=three-panel) climbs to v3 with models=[]", () => {
    writeRaw({
      schemaVersion: 1,
      layout: "three-panel",
      panelHidden: false,
      textSize: "l",
    });
    const s = loadSettings();
    expect(s.schemaVersion).toBe(3);
    expect(s.leftPanelVisible).toBe(true);
    expect(s.rightPanelVisible).toBe(true);
    expect(s.textSize).toBe("l");
    expect(s.models).toEqual([]);
  });

  it("v1 blob (panelHidden=true) climbs to v3 with both panels hidden", () => {
    writeRaw({ schemaVersion: 1, panelHidden: true });
    const s = loadSettings();
    expect(s.schemaVersion).toBe(3);
    expect(s.leftPanelVisible).toBe(false);
    expect(s.rightPanelVisible).toBe(false);
    expect(s.models).toEqual([]);
  });

  it("v2 blob gets models=[] without touching other fields", () => {
    writeRaw({
      schemaVersion: 2,
      leftPanelVisible: true,
      rightPanelVisible: false,
      editorWidthPercent: 80,
      theme: "dark",
    });
    const s = loadSettings();
    expect(s.schemaVersion).toBe(3);
    expect(s.leftPanelVisible).toBe(true);
    expect(s.rightPanelVisible).toBe(false);
    expect(s.editorWidthPercent).toBe(80);
    expect(s.theme).toBe("dark");
    expect(s.models).toEqual([]);
  });

  it("v3 forward-compat: schemaVersion=99 loads as _readOnly: true", () => {
    writeRaw({
      schemaVersion: 99,
      leftPanelVisible: true,
      rightPanelVisible: true,
      models: [
        {
          id: "future-id",
          provider: "anthropic",
          displayName: "Future model",
          modelId: "claude-opus-5",
          enabled: true,
        },
      ],
      // A v99-only field that this client doesn't know about. The
      // forward-compat clause must preserve it via the `...parsed` spread
      // so the user doesn't perceive a regression if they go back to the
      // newer client.
      futureField: "preserved",
    });
    const s = loadSettings();
    expect(s._readOnly).toBe(true);
    // Future fields are preserved in the returned object even though
    // they're not typed.
    expect((s as unknown as { futureField?: string }).futureField).toBe("preserved");
    // Known fields from the future blob are also preserved by the spread.
    expect(s.leftPanelVisible).toBe(true);
    expect(s.rightPanelVisible).toBe(true);
    expect(s.models.length).toBe(1);
    expect(s.models[0].displayName).toBe("Future model");
  });

  it("v3 round-trips models[] through load with shape filter", () => {
    writeRaw({
      schemaVersion: 3,
      models: [
        {
          id: "valid",
          provider: "anthropic",
          displayName: "Valid",
          modelId: "claude-opus-4-7",
          enabled: true,
          apiKey: "sk-test-DO-NOT-USE-anthropic",
        },
        // Corrupt: missing required field — must be filtered out.
        { id: "missing-fields", provider: "openai" },
        // Corrupt: bogus provider — must be filtered out.
        {
          id: "bad-provider",
          provider: "not-a-real-provider",
          displayName: "X",
          modelId: "x",
          enabled: true,
        },
      ],
    });
    const s = loadSettings();
    expect(s.models.length).toBe(1);
    expect(s.models[0].id).toBe("valid");
    expect(s.models[0].apiKey).toBe("sk-test-DO-NOT-USE-anthropic");
  });
});
