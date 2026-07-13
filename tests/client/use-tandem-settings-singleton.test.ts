/**
 * Singleton semantics for `createTandemSettings` (#735 review finding).
 *
 * The bug: two consumers (App.svelte + SettingsModelsTab.svelte) each
 * call `createTandemSettings()`. Pre-fix, each got its own `$state`
 * snapshot. Adding a model in the Models tab then changing theme
 * elsewhere caused the second writer's stale snapshot (`models: []`)
 * to clobber the model just added.
 *
 * The fix: module-level singleton. Every call returns the same
 * `TandemSettingsState`; mutations propagate through the shared proxy
 * and serial localStorage writes accumulate instead of overwriting.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  _resetTandemSettingsSingletonForTests,
  createTandemSettings,
} from "../../src/client/hooks/useTandemSettings.svelte.js";
import {
  AUTHORSHIP_TOGGLE_KEY,
  DECORATION_VISIBILITY_KEY,
  TANDEM_SETTINGS_KEY,
} from "../../src/shared/constants.js";
import { installLocalStorageStub } from "../helpers/local-storage-stub.js";

describe("createTandemSettings — singleton", () => {
  beforeEach(() => {
    installLocalStorageStub();
    _resetTandemSettingsSingletonForTests();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    _resetTandemSettingsSingletonForTests();
  });

  it("returns the same instance across repeated calls", () => {
    const a = createTandemSettings();
    const b = createTandemSettings();
    expect(a).toBe(b);
  });

  it("update from instance A is visible synchronously to instance B", () => {
    const a = createTandemSettings();
    const b = createTandemSettings();
    a.updateSettings({ theme: "dark" });
    expect(b.settings.theme).toBe("dark");
  });

  it("regression: cross-consumer writes do not clobber each other", () => {
    // Reproduces the original review finding:
    //   1. Consumer A adds a model.
    //   2. Consumer B changes theme.
    // Pre-fix: B's stale-snapshot write would persist `models: []`,
    // wiping the model A added. Post-fix: localStorage contains both.
    const a = createTandemSettings();
    const b = createTandemSettings();

    a.updateSettings({
      models: [
        {
          id: "m1",
          provider: "anthropic",
          displayName: "Model 1",
          modelId: "claude-opus-4-7",
          enabled: true,
        },
      ],
    });
    b.updateSettings({ theme: "dark" });

    const raw = localStorage.getItem(TANDEM_SETTINGS_KEY);
    expect(raw).not.toBeNull();
    const persisted = JSON.parse(raw as string);
    expect(persisted.theme).toBe("dark");
    expect(persisted.models).toHaveLength(1);
    expect(persisted.models[0].id).toBe("m1");
  });

  it("seeds the decoration-visibility keys on cold load before any update", () => {
    // D3 cold-load fix: the ProseMirror plugins read these dedicated keys at
    // init, before any Svelte effect runs. If the factory only mirrored them
    // on updateSettings, a user who had decorations muted/off would see a
    // flash of marks on a fresh load. Construction must seed them.
    const store = installLocalStorageStub();
    _resetTandemSettingsSingletonForTests();
    // No prior write — keys absent.
    expect(store.has(DECORATION_VISIBILITY_KEY)).toBe(false);

    createTandemSettings();

    // Seeded from loaded defaults (all visible).
    expect(JSON.parse(store.get(DECORATION_VISIBILITY_KEY) as string)).toEqual({
      comment: true,
      highlight: true,
      note: true,
    });
    expect(store.get(AUTHORSHIP_TOGGLE_KEY)).toBe("true");
  });

  it("folds master mute into the seeded effective visibility", () => {
    // Pre-seed a muted blob so loadSettings returns decorationsMuted:true with
    // per-type prefs on. The mirrored effective keys must read all-false.
    const store = installLocalStorageStub();
    store.set(
      TANDEM_SETTINGS_KEY,
      JSON.stringify({
        schemaVersion: 9,
        showAuthorship: true,
        showComments: true,
        showHighlights: true,
        showNotes: true,
        decorationsMuted: true,
        models: [],
      }),
    );
    _resetTandemSettingsSingletonForTests();

    createTandemSettings();

    expect(JSON.parse(store.get(DECORATION_VISIBILITY_KEY) as string)).toEqual({
      comment: false,
      highlight: false,
      note: false,
    });
    expect(store.get(AUTHORSHIP_TOGGLE_KEY)).toBe("false");
  });

  it("_resetTandemSettingsSingletonForTests forces a fresh load", () => {
    const a = createTandemSettings();
    a.updateSettings({ theme: "dark" });
    expect(a.settings.theme).toBe("dark");

    // Simulate a totally separate "session" by mutating localStorage
    // directly and resetting. The next call must observe the new state.
    localStorage.setItem(
      TANDEM_SETTINGS_KEY,
      JSON.stringify({ schemaVersion: 3, theme: "light", models: [] }),
    );
    _resetTandemSettingsSingletonForTests();

    const b = createTandemSettings();
    expect(b).not.toBe(a);
    expect(b.settings.theme).toBe("light");
  });
});
