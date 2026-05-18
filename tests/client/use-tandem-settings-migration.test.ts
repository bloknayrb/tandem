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

  it("v1 blob (layout=three-panel) climbs to v4 with models=[] and left=[outline]", () => {
    writeRaw({
      schemaVersion: 1,
      layout: "three-panel",
      panelHidden: false,
      textSize: "l",
    });
    const s = loadSettings();
    expect(s.schemaVersion).toBe(5);
    expect(s.leftPanelVisible).toBe(true);
    expect(s.rightPanelVisible).toBe(true);
    expect(s.textSize).toBe("l");
    expect(s.models).toEqual([]);
  });

  it("v1 blob (panelHidden=true) climbs to v5 with both panels hidden", () => {
    writeRaw({ schemaVersion: 1, panelHidden: true });
    const s = loadSettings();
    expect(s.schemaVersion).toBe(5);
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
    expect(s.schemaVersion).toBe(5);
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

  it("v4→v5 idempotency: an already-v5 blob loads without re-running migrations", () => {
    writeRaw({
      schemaVersion: 5,
      theme: "dark",
      models: [],
    });
    const s = loadSettings() as Record<string, unknown>;
    expect(s.schemaVersion).toBe(5);
    expect(s.theme).toBe("dark");
    // The migration chain's `=== N` gates are exclusive — re-running on
    // an already-v5 blob is a no-op. _readOnly is reserved for the v99+
    // forward-compat path; an in-bounds v5 should never set it.
    expect(s._readOnly).toBeUndefined();
  });

  it("v2 seed with rail-tabs climbs to v5 with both fields absent (realistic prod-upgrade path)", () => {
    // A v2 blob from before Wave D where the user had Chat on the left
    // rail. After climbing v2→v3 (models added) → v3→v4 (Chat displaced
    // to right) → v4→v5 (both fields stripped) the typed return must
    // carry neither name.
    writeRaw({
      schemaVersion: 2,
      leftRailTabs: ["chat", "outline"],
      rightRailTabs: [],
      leftPanelVisible: true,
      rightPanelVisible: true,
    });
    const s = loadSettings() as Record<string, unknown>;
    expect(s.schemaVersion).toBe(5);
    expect(s.leftRailTabs).toBeUndefined();
    expect(s.rightRailTabs).toBeUndefined();
    expect(s._readOnly).toBeUndefined();
  });

  it("v3→v4: displaced left tabs move to right rail (chat alone)", () => {
    // Realistic pre-Wave-D state: user moved Chat to the left rail. After
    // migration, Chat must survive on the right rail.
    writeRaw({
      schemaVersion: 3,
      leftRailTabs: ["chat", "outline"],
      rightRailTabs: ["annotations"],
      models: [],
    });
    const s = loadSettings();
    expect(s.schemaVersion).toBe(4);
    expect(s.leftRailTabs).toEqual(["outline"]);
    expect(s.rightRailTabs).toEqual(["annotations", "chat"]);
  });

  it("v3→v4: multiple displaced left tabs preserve source order (chat, annotations)", () => {
    writeRaw({
      schemaVersion: 3,
      leftRailTabs: ["chat", "annotations", "outline"],
      rightRailTabs: [],
      models: [],
    });
    const s = loadSettings();
    expect(s.schemaVersion).toBe(4);
    expect(s.leftRailTabs).toEqual(["outline"]);
    // Source order from the left rail is preserved on the right.
    expect(s.rightRailTabs).toEqual(["chat", "annotations"]);
  });

  it("v3→v4: displaced left tab already on right rail is deduped", () => {
    writeRaw({
      schemaVersion: 3,
      leftRailTabs: ["chat", "outline"],
      rightRailTabs: ["annotations", "chat"],
      models: [],
    });
    const s = loadSettings();
    expect(s.schemaVersion).toBe(4);
    expect(s.rightRailTabs).toEqual(["annotations", "chat"]); // no duplicate
  });

  it("v3→v4: rightRailTabs absent on v3 source — displaced tabs land on a fresh right rail", () => {
    writeRaw({
      schemaVersion: 3,
      leftRailTabs: ["chat", "outline"],
      // rightRailTabs intentionally omitted
      models: [],
    });
    const s = loadSettings();
    expect(s.schemaVersion).toBe(4);
    expect(s.rightRailTabs).toContain("chat");
  });

  it("v3→v4: rightRailTabs non-array (corrupt) on v3 source — displaced tabs land on a fresh right rail", () => {
    writeRaw({
      schemaVersion: 3,
      leftRailTabs: ["chat", "outline"],
      rightRailTabs: "not-an-array" as unknown as string[],
      models: [],
    });
    const s = loadSettings();
    expect(s.schemaVersion).toBe(4);
    expect(s.rightRailTabs).toContain("chat");
  });

  it("v3→v4: idempotency — already-v4 blob loads unchanged", () => {
    // A v4 blob should not re-run the migration (the `=== 3` gate is exclusive).
    writeRaw({
      schemaVersion: 4,
      leftRailTabs: ["outline"],
      rightRailTabs: ["annotations", "chat"],
      models: [],
      theme: "dark",
    });
    const s = loadSettings();
    expect(s.schemaVersion).toBe(4);
    expect(s.leftRailTabs).toEqual(["outline"]);
    expect(s.rightRailTabs).toEqual(["annotations", "chat"]);
    expect(s.theme).toBe("dark");
    // Not _readOnly — schemaVersion === CURRENT.
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
    expect(s.models[0].apiKey).toBe("sk-test-DO-NOT-USE-anthropic");
  });
});
