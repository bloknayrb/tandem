import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  loadSettings,
  mergeAndClampSettings,
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
    expect(settings.layout).toBe("three-panel");
    expect(settings.editorWidthPercent).toBe(50);
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

describe("loadSettings — editorWidthPercent clamping (regression guard)", () => {
  let store: Map<string, string>;

  beforeEach(() => {
    store = installLocalStorageStub();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("clamps editorWidthPercent above 100 down to 100", () => {
    store.set(TANDEM_SETTINGS_KEY, JSON.stringify({ editorWidthPercent: 250 }));
    expect(loadSettings().editorWidthPercent).toBe(100);
  });

  it("clamps editorWidthPercent below 40 up to 40", () => {
    store.set(TANDEM_SETTINGS_KEY, JSON.stringify({ editorWidthPercent: 10 }));
    expect(loadSettings().editorWidthPercent).toBe(40);
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

  it.each(["light", "dark", "system"] as const)("accepts '%s'", (value) => {
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

describe("useTandemSettings — updateSettings write path", () => {
  // mergeAndClampSettings is the pure core of updateSettings — exercising it
  // directly covers the clamp-on-write contract without spinning up a React
  // render environment (no @testing-library/react in this project).

  const BASE: TandemSettings = {
    layout: "three-panel",
    primaryTab: "chat",
    panelOrder: "chat-editor-annotations",
    editorWidthPercent: 75,
    selectionDwellMs: SELECTION_DWELL_DEFAULT_MS,
    showAuthorship: true,
    reduceMotion: false,
    textSize: "m",
    theme: "system",
    accentHue: 239,
    editorFont: "sans",
    density: "cozy",
    defaultMode: "tandem",
    highContrast: false,
    annotationPatterns: false,
    selectionToolbar: true,
  };

  it("clamps editorWidthPercent above 100 down to 100", () => {
    const next = mergeAndClampSettings(BASE, { editorWidthPercent: 120 });
    expect(next.editorWidthPercent).toBe(100);
  });

  it("clamps editorWidthPercent below 40 up to 40", () => {
    const next = mergeAndClampSettings(BASE, { editorWidthPercent: 10 });
    expect(next.editorWidthPercent).toBe(40);
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
    expect(next.layout).toBe(BASE.layout);
    expect(next.primaryTab).toBe(BASE.primaryTab);
    expect(next.panelOrder).toBe(BASE.panelOrder);
    expect(next.editorWidthPercent).toBe(BASE.editorWidthPercent);
    expect(next.selectionDwellMs).toBe(BASE.selectionDwellMs);
    expect(next.showAuthorship).toBe(BASE.showAuthorship);
    expect(next.reduceMotion).toBe(BASE.reduceMotion);
    expect(next.textSize).toBe(BASE.textSize);
  });

  it("passes in-range numeric values through unchanged", () => {
    const next = mergeAndClampSettings(BASE, {
      editorWidthPercent: 80,
      selectionDwellMs: 1500,
    });
    expect(next.editorWidthPercent).toBe(80);
    expect(next.selectionDwellMs).toBe(1500);
  });

  it("clamps accentHue to [0, 360]", () => {
    expect(mergeAndClampSettings(BASE, { accentHue: -10 }).accentHue).toBe(0);
    expect(mergeAndClampSettings(BASE, { accentHue: 400 }).accentHue).toBe(360);
    expect(mergeAndClampSettings(BASE, { accentHue: 180 }).accentHue).toBe(180);
  });

  it("falls back to default accentHue for NaN", () => {
    expect(mergeAndClampSettings(BASE, { accentHue: NaN }).accentHue).toBe(239);
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
    writeRawSettings({ layout: "three-panel", editorWidthPercent: 75 });
    expect(loadSettings().showAuthorship).toBe(true);
  });

  it("accepts tabbed-left as a valid layout", () => {
    writeRawSettings({ layout: "tabbed-left" });
    expect(loadSettings().layout).toBe("tabbed-left");
  });

  it("preserves accentHue: 0 (red) — not falsy-defaulted", () => {
    writeRawSettings({ accentHue: 0 });
    expect(loadSettings().accentHue).toBe(0);
  });

  it("defaults accentHue to 239 when absent", () => {
    expect(loadSettings().accentHue).toBe(239);
  });

  it("falls back to default accentHue for non-numeric values", () => {
    writeRawSettings({ accentHue: "garbage" });
    expect(loadSettings().accentHue).toBe(239);
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
