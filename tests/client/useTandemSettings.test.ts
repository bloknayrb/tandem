import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  CURRENT_SCHEMA_VERSION,
  EDITOR_MEASURE_CH,
  EDITOR_MEASURES,
  loadSettings,
  mergeAndClampSettings,
  resolveFont,
  type TandemSettings,
} from "../../src/client/hooks/useTandemSettings.js";
import {
  SELECTION_DWELL_DEFAULT_MS,
  SELECTION_DWELL_MAX_MS,
  SELECTION_DWELL_MIN_MS,
  TANDEM_SETTINGS_KEY,
} from "../../src/shared/constants.js";

/**
 * Minimal localStorage stub — vitest runs in node without a DOM, so we
 * install a backing Map and point `globalThis.localStorage` at it.
 */
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

describe("loadSettings — selectionDwellMs clamping", () => {
  let store: Map<string, string>;

  beforeEach(() => {
    store = installLocalStorageStub();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  function writeRawSettings(partial: Record<string, unknown>) {
    store.set(TANDEM_SETTINGS_KEY, JSON.stringify(partial));
  }

  it("returns default when no settings are stored", () => {
    const settings = loadSettings();
    expect(settings.leftPanelVisible).toBe(false);
    expect(settings.rightPanelVisible).toBe(true);
    expect(settings.schemaVersion).toBe(CURRENT_SCHEMA_VERSION);
    expect(settings.editorMeasure).toBe("comfortable");
    expect(settings.selectionDwellMs).toBe(SELECTION_DWELL_DEFAULT_MS);
  });

  it("accepts a valid in-range value unchanged", () => {
    writeRawSettings({ selectionDwellMs: 1500 });
    expect(loadSettings().selectionDwellMs).toBe(1500);
  });

  it("clamps a value above SELECTION_DWELL_MAX_MS down to the max", () => {
    writeRawSettings({ selectionDwellMs: 999_999 });
    expect(loadSettings().selectionDwellMs).toBe(SELECTION_DWELL_MAX_MS);
  });

  it("clamps a value below SELECTION_DWELL_MIN_MS up to the min", () => {
    writeRawSettings({ selectionDwellMs: 100 });
    expect(loadSettings().selectionDwellMs).toBe(SELECTION_DWELL_MIN_MS);
  });

  it("falls back to default when the stored value is a non-numeric string", () => {
    writeRawSettings({ selectionDwellMs: "garbage" });
    expect(loadSettings().selectionDwellMs).toBe(SELECTION_DWELL_DEFAULT_MS);
  });

  it("falls back to default when the stored value is 0 (Number(x) || DEFAULT)", () => {
    // `0` is a legitimate-looking number but falsy — documents the current
    // intentional behavior so a future "simplification" to `?? DEFAULT`
    // doesn't silently change it.
    writeRawSettings({ selectionDwellMs: 0 });
    expect(loadSettings().selectionDwellMs).toBe(SELECTION_DWELL_DEFAULT_MS);
  });

  it("falls back to default when the stored value is null", () => {
    writeRawSettings({ selectionDwellMs: null });
    expect(loadSettings().selectionDwellMs).toBe(SELECTION_DWELL_DEFAULT_MS);
  });

  it("returns defaults when the JSON is malformed", () => {
    store.set(TANDEM_SETTINGS_KEY, "{not valid json");
    const settings = loadSettings();
    expect(settings.selectionDwellMs).toBe(SELECTION_DWELL_DEFAULT_MS);
  });

  it("returns defaults without corrupt-JSON warning when stored value is JSON null", () => {
    // JSON.stringify(null) = "null"; JSON.parse("null") = null (valid JSON, not a
    // parse error). The old code would hit parsed.panelHidden on null and throw
    // inside the migration block, triggering a misleading "corrupt" console.warn.
    store.set(TANDEM_SETTINGS_KEY, "null");
    const warnSpy = vi.spyOn(console, "warn");
    const settings = loadSettings();
    // The original guard returned the default panel layout — assert against
    // a defaults field that doesn't change with each schema bump.
    expect(settings.leftPanelVisible).toBe(false);
    expect(settings.rightPanelVisible).toBe(true);
    expect(warnSpy).not.toHaveBeenCalledWith(expect.stringContaining("corrupt"));
    warnSpy.mockRestore();
  });

  it("returns defaults when localStorage.getItem throws (incognito mode)", () => {
    vi.stubGlobal("localStorage", {
      getItem: () => {
        throw new Error("storage disabled");
      },
      setItem: () => {},
      removeItem: () => {},
      clear: () => {},
      key: () => null,
      length: 0,
    } satisfies Storage);
    const settings = loadSettings();
    expect(settings.selectionDwellMs).toBe(SELECTION_DWELL_DEFAULT_MS);
  });
});

describe("loadSettings — editorMeasure validation (regression guard)", () => {
  let store: Map<string, string>;

  beforeEach(() => {
    store = installLocalStorageStub();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("preserves a valid editorMeasure preset", () => {
    store.set(TANDEM_SETTINGS_KEY, JSON.stringify({ editorMeasure: "wide" }));
    expect(loadSettings().editorMeasure).toBe("wide");
  });

  it("coerces an invalid editorMeasure to the default", () => {
    store.set(TANDEM_SETTINGS_KEY, JSON.stringify({ editorMeasure: "ginormous" }));
    expect(loadSettings().editorMeasure).toBe("comfortable");
  });

  it("EDITOR_MEASURE_CH covers every EDITOR_MEASURES entry (drift guard)", () => {
    // Adding a fifth preset to EDITOR_MEASURES without updating
    // EDITOR_MEASURE_CH is a TS error (Record exhaustiveness), but the reverse
    // — a CH entry without a measure entry — is allowed by TS. This test pins
    // both directions so the union, the validator, and the CSS map can't drift
    // apart silently as Stage C/D evolves the presets. The value check is
    // presence-and-non-empty rather than a `ch | 100%` regex so a legitimate
    // future fluid preset (e.g. `clamp(58ch, 90vw, 82ch)`) doesn't false-fail
    // — the test polices "did you add the entry" not "is the value language X."
    for (const m of EDITOR_MEASURES) {
      const v = EDITOR_MEASURE_CH[m];
      expect(v, `EDITOR_MEASURE_CH missing entry for ${m}`).toBeTruthy();
      expect(typeof v).toBe("string");
    }
    expect(Object.keys(EDITOR_MEASURE_CH).sort()).toEqual([...EDITOR_MEASURES].sort());
  });
});

describe("loadSettings — textSize", () => {
  let store: Map<string, string>;

  beforeEach(() => {
    store = installLocalStorageStub();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("defaults to 'm' when no stored value", () => {
    expect(loadSettings().textSize).toBe("m");
  });

  it("accepts 's'", () => {
    store.set(TANDEM_SETTINGS_KEY, JSON.stringify({ textSize: "s" }));
    expect(loadSettings().textSize).toBe("s");
  });

  it("accepts 'l'", () => {
    store.set(TANDEM_SETTINGS_KEY, JSON.stringify({ textSize: "l" }));
    expect(loadSettings().textSize).toBe("l");
  });

  it("falls back to 'm' for unknown values", () => {
    store.set(TANDEM_SETTINGS_KEY, JSON.stringify({ textSize: "xl" }));
    expect(loadSettings().textSize).toBe("m");
  });

  it("falls back to 'm' for non-string values", () => {
    store.set(TANDEM_SETTINGS_KEY, JSON.stringify({ textSize: 42 }));
    expect(loadSettings().textSize).toBe("m");
  });
});

describe("loadSettings — theme", () => {
  let store: Map<string, string>;

  beforeEach(() => {
    store = installLocalStorageStub();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("defaults to 'system' when no stored value", () => {
    expect(loadSettings().theme).toBe("system");
  });

  it.each(["light", "dark", "warm", "system"] as const)("accepts '%s'", (value) => {
    store.set(TANDEM_SETTINGS_KEY, JSON.stringify({ theme: value }));
    expect(loadSettings().theme).toBe(value);
  });

  it("falls back to 'system' for unknown values", () => {
    store.set(TANDEM_SETTINGS_KEY, JSON.stringify({ theme: "sepia" }));
    expect(loadSettings().theme).toBe("system");
  });

  it("falls back to 'system' for non-string values", () => {
    store.set(TANDEM_SETTINGS_KEY, JSON.stringify({ theme: true }));
    expect(loadSettings().theme).toBe("system");
  });
});

describe("loadSettings — reduceMotion", () => {
  let store: Map<string, string>;

  beforeEach(() => {
    store = installLocalStorageStub();
    // Stub matchMedia to a predictable default so tests that don't set
    // reduceMotion explicitly get a deterministic fallback.
    vi.stubGlobal("window", { matchMedia: () => ({ matches: false }) });
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("defaults to false when no OS preference and no stored value", () => {
    expect(loadSettings().reduceMotion).toBe(false);
  });

  it("honors OS preference when no stored value", () => {
    vi.stubGlobal("window", { matchMedia: () => ({ matches: true }) });
    expect(loadSettings().reduceMotion).toBe(true);
  });

  it("stored true overrides OS preference false", () => {
    store.set(TANDEM_SETTINGS_KEY, JSON.stringify({ reduceMotion: true }));
    expect(loadSettings().reduceMotion).toBe(true);
  });

  it("stored false overrides OS preference true", () => {
    vi.stubGlobal("window", { matchMedia: () => ({ matches: true }) });
    store.set(TANDEM_SETTINGS_KEY, JSON.stringify({ reduceMotion: false }));
    expect(loadSettings().reduceMotion).toBe(false);
  });

  it("non-boolean stored value falls back to OS preference", () => {
    vi.stubGlobal("window", { matchMedia: () => ({ matches: true }) });
    store.set(TANDEM_SETTINGS_KEY, JSON.stringify({ reduceMotion: "garbage" }));
    expect(loadSettings().reduceMotion).toBe(true);
  });
});

describe("loadSettings — marginView", () => {
  let store: Map<string, string>;

  beforeEach(() => {
    store = installLocalStorageStub();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("defaults to false when no settings are stored", () => {
    expect(loadSettings().marginView).toBe(false);
  });

  it("defaults to false when settings exist but marginView key is absent", () => {
    store.set(TANDEM_SETTINGS_KEY, JSON.stringify({ theme: "dark" }));
    expect(loadSettings().marginView).toBe(false);
  });

  it("returns true for literal boolean true", () => {
    store.set(TANDEM_SETTINGS_KEY, JSON.stringify({ marginView: true }));
    expect(loadSettings().marginView).toBe(true);
  });

  it("returns false for the string 'true' (strict === true guard)", () => {
    store.set(TANDEM_SETTINGS_KEY, JSON.stringify({ marginView: "true" }));
    expect(loadSettings().marginView).toBe(false);
  });

  it("returns false for the number 1 (truthy non-boolean)", () => {
    store.set(TANDEM_SETTINGS_KEY, JSON.stringify({ marginView: 1 }));
    expect(loadSettings().marginView).toBe(false);
  });

  it("returns false for literal boolean false", () => {
    store.set(TANDEM_SETTINGS_KEY, JSON.stringify({ marginView: false }));
    expect(loadSettings().marginView).toBe(false);
  });
});

describe("useTandemSettings — updateSettings write path", () => {
  // mergeAndClampSettings is the pure core of updateSettings — exercising it
  // directly covers the clamp-on-write contract without spinning up a React
  // render environment (no @testing-library/react in this project).

  const BASE: TandemSettings = {
    leftPanelVisible: true,
    rightPanelVisible: true,
    schemaVersion: 2,
    primaryTab: "chat",
    panelOrder: "chat-editor-annotations",
    editorMeasure: "wide",
    selectionDwellMs: SELECTION_DWELL_DEFAULT_MS,
    showAuthorship: true,
    reduceMotion: false,
    textSize: "m",
    theme: "system",
    accentHue: 275,
    editorFont: "sans",
    fontByExtension: {},
    density: "cozy",
    defaultMode: "tandem",
    highContrast: false,
    annotationPatterns: false,
    selectionToolbar: true,
    soloRailHidden: true,
    degradedBannerDelayMs: 30000,
    sidecarRetryStrategy: "exponential",
    marginView: false,
    showAnnotationDecorations: true,
    models: [],
    defaultModelId: null,
    customShortcuts: {},
  } as TandemSettings;

  it("merges a new editorMeasure preset through write", () => {
    const next = mergeAndClampSettings(BASE, { editorMeasure: "narrow" });
    expect(next.editorMeasure).toBe("narrow");
  });

  it("coerces a bogus editorMeasure write to the default (clamp-on-write contract)", () => {
    // Closed-union string fields need the same write-side guard as numeric
    // clamps — a TS `as EditorMeasure` cast at a call site can land a value
    // outside the union, and without this clamp the bogus string reaches the
    // grid as `--editor-measure: <bogus>;` and the layout silently breaks.
    const next = mergeAndClampSettings(BASE, {
      editorMeasure: "ginormous" as unknown as TandemSettings["editorMeasure"],
    });
    expect(next.editorMeasure).toBe("comfortable");
  });

  it("round-trips marginView=true through merge (write-side covers the strict-true load guard)", () => {
    const next = mergeAndClampSettings(BASE, { marginView: true });
    expect(next.marginView).toBe(true);
  });

  it("clamps selectionDwellMs above max down to SELECTION_DWELL_MAX_MS", () => {
    const next = mergeAndClampSettings(BASE, { selectionDwellMs: 99_999 });
    expect(next.selectionDwellMs).toBe(SELECTION_DWELL_MAX_MS);
  });

  it("clamps selectionDwellMs below min up to SELECTION_DWELL_MIN_MS", () => {
    const next = mergeAndClampSettings(BASE, { selectionDwellMs: 100 });
    expect(next.selectionDwellMs).toBe(SELECTION_DWELL_MIN_MS);
  });

  it("preserves unchanged fields when a single field is updated", () => {
    const next = mergeAndClampSettings(BASE, { theme: "dark" });
    expect(next.theme).toBe("dark");
    expect(next.leftPanelVisible).toBe(BASE.leftPanelVisible);
    expect(next.rightPanelVisible).toBe(BASE.rightPanelVisible);
    expect(next.primaryTab).toBe(BASE.primaryTab);
    expect(next.panelOrder).toBe(BASE.panelOrder);
    expect(next.editorMeasure).toBe(BASE.editorMeasure);
    expect(next.selectionDwellMs).toBe(BASE.selectionDwellMs);
    expect(next.showAuthorship).toBe(BASE.showAuthorship);
    expect(next.reduceMotion).toBe(BASE.reduceMotion);
    expect(next.textSize).toBe(BASE.textSize);
  });

  it("passes in-range numeric values through unchanged", () => {
    const next = mergeAndClampSettings(BASE, {
      selectionDwellMs: 1500,
    });
    expect(next.selectionDwellMs).toBe(1500);
  });

  it("clamps accentHue to [0, 360]", () => {
    expect(mergeAndClampSettings(BASE, { accentHue: -10 }).accentHue).toBe(0);
    expect(mergeAndClampSettings(BASE, { accentHue: 400 }).accentHue).toBe(360);
    expect(mergeAndClampSettings(BASE, { accentHue: 180 }).accentHue).toBe(180);
  });

  it("falls back to default accentHue for NaN", () => {
    expect(mergeAndClampSettings(BASE, { accentHue: NaN }).accentHue).toBe(275);
  });

  it("passes a valid customShortcuts override through the shape filter", () => {
    const chord = { ctrlOrMeta: true, alt: false, shift: false, code: "KeyJ" };
    const next = mergeAndClampSettings(BASE, { customShortcuts: { "new-scratchpad": chord } });
    expect(next.customShortcuts).toEqual({ "new-scratchpad": chord });
  });

  it("drops junk / fixed-colliding / non-bindable customShortcuts on merge", () => {
    const next = mergeAndClampSettings(BASE, {
      customShortcuts: {
        "bogus-id": { ctrlOrMeta: true, alt: false, shift: false, code: "KeyJ" },
        save: { ctrlOrMeta: true, alt: false, shift: false, code: "KeyA" }, // Ctrl+A → select-all (fixed)
        "close-tab": { ctrlOrMeta: true, alt: false, shift: true, code: "Slash" }, // Ctrl+Shift+/ → help (fixed family)
        "open-file": { ctrlOrMeta: false, alt: false, shift: true, code: "KeyB" }, // plain Shift+B → not bindable
      },
    });
    expect(next.customShortcuts).toEqual({});
  });

  // #811 — fontByExtension merge re-validation.
  it("passes a valid fontByExtension override through the shape filter", () => {
    const next = mergeAndClampSettings(BASE, { fontByExtension: { md: "serif", txt: "sans" } });
    expect(next.fontByExtension).toEqual({ md: "serif", txt: "sans" });
  });

  it("drops invalid fontByExtension values on merge", () => {
    const next = mergeAndClampSettings(BASE, {
      fontByExtension: { md: "wingdings" as unknown as "serif", docx: "mono" },
    });
    expect(next.fontByExtension).toEqual({ docx: "mono" });
  });
});

describe("resolveFont — per-format resolution order (post-#887)", () => {
  const base = { editorFont: "sans" as const, fontByExtension: {} };

  it("falls back to the global editorFont for an unknown format", () => {
    expect(resolveFont({ ...base, editorFont: "mono" }, "rtf")).toBe("mono");
  });

  it("falls through to the global editorFont when no per-format override is set", () => {
    // #887 follow-up: seeded DEFAULT_FONT_BY_EXTENSION removed. Every format
    // without an explicit user override resolves to the global setting,
    // including the ones the old map seeded (docx/txt/md/html).
    expect(resolveFont(base, "docx")).toBe("sans");
    expect(resolveFont(base, "txt")).toBe("sans");
    expect(resolveFont(base, "md")).toBe("sans");
    expect(resolveFont(base, "html")).toBe("sans");
  });

  it("the global editorFont actually changes resolution for all formats", () => {
    // Regression test for the silent-default bug: previously, switching the
    // global font to "mono" did nothing for docx/txt/md/html.
    const mono = { ...base, editorFont: "mono" as const };
    expect(resolveFont(mono, "docx")).toBe("mono");
    expect(resolveFont(mono, "txt")).toBe("mono");
    expect(resolveFont(mono, "md")).toBe("mono");
    expect(resolveFont(mono, "html")).toBe("mono");
  });

  it("prefers a per-format user override over the global setting", () => {
    expect(resolveFont({ ...base, fontByExtension: { docx: "serif" } }, "docx")).toBe("serif");
  });

  it("falls back to the global setting when format is null/undefined", () => {
    expect(resolveFont({ ...base, editorFont: "serif" }, null)).toBe("serif");
    expect(resolveFont({ ...base, editorFont: "serif" }, undefined)).toBe("serif");
  });
});

describe("loadSettings — new fields (PR 2: Schema Foundations)", () => {
  let store: Map<string, string>;

  beforeEach(() => {
    store = installLocalStorageStub();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  function writeRawSettings(partial: Record<string, unknown>) {
    store.set(TANDEM_SETTINGS_KEY, JSON.stringify(partial));
  }

  it("defaults showAuthorship to true", () => {
    expect(loadSettings().showAuthorship).toBe(true);
  });

  it("preserves stored showAuthorship: false (user choice)", () => {
    writeRawSettings({ showAuthorship: false });
    expect(loadSettings().showAuthorship).toBe(false);
  });

  it("defaults showAuthorship to true for upgrading users (key absent from existing blob)", () => {
    writeRawSettings({
      schemaVersion: 2,
      leftPanelVisible: true,
      rightPanelVisible: true,
      editorWidthPercent: 75,
    });
    expect(loadSettings().showAuthorship).toBe(true);
  });

  it("migrates old layout:'tabbed-left' to leftPanelVisible:true, rightPanelVisible:false", () => {
    writeRawSettings({ layout: "tabbed-left" });
    const s = loadSettings();
    expect(s.leftPanelVisible).toBe(true);
    expect(s.rightPanelVisible).toBe(false);
  });

  it("preserves accentHue: 0 (red) — not falsy-defaulted", () => {
    writeRawSettings({ accentHue: 0 });
    expect(loadSettings().accentHue).toBe(0);
  });

  it("defaults accentHue to 275 when absent", () => {
    expect(loadSettings().accentHue).toBe(275);
  });

  it("falls back to default accentHue for non-numeric values", () => {
    writeRawSettings({ accentHue: "garbage" });
    expect(loadSettings().accentHue).toBe(275);
  });

  it.each(["serif", "sans", "mono"] as const)("accepts editorFont '%s'", (font) => {
    writeRawSettings({ editorFont: font });
    expect(loadSettings().editorFont).toBe(font);
  });

  it("falls back to 'sans' for unknown editorFont", () => {
    writeRawSettings({ editorFont: "comic-sans" });
    expect(loadSettings().editorFont).toBe("sans");
  });

  it("defaults editorFont to 'sans' when absent", () => {
    expect(loadSettings().editorFont).toBe("sans");
  });

  it.each(["compact", "cozy", "spacious"] as const)("accepts density '%s'", (d) => {
    writeRawSettings({ density: d });
    expect(loadSettings().density).toBe(d);
  });

  it("falls back to 'cozy' for unknown density", () => {
    writeRawSettings({ density: "ultra-tight" });
    expect(loadSettings().density).toBe("cozy");
  });

  it.each(["solo", "tandem"] as const)("accepts defaultMode '%s'", (mode) => {
    writeRawSettings({ defaultMode: mode });
    expect(loadSettings().defaultMode).toBe(mode);
  });

  it("falls back to 'tandem' for unknown defaultMode", () => {
    writeRawSettings({ defaultMode: "pair" });
    expect(loadSettings().defaultMode).toBe("tandem");
  });

  it("accepts highContrast: true", () => {
    writeRawSettings({ highContrast: true });
    expect(loadSettings().highContrast).toBe(true);
  });

  it("defaults highContrast to false for non-boolean values", () => {
    writeRawSettings({ highContrast: "yes" });
    expect(loadSettings().highContrast).toBe(false);
  });

  it("accepts annotationPatterns: true", () => {
    writeRawSettings({ annotationPatterns: true });
    expect(loadSettings().annotationPatterns).toBe(true);
  });

  it("defaults annotationPatterns to false for non-boolean values", () => {
    writeRawSettings({ annotationPatterns: 1 });
    expect(loadSettings().annotationPatterns).toBe(false);
  });

  it("accepts selectionToolbar: false", () => {
    writeRawSettings({ selectionToolbar: false });
    expect(loadSettings().selectionToolbar).toBe(false);
  });

  it("defaults selectionToolbar to true when absent", () => {
    expect(loadSettings().selectionToolbar).toBe(true);
  });

  it("defaults selectionToolbar to true for non-boolean values", () => {
    writeRawSettings({ selectionToolbar: "nope" });
    expect(loadSettings().selectionToolbar).toBe(true);
  });
});

describe("v4→v5 picker teardown migration", () => {
  let store: Map<string, string>;

  beforeEach(() => {
    store = installLocalStorageStub();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  function writeRawSettings(partial: Record<string, unknown>) {
    store.set(TANDEM_SETTINGS_KEY, JSON.stringify(partial));
  }

  it("strips leftRailTabs and rightRailTabs from a v4 blob", () => {
    writeRawSettings({
      schemaVersion: 4,
      leftRailTabs: ["outline"],
      rightRailTabs: ["annotations", "chat"],
    });
    const s = loadSettings() as Record<string, unknown>;
    expect(s.schemaVersion).toBe(CURRENT_SCHEMA_VERSION);
    expect(s.leftRailTabs).toBeUndefined();
    expect(s.rightRailTabs).toBeUndefined();
  });

  it("strips leftRailTabs and rightRailTabs from a v3 blob (full chain)", () => {
    writeRawSettings({
      schemaVersion: 3,
      leftRailTabs: ["chat", "outline"],
      rightRailTabs: ["annotations"],
    });
    const s = loadSettings() as Record<string, unknown>;
    expect(s.schemaVersion).toBe(CURRENT_SCHEMA_VERSION);
    expect(s.leftRailTabs).toBeUndefined();
    expect(s.rightRailTabs).toBeUndefined();
  });

  it("strips showIntegrationWizard from a v5 blob", () => {
    writeRawSettings({
      schemaVersion: 5,
      showIntegrationWizard: true,
    });
    const s = loadSettings() as Record<string, unknown>;
    expect(s.schemaVersion).toBe(CURRENT_SCHEMA_VERSION);
    expect(s.showIntegrationWizard).toBeUndefined();
  });

  it("default load reports schemaVersion 6", () => {
    expect(loadSettings().schemaVersion).toBe(CURRENT_SCHEMA_VERSION);
  });
});

describe("soloRailHidden setting", () => {
  let store: Map<string, string>;

  beforeEach(() => {
    store = installLocalStorageStub();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("defaults to true when absent from storage", () => {
    const s = loadSettings();
    expect(s.soloRailHidden).toBe(true);
  });

  it("round-trips false correctly (persists explicit opt-out)", () => {
    store.set(TANDEM_SETTINGS_KEY, JSON.stringify({ soloRailHidden: false }));
    const s = loadSettings();
    expect(s.soloRailHidden).toBe(false);
  });

  it("treats true stored value as true", () => {
    store.set(TANDEM_SETTINGS_KEY, JSON.stringify({ soloRailHidden: true }));
    const s = loadSettings();
    expect(s.soloRailHidden).toBe(true);
  });
});

describe("defaultSaveDirectory (#1023)", () => {
  let store: Map<string, string>;

  beforeEach(() => {
    store = installLocalStorageStub();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("defaults to null when absent", () => {
    expect(loadSettings().defaultSaveDirectory).toBeNull();
  });

  it("preserves a stored absolute path through normalizeKnownFields (not stripped)", () => {
    store.set(TANDEM_SETTINGS_KEY, JSON.stringify({ defaultSaveDirectory: "/home/me/Documents" }));
    expect(loadSettings().defaultSaveDirectory).toBe("/home/me/Documents");
  });

  it("trims surrounding whitespace on load", () => {
    store.set(TANDEM_SETTINGS_KEY, JSON.stringify({ defaultSaveDirectory: "  /tmp/docs  " }));
    expect(loadSettings().defaultSaveDirectory).toBe("/tmp/docs");
  });

  it("coerces a blank/whitespace string to null on load", () => {
    store.set(TANDEM_SETTINGS_KEY, JSON.stringify({ defaultSaveDirectory: "   " }));
    expect(loadSettings().defaultSaveDirectory).toBeNull();
  });

  it("coerces a non-string to null on load", () => {
    store.set(TANDEM_SETTINGS_KEY, JSON.stringify({ defaultSaveDirectory: 42 }));
    expect(loadSettings().defaultSaveDirectory).toBeNull();
  });

  it("normalizes a blank write to null (mergeAndClampSettings)", () => {
    const base = loadSettings();
    expect(
      mergeAndClampSettings(base, { defaultSaveDirectory: "   " }).defaultSaveDirectory,
    ).toBeNull();
    expect(
      mergeAndClampSettings(base, { defaultSaveDirectory: "  /srv/notes  " }).defaultSaveDirectory,
    ).toBe("/srv/notes");
  });
});
