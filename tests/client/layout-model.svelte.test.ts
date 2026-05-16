/**
 * Tests for the ADR-037 LayoutModel.
 *
 * Verifies that the model encapsulates the layout invariants (panel
 * visibility derivation with solo-mode suppression, toggle behaviour,
 * orphan-rail rule on cross-rail tab moves).
 *
 * The model takes a settings store + a mode-state-like shape; we stub
 * both with plain Svelte 5 `$state` so the test exercises the reactive
 * contract end-to-end without pulling in `useTandemSettings`.
 */

import { describe, expect, it } from "vitest";
import type {
  RailTab,
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
    leftRailTabs: ["outline"] as RailTab[],
    rightRailTabs: ["annotations", "chat"] as RailTab[],
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

describe("LayoutModel.moveTabs orphan-rail rule", () => {
  it("reordering within the same side commits without touching the other rail", () => {
    const settings = makeSettingsState({
      leftRailTabs: ["outline"],
      rightRailTabs: ["annotations", "chat"],
    });
    const model = createLayoutModel(settings, { tandemMode: "tandem" });
    const ok = model.moveTabs("right", ["chat", "annotations"]);
    expect(ok).toBe(true);
    expect(settings.settings.rightRailTabs).toEqual(["chat", "annotations"]);
    expect(settings.settings.leftRailTabs).toEqual(["outline"]);
  });

  it("moves a tab across rails when the source still has remaining tabs", () => {
    const settings = makeSettingsState({
      leftRailTabs: ["outline"],
      rightRailTabs: ["annotations", "chat"],
    });
    const model = createLayoutModel(settings, { tandemMode: "tandem" });
    // Move "chat" to left — right still has "annotations".
    const ok = model.moveTabs("left", ["outline", "chat"]);
    expect(ok).toBe(true);
    expect(settings.settings.leftRailTabs).toEqual(["outline", "chat"]);
    expect(settings.settings.rightRailTabs).toEqual(["annotations"]);
  });

  it("BLOCKS a move that would empty the other rail (orphan-rail rule)", () => {
    const settings = makeSettingsState({
      leftRailTabs: ["outline"],
      rightRailTabs: ["annotations"],
    });
    const model = createLayoutModel(settings, { tandemMode: "tandem" });
    // Move "annotations" to left would leave right empty.
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    const ok = model.moveTabs("left", ["outline", "annotations"]);
    expect(ok).toBe(false);
    expect(settings.settings.leftRailTabs).toEqual(["outline"]);
    expect(settings.settings.rightRailTabs).toEqual(["annotations"]);
    expect(warnSpy).toHaveBeenCalledWith(
      expect.stringContaining("blocked"),
      expect.stringContaining("right"),
    );
    warnSpy.mockRestore();
  });
});

// vi.spyOn is referenced above
import { vi } from "vitest";
