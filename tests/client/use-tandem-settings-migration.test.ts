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

  it("v1 blob (layout=three-panel) climbs to v6 with models=[] and rail-tab fields stripped", () => {
    writeRaw({
      schemaVersion: 1,
      layout: "three-panel",
      panelHidden: false,
      textSize: "l",
    });
    const s = loadSettings();
    expect(s.schemaVersion).toBe(7);
    expect(s.leftPanelVisible).toBe(true);
    expect(s.rightPanelVisible).toBe(true);
    expect(s.textSize).toBe("l");
    expect(s.models).toEqual([]);
  });

  it("v1 blob (panelHidden=true) climbs to v6 with both panels hidden", () => {
    writeRaw({ schemaVersion: 1, panelHidden: true });
    const s = loadSettings();
    expect(s.schemaVersion).toBe(7);
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
    expect(s.schemaVersion).toBe(7);
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

  // Forward-compat sanitization (#735 review finding).
  //
  // Prior implementation spread `...(parsed as Partial<TandemSettings>)`
  // over DEFAULTS, bypassing every clamp. A future-blob with
  // `editorWidthPercent: -999` propagated raw garbage to the running UI.
  // The fix routes both paths through `normalizeKnownFields`.
  it("forward-compat clamps editorWidthPercent=-999 to 40", () => {
    writeRaw({ schemaVersion: 99, editorWidthPercent: -999 });
    const s = loadSettings();
    expect(s._readOnly).toBe(true);
    expect(s.editorWidthPercent).toBe(40);
  });

  it("forward-compat clamps accentHue=9999 to default", () => {
    writeRaw({ schemaVersion: 99, accentHue: 9999 });
    const s = loadSettings();
    expect(s._readOnly).toBe(true);
    expect(s.accentHue).toBe(275); // DEFAULTS.accentHue
  });

  it("forward-compat rejects invalid theme enum", () => {
    writeRaw({ schemaVersion: 99, theme: "neon" });
    const s = loadSettings();
    expect(s._readOnly).toBe(true);
    expect(s.theme).toBe("system"); // DEFAULTS.theme
  });

  it("forward-compat clamps selectionDwellMs=-50 to floor", () => {
    writeRaw({ schemaVersion: 99, selectionDwellMs: -50 });
    const s = loadSettings();
    expect(s._readOnly).toBe(true);
    // Number(-50) || DEFAULT → -50 is truthy → clamped to SELECTION_DWELL_MIN_MS (200).
    expect(s.selectionDwellMs).toBeGreaterThanOrEqual(200);
  });

  it("forward-compat strips leftRailTabs/rightRailTabs fields (Wave I)", () => {
    // Wave I removed both rail-tab settings fields from the schema. A
    // forward-compat blob that still carries them must not surface them
    // anywhere — not as typed fields, not as future-field leak via the
    // `...futureFields` spread. Otherwise a future schema that re-uses
    // either name silently inherits stale state from older clients.
    writeRaw({
      schemaVersion: 99,
      leftRailTabs: ["chat", "annotations"],
      rightRailTabs: ["outline"],
    });
    const s = loadSettings() as Record<string, unknown>;
    expect(s._readOnly).toBe(true);
    // Both names are stripped — neither stays as a typed field nor leaks
    // through the future-field passthrough.
    expect(s.leftRailTabs).toBeUndefined();
    expect(s.rightRailTabs).toBeUndefined();
  });

  it("v5→v6 idempotency: an already-v6 blob loads without re-running migrations", () => {
    writeRaw({
      schemaVersion: 6,
      theme: "dark",
      models: [],
    });
    const s = loadSettings() as Record<string, unknown>;
    expect(s.schemaVersion).toBe(7);
    expect(s.theme).toBe("dark");
    // The migration chain's `=== N` gates are exclusive — re-running on
    // an already-v6 blob is a no-op. _readOnly is reserved for the v99+
    // forward-compat path; an in-bounds v6 should never set it.
    expect(s._readOnly).toBeUndefined();
  });

  it("v2 seed with rail-tabs climbs to v6 with both fields absent (realistic prod-upgrade path)", () => {
    // A v2 blob from before Wave D where the user had Chat on the left
    // rail. After climbing v2→v3 (models added) → v3→v4 (no-op) →
    // v4→v5 (rail-tab fields stripped) → v5→v6 (showIntegrationWizard
    // stripped) the typed return must carry none of those names.
    writeRaw({
      schemaVersion: 2,
      leftRailTabs: ["chat", "outline"],
      rightRailTabs: [],
      leftPanelVisible: true,
      rightPanelVisible: true,
    });
    const s = loadSettings() as Record<string, unknown>;
    expect(s.schemaVersion).toBe(7);
    expect(s.leftRailTabs).toBeUndefined();
    expect(s.rightRailTabs).toBeUndefined();
    expect(s._readOnly).toBeUndefined();
  });

  // v3 sources climb the chain to v6 in memory. The v3→v4 step's displaced-
  // tab plumbing is no longer observable to consumers because v4→v5 strips
  // the rail-tab fields entirely. These cases pin down "no crash on weird
  // v3 input + final state is rail-tab-free at v6."
  it("v3 with displaced left tabs climbs to v6 with rail-tab fields stripped", () => {
    writeRaw({
      schemaVersion: 3,
      leftRailTabs: ["chat", "outline"],
      rightRailTabs: ["annotations"],
      models: [],
    });
    const s = loadSettings();
    expect(s.schemaVersion).toBe(7);
    expect(s.leftRailTabs).toBeUndefined();
    expect(s.rightRailTabs).toBeUndefined();
  });

  it("v3 with corrupt rightRailTabs climbs to v6 without crashing", () => {
    writeRaw({
      schemaVersion: 3,
      leftRailTabs: ["chat", "outline"],
      rightRailTabs: "not-an-array" as unknown as string[],
      models: [],
    });
    const s = loadSettings();
    expect(s.schemaVersion).toBe(7);
    expect(s.leftRailTabs).toBeUndefined();
    expect(s.rightRailTabs).toBeUndefined();
  });

  it("v4 blobs climb to v6 stripping rail-tab fields", () => {
    writeRaw({
      schemaVersion: 5,
      leftRailTabs: ["outline"],
      rightRailTabs: ["annotations", "chat"],
      models: [],
      theme: "dark",
    });
    const s = loadSettings();
    expect(s.schemaVersion).toBe(7);
    expect(s.leftRailTabs).toBeUndefined();
    expect(s.rightRailTabs).toBeUndefined();
    expect(s.theme).toBe("dark");
    // Not _readOnly — climbed cleanly to CURRENT.
    expect(s._readOnly).toBeUndefined();
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
    // v7: plaintext `apiKey` from a pre-v7 blob is rehomed to the transient
    // `_legacyApiKey` field that drives the in-UI keychain migration. The
    // typed field is gone from `ModelRegistryEntry`.
    expect(s.models[0]._legacyApiKey).toBe("sk-test-DO-NOT-USE-anthropic");
    expect(s.models[0].apiKeyRef).toBeUndefined();
  });

  // v5→v6 (#477 PR 3c-ii-b): drop showIntegrationWizard. The wizard now
  // auto-opens via server-side first-run detection; dismissal lives in its
  // own `tandem:wizard-dismissed` key.

  it("v5→v6: drops showIntegrationWizard from a v5 blob", () => {
    writeRaw({
      schemaVersion: 5,
      showIntegrationWizard: true,
      theme: "dark",
    });
    const s = loadSettings() as Record<string, unknown>;
    expect(s.schemaVersion).toBe(7);
    expect(s.showIntegrationWizard).toBeUndefined();
    expect(s.theme).toBe("dark");
  });

  it("forward-compat strips showIntegrationWizard via REMOVED_FIELDS", () => {
    // A future-blob carrying the dead field must not leak it through the
    // forward-compat passthrough. Otherwise a future schema that re-uses
    // the name silently inherits stale state from this client.
    writeRaw({
      schemaVersion: 99,
      showIntegrationWizard: true,
    });
    const s = loadSettings() as Record<string, unknown>;
    expect(s._readOnly).toBe(true);
    expect(s.showIntegrationWizard).toBeUndefined();
  });

  it("v1 blob with showIntegrationWizard climbs to v6 stripping it", () => {
    writeRaw({
      schemaVersion: 1,
      layout: "tabbed",
      showIntegrationWizard: true,
    });
    const s = loadSettings() as Record<string, unknown>;
    expect(s.schemaVersion).toBe(7);
    expect(s.showIntegrationWizard).toBeUndefined();
  });

  it("v2 blob with showIntegrationWizard climbs to v6 stripping it", () => {
    writeRaw({
      schemaVersion: 2,
      leftPanelVisible: true,
      showIntegrationWizard: true,
    });
    const s = loadSettings() as Record<string, unknown>;
    expect(s.schemaVersion).toBe(7);
    expect(s.showIntegrationWizard).toBeUndefined();
  });

  it("v3 blob with showIntegrationWizard climbs to v6 stripping it", () => {
    writeRaw({
      schemaVersion: 3,
      models: [],
      showIntegrationWizard: true,
    });
    const s = loadSettings() as Record<string, unknown>;
    expect(s.schemaVersion).toBe(7);
    expect(s.showIntegrationWizard).toBeUndefined();
  });
});
