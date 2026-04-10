import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { loadSettings } from "../../src/client/hooks/useTandemSettings.js";
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

  it("clamps editorWidthPercent below 50 up to 50", () => {
    store.set(TANDEM_SETTINGS_KEY, JSON.stringify({ editorWidthPercent: 10 }));
    expect(loadSettings().editorWidthPercent).toBe(50);
  });
});
