// @vitest-environment happy-dom

/**
 * #1722 / #1792 item 1 — a downgraded settings blob makes `updateSettings` a
 * silent no-op at all eleven call sites, and only `SettingsModal` renders the
 * read-only banner.
 *
 * Two halves, and BOTH are load-bearing:
 *   - the hook returns `false` and invokes the registered handler (below), and
 *   - `App.svelte` actually registers one (`settings-readonly-ui.test.ts`).
 * This file registers its own handler, so on its own it cannot tell a wired
 * fix from an unwired one.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { CURRENT_SCHEMA_VERSION } from "../../src/client/hooks/useTandemSettings.js";
import {
  _resetTandemSettingsSingletonForTests,
  createTandemSettings,
  setSettingsWriteRefusedHandler,
} from "../../src/client/hooks/useTandemSettings.svelte.js";
import { TANDEM_SETTINGS_KEY } from "../../src/shared/constants.js";
import { installLocalStorageStub } from "../helpers/local-storage-stub.js";

describe("updateSettings — write-refused surface", () => {
  let store: Map<string, string>;

  beforeEach(() => {
    store = installLocalStorageStub();
    // Nulls the module-level handler too, so the "does not fire" arm below is
    // not decided by test ordering.
    _resetTandemSettingsSingletonForTests();
  });

  afterEach(() => {
    setSettingsWriteRefusedHandler(null);
    _resetTandemSettingsSingletonForTests();
    vi.unstubAllGlobals();
  });

  it("returns false, writes nothing and fires the handler once when read-only", () => {
    // A blob from a NEWER Tandem — loadSettings tags it `_readOnly`.
    store.set(
      TANDEM_SETTINGS_KEY,
      JSON.stringify({ schemaVersion: CURRENT_SCHEMA_VERSION + 5, theme: "light" }),
    );
    const handler = vi.fn();
    setSettingsWriteRefusedHandler(handler);

    const state = createTandemSettings();
    expect(state.settings._readOnly).toBe(true);
    const before = store.get(TANDEM_SETTINGS_KEY);

    expect(state.updateSettings({ theme: "dark" })).toBe(false);

    expect(store.get(TANDEM_SETTINGS_KEY)).toBe(before);
    expect(state.settings.theme).not.toBe("dark");
    expect(handler).toHaveBeenCalledTimes(1);
  });

  it("returns true and does not fire the handler on a normal blob", () => {
    const handler = vi.fn();
    setSettingsWriteRefusedHandler(handler);

    const state = createTandemSettings();
    expect(state.settings._readOnly).toBeUndefined();

    expect(state.updateSettings({ theme: "dark" })).toBe(true);
    expect(state.settings.theme).toBe("dark");
    expect(handler).not.toHaveBeenCalled();
  });

  it("drops the handler on singleton reset", () => {
    const handler = vi.fn();
    setSettingsWriteRefusedHandler(handler);
    _resetTandemSettingsSingletonForTests();

    store.set(
      TANDEM_SETTINGS_KEY,
      JSON.stringify({ schemaVersion: CURRENT_SCHEMA_VERSION + 5, theme: "light" }),
    );
    expect(createTandemSettings().updateSettings({ theme: "dark" })).toBe(false);
    expect(handler).not.toHaveBeenCalled();
  });
});
