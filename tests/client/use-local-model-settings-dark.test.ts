// @vitest-environment happy-dom

/**
 * Dark pin (#1123): while `BYO_MODELS_ENABLED` is false — the production
 * literal, NOT mocked here — the local-model settings store sends nothing.
 * Importing it has no side effect, and neither a load nor a save fetches.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { BYO_MODELS_ENABLED } from "../../src/shared/constants.js";

const fetchSpy = vi.fn(() => Promise.reject(new Error("no fetch while dark")));

beforeEach(() => {
  fetchSpy.mockClear();
  vi.stubGlobal("fetch", fetchSpy);
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("useLocalModelSettings — dark", () => {
  it("the flag this file relies on is still off", () => {
    expect(BYO_MODELS_ENABLED).toBe(false);
  });

  it("does NO fetch on import, on load, or on a save, and holds no state", async () => {
    const { createLocalModelSettings } = await import(
      "../../src/client/hooks/useLocalModelSettings.svelte.js"
    );
    const s = createLocalModelSettings();
    await s.load();
    await s.setEditing(true);
    await s.setEditing(false);
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(s.known).toBe(false);
    expect(s.editing).toBe(false);
  });
});
