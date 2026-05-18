/**
 * Tests for the ADR-037 LayoutModel.
 *
 * Verifies that the model encapsulates the layout invariants: panel
 * visibility derivation with solo-mode suppression and toggle behaviour.
 * Wave I removed the cross-rail tab picker; the corresponding `moveTabs`
 * tests are gone with it.
 *
 * The model takes a settings store + a mode-state-like shape; we stub
 * both with plain Svelte 5 `$state` so the test exercises the reactive
 * contract end-to-end without pulling in `useTandemSettings`.
 */

import { describe, expect, it } from "vitest";
import type {
  TandemSettings,
  TandemSettingsState,
} from "../../src/client/hooks/useTandemSettings.svelte.js";
import { createLayoutModel } from "../../src/client/layout/model.svelte.js";

function makeSettingsState(initial: Partial<TandemSettings>): TandemSettingsState {
  let settings = $state<TandemSettings>({
    // Minimal defaults — only the fields the layout model reads matter for tests.
    leftPanelVisible: true,
    rightPanelVisible: true,
    soloRailHidden: false,
    primaryTab: "annotations",
    showAuthorship: true,
    theme: "system",
    textSize: "md",
    density: "comfortable",
    editorFont: "serif",
    editorWidthPx: 720,
    panelOrder: "left-first",
    dwellTimeMs: 1000,
    degradedBannerDelayMs: 5000,
    sidecarRetryStrategy: "exponential",
    networkHoldAnnotations: false,
    reduceMotion: false,
    ...initial,
  } as TandemSettings);

  return {
    get settings() {
      return settings;
    },
    updateSettings(partial: Partial<TandemSettings>) {
      settings = { ...settings, ...partial };
    },
  };
}

describe("LayoutModel visibility", () => {
  it("leftVisible mirrors settings.leftPanelVisible", () => {
    const settings = makeSettingsState({ leftPanelVisible: true });
    const model = createLayoutModel(settings, { tandemMode: "tandem" });
    expect(model.leftVisible).toBe(true);

    settings.updateSettings({ leftPanelVisible: false });
    expect(model.leftVisible).toBe(false);
  });

  it("rightVisible is true when settings.rightPanelVisible and not solo-hidden", () => {
    const settings = makeSettingsState({ rightPanelVisible: true, soloRailHidden: false });
    const model = createLayoutModel(settings, { tandemMode: "tandem" });
    expect(model.rightVisible).toBe(true);
  });

  it("rightVisible is suppressed in solo mode when soloRailHidden is set", () => {
    const settings = makeSettingsState({ rightPanelVisible: true, soloRailHidden: true });
    const model = createLayoutModel(settings, { tandemMode: "solo" });
    expect(model.rightVisible).toBe(false);
  });

  it("rightVisible stays true in tandem mode even when soloRailHidden is set", () => {
    const settings = makeSettingsState({ rightPanelVisible: true, soloRailHidden: true });
    const model = createLayoutModel(settings, { tandemMode: "tandem" });
    expect(model.rightVisible).toBe(true);
  });
});

describe("LayoutModel.toggleLeft", () => {
  it("flips leftPanelVisible", () => {
    const settings = makeSettingsState({ leftPanelVisible: true });
    const model = createLayoutModel(settings, { tandemMode: "tandem" });
    model.toggleLeft();
    expect(settings.settings.leftPanelVisible).toBe(false);
    model.toggleLeft();
    expect(settings.settings.leftPanelVisible).toBe(true);
  });
});

describe("LayoutModel.toggleRight", () => {
  it("hides the right panel when currently visible", () => {
    const settings = makeSettingsState({ rightPanelVisible: true, soloRailHidden: false });
    const model = createLayoutModel(settings, { tandemMode: "tandem" });
    model.toggleRight();
    expect(settings.settings.rightPanelVisible).toBe(false);
  });

  it("shows the right panel and clears soloRailHidden in solo mode", () => {
    const settings = makeSettingsState({ rightPanelVisible: false, soloRailHidden: true });
    const model = createLayoutModel(settings, { tandemMode: "solo" });
    model.toggleRight();
    expect(settings.settings.rightPanelVisible).toBe(true);
    expect(settings.settings.soloRailHidden).toBe(false);
  });

  it("does NOT touch soloRailHidden when toggling on in tandem mode", () => {
    const settings = makeSettingsState({ rightPanelVisible: false, soloRailHidden: true });
    const model = createLayoutModel(settings, { tandemMode: "tandem" });
    model.toggleRight();
    expect(settings.settings.rightPanelVisible).toBe(true);
    expect(settings.settings.soloRailHidden).toBe(true);
  });
});
