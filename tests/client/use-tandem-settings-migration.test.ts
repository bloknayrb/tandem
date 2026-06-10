/**
 * Migration chain coverage for `loadSettings`.
 *
 * Pins the full v1→current migration chain: panel layout coercions (v1→v2),
 * models array addition (v2→v3), rail-tab teardown (v4→v5), wizard flag
 * removal (v5→v6), defaultModelId introduction (v6→v7), and any subsequent
 * migrations. Forward-compat (schemaVersion: 99) is also covered.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { CURRENT_SCHEMA_VERSION, loadSettings } from "../../src/client/hooks/useTandemSettings.js";
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

  it("v1 blob (layout=three-panel) migrates fully with models=[] and rail-tab fields stripped", () => {
    writeRaw({
      schemaVersion: 1,
      layout: "three-panel",
      panelHidden: false,
      textSize: "l",
    });
    const s = loadSettings();
    expect(s.schemaVersion).toBe(CURRENT_SCHEMA_VERSION);
    expect(s.leftPanelVisible).toBe(true);
    expect(s.rightPanelVisible).toBe(true);
    expect(s.textSize).toBe("l");
    expect(s.models).toEqual([]);
  });

  // #981: showRawMarkdown is a pure read in `normalizeKnownFields` (no version
  // bump). The allowlist entry is the thing most likely to be forgotten, so pin
  // its presence + default + explicit-false survival.
  it("showRawMarkdown defaults to true when absent and survives an explicit false", () => {
    writeRaw({ schemaVersion: CURRENT_SCHEMA_VERSION });
    expect(loadSettings().showRawMarkdown).toBe(true);

    writeRaw({ schemaVersion: CURRENT_SCHEMA_VERSION, showRawMarkdown: false });
    expect(loadSettings().showRawMarkdown).toBe(false);

    writeRaw({ schemaVersion: CURRENT_SCHEMA_VERSION, showRawMarkdown: true });
    expect(loadSettings().showRawMarkdown).toBe(true);
  });

  it("v1 blob (panelHidden=true) migrates fully with both panels hidden", () => {
    writeRaw({ schemaVersion: 1, panelHidden: true });
    const s = loadSettings();
    expect(s.schemaVersion).toBe(CURRENT_SCHEMA_VERSION);
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
    expect(s.schemaVersion).toBe(CURRENT_SCHEMA_VERSION);
    expect(s.leftPanelVisible).toBe(true);
    expect(s.rightPanelVisible).toBe(false);
    // v11→v12 maps a customized width (≠ 100) to the new Comfortable default.
    expect(s.editorMeasure).toBe("comfortable");
    expect(s.theme).toBe("dark");
    expect(s.models).toEqual([]);
  });

  it("v11→v12: default-untouched width (100) maps to editorMeasure=full", () => {
    writeRaw({ schemaVersion: 11, editorWidthPercent: 100 });
    const s = loadSettings();
    expect(s.schemaVersion).toBe(CURRENT_SCHEMA_VERSION);
    expect(s.editorMeasure).toBe("full");
    // Legacy field is deleted, not round-tripped.
    expect((s as Record<string, unknown>).editorWidthPercent).toBeUndefined();
  });

  it("v11→v12: customized width maps to editorMeasure=comfortable", () => {
    writeRaw({ schemaVersion: 11, editorWidthPercent: 60 });
    const s = loadSettings();
    expect(s.editorMeasure).toBe("comfortable");
  });

  it("v11→v12: absent legacy width (never customized) maps to editorMeasure=full", () => {
    // A blob that climbed to v11 without ever serializing editorWidthPercent
    // means the width was never customized → preserve full-width like an
    // explicit 100, not the Comfortable reset reserved for real customizers.
    writeRaw({ schemaVersion: 11 });
    const s = loadSettings();
    expect(s.editorMeasure).toBe("full");
  });

  it("v11→v12: an already-present editorMeasure is preserved (cross-branch guard)", () => {
    writeRaw({ schemaVersion: 11, editorWidthPercent: 100, editorMeasure: "wide" });
    const s = loadSettings();
    expect(s.editorMeasure).toBe("wide");
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
  // over DEFAULTS, bypassing every clamp. A future-blob with a garbage known
  // field propagated raw values to the running UI. The fix routes both paths
  // through `normalizeKnownFields`.
  it("forward-compat coerces an invalid editorMeasure to the default", () => {
    writeRaw({ schemaVersion: 99, editorMeasure: "enormous" });
    const s = loadSettings();
    expect(s._readOnly).toBe(true);
    expect(s.editorMeasure).toBe("comfortable");
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
    expect(s.schemaVersion).toBe(CURRENT_SCHEMA_VERSION);
    expect(s.theme).toBe("dark");
    // The migration chain's `=== N` gates are exclusive — re-running on
    // an already-v6 blob is a no-op. _readOnly is reserved for the v99+
    // forward-compat path; an in-bounds v6 should never set it.
    expect(s._readOnly).toBeUndefined();
  });

  it("v2 seed with rail-tabs migrates fully with both fields absent (realistic prod-upgrade path)", () => {
    // A v2 blob from before Wave D where the user had Chat on the left
    // rail. After the full migration chain the typed return must carry
    // none of those names.
    writeRaw({
      schemaVersion: 2,
      leftRailTabs: ["chat", "outline"],
      rightRailTabs: [],
      leftPanelVisible: true,
      rightPanelVisible: true,
    });
    const s = loadSettings() as Record<string, unknown>;
    expect(s.schemaVersion).toBe(CURRENT_SCHEMA_VERSION);
    expect(s.leftRailTabs).toBeUndefined();
    expect(s.rightRailTabs).toBeUndefined();
    expect(s._readOnly).toBeUndefined();
  });

  // v3 sources climb the full chain. The v3→v4 step's displaced-tab plumbing
  // is no longer observable to consumers because v4→v5 strips the rail-tab
  // fields entirely. These cases pin down "no crash on weird v3 input + final
  // state is rail-tab-free."
  it("v3 with displaced left tabs migrates fully with rail-tab fields stripped", () => {
    writeRaw({
      schemaVersion: 3,
      leftRailTabs: ["chat", "outline"],
      rightRailTabs: ["annotations"],
      models: [],
    });
    const s = loadSettings();
    expect(s.schemaVersion).toBe(CURRENT_SCHEMA_VERSION);
    expect(s.leftRailTabs).toBeUndefined();
    expect(s.rightRailTabs).toBeUndefined();
  });

  it("v3 with corrupt rightRailTabs migrates fully without crashing", () => {
    writeRaw({
      schemaVersion: 3,
      leftRailTabs: ["chat", "outline"],
      rightRailTabs: "not-an-array" as unknown as string[],
      models: [],
    });
    const s = loadSettings();
    expect(s.schemaVersion).toBe(CURRENT_SCHEMA_VERSION);
    expect(s.leftRailTabs).toBeUndefined();
    expect(s.rightRailTabs).toBeUndefined();
  });

  it("v4 blobs migrate fully stripping rail-tab fields", () => {
    writeRaw({
      schemaVersion: 4,
      leftRailTabs: ["outline"],
      rightRailTabs: ["annotations", "chat"],
      models: [],
      theme: "dark",
    });
    const s = loadSettings();
    expect(s.schemaVersion).toBe(CURRENT_SCHEMA_VERSION);
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
    expect(s.schemaVersion).toBe(CURRENT_SCHEMA_VERSION);
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

  it("v1 blob with showIntegrationWizard migrates fully stripping it", () => {
    writeRaw({
      schemaVersion: 1,
      layout: "tabbed",
      showIntegrationWizard: true,
    });
    const s = loadSettings() as Record<string, unknown>;
    expect(s.schemaVersion).toBe(CURRENT_SCHEMA_VERSION);
    expect(s.showIntegrationWizard).toBeUndefined();
  });

  it("v2 blob with showIntegrationWizard migrates fully stripping it", () => {
    writeRaw({
      schemaVersion: 2,
      leftPanelVisible: true,
      showIntegrationWizard: true,
    });
    const s = loadSettings() as Record<string, unknown>;
    expect(s.schemaVersion).toBe(CURRENT_SCHEMA_VERSION);
    expect(s.showIntegrationWizard).toBeUndefined();
  });

  it("v3 blob with showIntegrationWizard migrates fully stripping it", () => {
    writeRaw({
      schemaVersion: 3,
      models: [],
      showIntegrationWizard: true,
    });
    const s = loadSettings() as Record<string, unknown>;
    expect(s.schemaVersion).toBe(CURRENT_SCHEMA_VERSION);
    expect(s.showIntegrationWizard).toBeUndefined();
  });

  // v8→v9 (1.13): split the single showAnnotationDecorations into per-type
  // showComments / showHighlights / showNotes + a decorationsMuted overlay.
  // The old flag was a persistent "all marks off" preference, so it maps onto
  // all three per-type flags by intent (mute starts off). Equivalence classes
  // on the old flag: false (all off), true (all on), absent (default on).
  it.each([
    { why: "old=false → all three per-type flags off", old: false, expected: false },
    { why: "old=true → all three per-type flags on", old: true, expected: true },
  ])("v8→v9: $why", ({ old, expected }) => {
    writeRaw({ schemaVersion: 8, showAnnotationDecorations: old, theme: "dark" });
    const s = loadSettings() as Record<string, unknown>;
    expect(s.schemaVersion).toBe(CURRENT_SCHEMA_VERSION);
    expect(s.showComments).toBe(expected);
    expect(s.showHighlights).toBe(expected);
    expect(s.showNotes).toBe(expected);
    // Mute is transient — never derived from the old persistent flag.
    expect(s.decorationsMuted).toBe(false);
    // The retired field name must not survive the split.
    expect(s.showAnnotationDecorations).toBeUndefined();
    expect(s.theme).toBe("dark");
    expect(s._readOnly).toBeUndefined();
  });

  it("v8→v9: old flag absent → per-type flags default on", () => {
    writeRaw({ schemaVersion: 8, theme: "warm" });
    const s = loadSettings() as Record<string, unknown>;
    expect(s.schemaVersion).toBe(CURRENT_SCHEMA_VERSION);
    expect(s.showComments).toBe(true);
    expect(s.showHighlights).toBe(true);
    expect(s.showNotes).toBe(true);
    expect(s.decorationsMuted).toBe(false);
  });

  it("forward-compat strips showAnnotationDecorations via REMOVED_FIELDS", () => {
    // A future-blob carrying the retired field must not leak it through the
    // forward-compat passthrough into a schema that re-uses the name.
    writeRaw({ schemaVersion: 99, showAnnotationDecorations: false });
    const s = loadSettings() as Record<string, unknown>;
    expect(s._readOnly).toBe(true);
    expect(s.showAnnotationDecorations).toBeUndefined();
  });

  // v9→v10 (1.11): introduce formattingBarVisible (default true). Pure bump —
  // a v9 blob with no formattingBarVisible defaults to true (today's behavior).
  it("v9→v10: formattingBarVisible defaults true when absent", () => {
    writeRaw({ schemaVersion: 9, theme: "dark" });
    const s = loadSettings() as Record<string, unknown>;
    expect(s.schemaVersion).toBe(CURRENT_SCHEMA_VERSION);
    expect(s.formattingBarVisible).toBe(true);
    expect(s.theme).toBe("dark");
    expect(s._readOnly).toBeUndefined();
  });

  it.each([
    { why: "explicit false survives the bump", val: false, expected: false },
    { why: "explicit true survives the bump", val: true, expected: true },
  ])("v9→v10: formattingBarVisible=$val — $why", ({ val, expected }) => {
    writeRaw({ schemaVersion: 9, formattingBarVisible: val });
    const s = loadSettings() as Record<string, unknown>;
    expect(s.schemaVersion).toBe(CURRENT_SCHEMA_VERSION);
    expect(s.formattingBarVisible).toBe(expected);
  });

  // v14→v15: introduce railHoverReveal (default true). Pure bump — a pre-v15
  // blob with no railHoverReveal defaults to true (new hover-to-float behavior).
  // (Renumbered from v13→v14 when #993's systemLightVariant claimed v14.)
  it("v14→v15: railHoverReveal defaults true when absent", () => {
    writeRaw({ schemaVersion: 14, theme: "dark" });
    const s = loadSettings() as Record<string, unknown>;
    expect(s.schemaVersion).toBe(CURRENT_SCHEMA_VERSION);
    expect(s.railHoverReveal).toBe(true);
    expect(s.theme).toBe("dark");
    expect(s._readOnly).toBeUndefined();
  });

  it.each([
    { why: "explicit false survives the bump", val: false, expected: false },
    { why: "explicit true survives the bump", val: true, expected: true },
  ])("v14→v15: railHoverReveal=$val — $why", ({ val, expected }) => {
    writeRaw({ schemaVersion: 14, railHoverReveal: val });
    const s = loadSettings() as Record<string, unknown>;
    expect(s.schemaVersion).toBe(CURRENT_SCHEMA_VERSION);
    expect(s.railHoverReveal).toBe(expected);
  });

  it("v8 blob migrates to current with customShortcuts defaulting to {}", () => {
    writeRaw({ schemaVersion: 8, leftPanelVisible: true });
    const s = loadSettings();
    expect(s.schemaVersion).toBe(CURRENT_SCHEMA_VERSION);
    expect(s.customShortcuts).toEqual({});
  });

  it("preserves a valid customShortcuts override on load", () => {
    const chord = { ctrlOrMeta: true, alt: false, shift: false, code: "KeyJ" };
    writeRaw({ schemaVersion: 9, customShortcuts: { "new-scratchpad": chord } });
    const s = loadSettings();
    expect(s.customShortcuts).toEqual({ "new-scratchpad": chord });
  });

  it("normalizeKnownFields drops junk customShortcuts entries (bad id / bad chord)", () => {
    writeRaw({
      schemaVersion: 9,
      customShortcuts: {
        "not-a-real-id": { ctrlOrMeta: true, alt: false, shift: false, code: "KeyJ" },
        save: { ctrlOrMeta: true, code: "KeyJ" }, // malformed chord
      },
    });
    const s = loadSettings();
    expect(s.customShortcuts).toEqual({});
  });

  it("normalizeKnownFields drops a stored override colliding with a fixed matcher branch", () => {
    // Ctrl+A → select-all and Ctrl+Shift+/ → help are fixed matcher branches
    // (covered live by claimedByFixedShortcut). An override pointing at either —
    // including the loose Ctrl+Shift+/ help variant the old reserved list missed —
    // must be dropped at load rather than shadowing the fixed shortcut.
    writeRaw({
      schemaVersion: 9,
      customShortcuts: {
        save: { ctrlOrMeta: true, alt: false, shift: false, code: "KeyA" },
        "close-tab": { ctrlOrMeta: true, alt: false, shift: true, code: "Slash" },
      },
    });
    const s = loadSettings();
    expect(s.customShortcuts).toEqual({});
  });

  it("normalizeKnownFields drops a non-bindable override (no primary modifier)", () => {
    // Plain Shift+J has no Ctrl/Alt, so the override loop would fire it on every
    // keystroke; it must be dropped at load (matches the recording-UI gate).
    writeRaw({
      schemaVersion: 9,
      customShortcuts: { save: { ctrlOrMeta: false, alt: false, shift: true, code: "KeyJ" } },
    });
    const s = loadSettings();
    expect(s.customShortcuts).toEqual({});
  });

  it("forward-compat (v99) sanitizes customShortcuts too", () => {
    writeRaw({
      schemaVersion: 99,
      customShortcuts: { "bogus-id": { ctrlOrMeta: true, alt: false, shift: false, code: "KeyJ" } },
    });
    const s = loadSettings();
    expect(s._readOnly).toBe(true);
    expect(s.customShortcuts).toEqual({});
  });

  // Cross-branch reconciliation: master and the umbrella both used schemaVersion
  // 9 (master = customShortcuts, umbrella = decorations split). A blob written by
  // a master-line v9 build carries the legacy showAnnotationDecorations flag and
  // no per-type fields; bumping it straight to v11 must not silently reset an
  // explicit "all marks off" preference. The presence-keyed fallback re-derives
  // the split.
  it.each([
    { why: "master-v9 all-off → per-type flags off", deco: false, expected: false },
    { why: "master-v9 all-on → per-type flags on", deco: true, expected: true },
  ])("master-line v9 (showAnnotationDecorations) reconciles: $why", ({ deco, expected }) => {
    writeRaw({
      schemaVersion: 9,
      showAnnotationDecorations: deco,
      customShortcuts: {},
      theme: "dark",
    });
    const s = loadSettings() as Record<string, unknown>;
    expect(s.schemaVersion).toBe(CURRENT_SCHEMA_VERSION);
    expect(s.showComments).toBe(expected);
    expect(s.showHighlights).toBe(expected);
    expect(s.showNotes).toBe(expected);
    expect(s.decorationsMuted).toBe(false);
    expect(s.showAnnotationDecorations).toBeUndefined();
    expect(s.theme).toBe("dark");
    expect(s._readOnly).toBeUndefined();
  });

  it("umbrella v9 blob (already split) is untouched by the reconciliation guard", () => {
    // Per-type fields present + no legacy flag → guard must not fire. An explicit
    // showComments:false must survive (not be clobbered back to the default).
    writeRaw({
      schemaVersion: 9,
      showComments: false,
      showHighlights: true,
      showNotes: true,
    });
    const s = loadSettings() as Record<string, unknown>;
    expect(s.schemaVersion).toBe(CURRENT_SCHEMA_VERSION);
    expect(s.showComments).toBe(false);
    expect(s.showHighlights).toBe(true);
    expect(s.showNotes).toBe(true);
  });

  // fontByExtension (#811), folded into the migration chain at v12→v13 (renumbered
  // from master's original v9→v10; see CURRENT_SCHEMA_VERSION note). Blobs below
  // use the versions master originally wrote; normalizeKnownFields parses
  // fontByExtension on any version, so the field's value survives the renumber.

  it("v9 blob migrates to current with fontByExtension defaulting to {}", () => {
    writeRaw({ schemaVersion: 9, leftPanelVisible: true });
    const s = loadSettings();
    expect(s.schemaVersion).toBe(CURRENT_SCHEMA_VERSION);
    expect(s.fontByExtension).toEqual({});
    // Fresh-install behavior preserved: global default still sans.
    expect(s.editorFont).toBe("sans");
  });

  it("preserves a valid fontByExtension override on load", () => {
    writeRaw({ schemaVersion: 10, fontByExtension: { md: "serif", docx: "mono" } });
    const s = loadSettings();
    expect(s.fontByExtension).toEqual({ md: "serif", docx: "mono" });
  });

  it("parseFontByExtension drops invalid values and prototype-pollution keys", () => {
    writeRaw({
      schemaVersion: 10,
      fontByExtension: {
        md: "comic-sans", // invalid font value → dropped
        docx: "serif", // valid → kept
        __proto__: "mono", // dangerous key → dropped
      },
    });
    const s = loadSettings();
    expect(s.fontByExtension).toEqual({ docx: "serif" });
    // Prototype not polluted.
    expect(({} as Record<string, unknown>).md).toBeUndefined();
  });

  it("forward-compat (v99) sanitizes fontByExtension too", () => {
    writeRaw({ schemaVersion: 99, fontByExtension: { md: "nope", html: "mono" } });
    const s = loadSettings();
    expect(s._readOnly).toBe(true);
    expect(s.fontByExtension).toEqual({ html: "mono" });
  });

  it("v1 blob migrates fully with fontByExtension defaulting to {}", () => {
    writeRaw({ schemaVersion: 1, layout: "three-panel" });
    const s = loadSettings();
    expect(s.schemaVersion).toBe(CURRENT_SCHEMA_VERSION);
    expect(s.fontByExtension).toEqual({});
  });

  // Cross-branch full-chain path: a master-line v10 blob carries the legacy
  // `editorWidthPercent` (master never removed it) AND predates fontByExtension's
  // renumber. It must climb v10→v11→v12→v13, converting width→editorMeasure and
  // defaulting fontByExtension — the exact path the master/umbrella fold-in risks.
  it("master-line v10 blob converts editorWidthPercent and gains fontByExtension", () => {
    writeRaw({ schemaVersion: 10, editorWidthPercent: 60, fontByExtension: { md: "serif" } });
    const s = loadSettings() as Record<string, unknown>;
    expect(s.schemaVersion).toBe(CURRENT_SCHEMA_VERSION);
    expect(s.editorMeasure).toBe("comfortable");
    expect(s.editorWidthPercent).toBeUndefined();
    expect(s.fontByExtension).toEqual({ md: "serif" });
    expect(s._readOnly).toBeUndefined();
  });

  // #941 regression — "settings reset on update."
  //
  // marginView (#649) is a later-added field. The reported symptom was that it
  // (and other prefs) reset to defaults after an app version update. The
  // migration chain itself is provably field-preserving: every step is a
  // `{ ...parsed, ... }` spread (never a rebuild), and `normalizeKnownFields`
  // reads each field off `parsed`. So a within-range bump (e.g. v12→v13) must
  // carry every user-set field through unchanged.
  //
  // These tests pin that contract so a future migration author who rebuilds the
  // object instead of spreading it (the only way marginView could silently drop
  // across a bump) trips an explicit failure. The real-world reset the issue
  // describes is the Tauri WebView clearing localStorage on app update — the
  // blob is GONE, not migrated, so `loadSettings` finds nothing and returns
  // DEFAULTS. That is invisible to vitest and not fixable in this layer; see the
  // PR description.

  it("#941: a v12 blob with marginView=true survives the bump to current", () => {
    writeRaw({ schemaVersion: 12, marginView: true });
    const s = loadSettings();
    expect(s.schemaVersion).toBe(CURRENT_SCHEMA_VERSION);
    expect(s.marginView).toBe(true);
    expect(s._readOnly).toBeUndefined();
  });

  it("#941: every user-set field survives a full v2→current migration", () => {
    // A maximally-customized older blob from the v2 era. After the full chain,
    // EVERY field the user could set at v2 must equal what they chose, not a
    // default. Anything dropped here means a migration step rebuilt the object
    // without spreading prior fields.
    //
    // The per-type decoration flags (showComments/showHighlights/showNotes) and
    // decorationsMuted did NOT exist at v2 — they were derived at v8→v9 from the
    // single `showAnnotationDecorations` flag — so they're asserted separately
    // in the v8→v9 cases above, not here.
    const userBlob = {
      schemaVersion: 2,
      leftPanelVisible: true, // non-default (default false)
      rightPanelVisible: false, // non-default (default true)
      primaryTab: "chat" as const, // non-default (default annotations)
      panelOrder: "annotations-editor-chat" as const,
      editorMeasure: "narrow" as const,
      selectionDwellMs: 1500,
      showAuthorship: false,
      reduceMotion: true,
      textSize: "l" as const,
      theme: "dark" as const,
      accentHue: 42,
      editorFont: "serif" as const,
      fontByExtension: { md: "mono" },
      density: "spacious" as const,
      defaultMode: "solo" as const,
      highContrast: true,
      annotationPatterns: true,
      selectionToolbar: false,
      formattingBarVisible: false,
      soloRailHidden: false,
      degradedBannerDelayMs: 60000,
      sidecarRetryStrategy: "manual" as const,
      holdAnnotationsWhileOffline: false,
      marginView: true, // #649 — the canonical "resets on update" field
    };
    writeRaw(userBlob);
    const s = loadSettings();
    expect(s.schemaVersion).toBe(CURRENT_SCHEMA_VERSION);
    expect(s._readOnly).toBeUndefined();
    // Every user-set field is preserved verbatim across the bump.
    expect(s.leftPanelVisible).toBe(true);
    expect(s.rightPanelVisible).toBe(false);
    expect(s.primaryTab).toBe("chat");
    expect(s.panelOrder).toBe("annotations-editor-chat");
    expect(s.editorMeasure).toBe("narrow");
    expect(s.selectionDwellMs).toBe(1500);
    expect(s.showAuthorship).toBe(false);
    expect(s.reduceMotion).toBe(true);
    expect(s.textSize).toBe("l");
    expect(s.theme).toBe("dark");
    expect(s.accentHue).toBe(42);
    expect(s.editorFont).toBe("serif");
    expect(s.fontByExtension).toEqual({ md: "mono" });
    expect(s.density).toBe("spacious");
    expect(s.defaultMode).toBe("solo");
    expect(s.highContrast).toBe(true);
    expect(s.annotationPatterns).toBe(true);
    expect(s.selectionToolbar).toBe(false);
    expect(s.formattingBarVisible).toBe(false);
    expect(s.soloRailHidden).toBe(false);
    expect(s.degradedBannerDelayMs).toBe(60000);
    expect(s.sidecarRetryStrategy).toBe("manual");
    expect(s.holdAnnotationsWhileOffline).toBe(false);
    expect(s.marginView).toBe(true);
  });

  it("#941: per-type decoration flags + marginView survive a full v9→current migration", () => {
    // v9 is the first version carrying the per-type decoration flags. A v9 blob
    // with explicit all-off per-type prefs AND marginView=true must keep both
    // through the chain — the v8→v9 derive step must NOT re-run (its `=== 8`
    // gate is exclusive) and clobber the explicit per-type values.
    writeRaw({
      schemaVersion: 9,
      marginView: true,
      showComments: false,
      showHighlights: false,
      showNotes: false,
      decorationsMuted: true,
    });
    const s = loadSettings();
    expect(s.schemaVersion).toBe(CURRENT_SCHEMA_VERSION);
    expect(s._readOnly).toBeUndefined();
    expect(s.marginView).toBe(true);
    expect(s.showComments).toBe(false);
    expect(s.showHighlights).toBe(false);
    expect(s.showNotes).toBe(false);
    expect(s.decorationsMuted).toBe(true);
  });

  it("#941: marginView=true is preserved across EVERY in-range schemaVersion bump", () => {
    // Parametrize over every version the chain can start from. marginView must
    // survive regardless of which migration steps run, so a future step added
    // mid-chain that rebuilds the object is caught at whatever version it lands.
    for (let v = 2; v < CURRENT_SCHEMA_VERSION; v++) {
      store.clear();
      writeRaw({ schemaVersion: v, marginView: true });
      const s = loadSettings();
      expect(s.schemaVersion, `start v${v}`).toBe(CURRENT_SCHEMA_VERSION);
      expect(s.marginView, `marginView dropped starting at v${v}`).toBe(true);
    }
  });

  it("#941: forward-compat (v99) preserves marginView=true (read-only path)", () => {
    // The other documented suspect: the read-only forward-compat branch. A
    // newer-than-current blob must still surface marginView through
    // `normalizeKnownFields` (it is a known field), not drop it.
    writeRaw({ schemaVersion: 99, marginView: true });
    const s = loadSettings();
    expect(s._readOnly).toBe(true);
    expect(s.marginView).toBe(true);
  });

  // v13→v14 (#993): introduce systemLightVariant (default "light"). Pure bump —
  // a pre-v14 blob with no field defaults to "light" (prior behavior: system
  // light always resolved to the neutral Light theme); an explicit "warm"
  // survives. Invalid values coerce to the "light" default.
  it("v13→v14: systemLightVariant defaults to 'light' when absent", () => {
    writeRaw({ schemaVersion: 13, theme: "system" });
    const s = loadSettings();
    expect(s.schemaVersion).toBe(CURRENT_SCHEMA_VERSION);
    expect(s.systemLightVariant).toBe("light");
    expect(s._readOnly).toBeUndefined();
  });

  it("v13→v14: an explicit 'warm' survives the bump", () => {
    writeRaw({ schemaVersion: 13, theme: "system", systemLightVariant: "warm" });
    const s = loadSettings();
    expect(s.schemaVersion).toBe(CURRENT_SCHEMA_VERSION);
    expect(s.systemLightVariant).toBe("warm");
  });

  it("normalizeKnownFields coerces an invalid systemLightVariant to 'light'", () => {
    writeRaw({ schemaVersion: CURRENT_SCHEMA_VERSION, systemLightVariant: "neon" });
    const s = loadSettings();
    expect(s.systemLightVariant).toBe("light");
  });

  it("systemLightVariant='warm' is preserved across EVERY in-range schemaVersion bump", () => {
    // Mirrors the marginView ratchet: a future migration step that rebuilds the
    // object instead of spreading would silently reset this field.
    for (let v = 2; v < CURRENT_SCHEMA_VERSION; v++) {
      store.clear();
      writeRaw({ schemaVersion: v, systemLightVariant: "warm" });
      const s = loadSettings();
      expect(s.schemaVersion, `start v${v}`).toBe(CURRENT_SCHEMA_VERSION);
      expect(s.systemLightVariant, `systemLightVariant dropped starting at v${v}`).toBe("warm");
    }
  });

  it("forward-compat (v99) preserves systemLightVariant='warm' (read-only path)", () => {
    writeRaw({ schemaVersion: 99, systemLightVariant: "warm" });
    const s = loadSettings();
    expect(s._readOnly).toBe(true);
    expect(s.systemLightVariant).toBe("warm");
  });
});
