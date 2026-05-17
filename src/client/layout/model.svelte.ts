/**
 * Layout model (ADR-037).
 *
 * Encapsulates the panel-visibility + rail-tab invariants previously spread
 * across `App.svelte`: derived visibility (with solo-mode suppression),
 * toggle handlers, cross-rail tab moves with the orphan-rail rule.
 *
 * Returned shape uses getters so consumers see reactivity through the
 * settings store underneath — same pattern as `useTandemSettings.svelte.ts`.
 *
 * Orphan-rail rule (block-toggle): `moveTabs` returns `false` and emits a
 * console.warn if the proposed move would leave the *other* rail empty.
 * The current behaviour is preserved (no auto-swap, no silent drop).
 */

import type { RailTab, TandemSettingsState } from "../hooks/useTandemSettings.svelte.js";

/** Sliver of the mode store the layout model needs. */
export interface LayoutModeStateLike {
  readonly tandemMode: "solo" | "tandem";
}

export interface LayoutModel {
  /** Effective visibility (`settings.leftPanelVisible`, no solo override on the left). */
  readonly leftVisible: boolean;
  /** Effective visibility — `settings.rightPanelVisible && !(solo && soloRailHidden)`. */
  readonly rightVisible: boolean;
  /** The settings-backed left rail tab ordering. */
  readonly leftTabs: ReadonlyArray<RailTab>;
  /** The settings-backed right rail tab ordering. */
  readonly rightTabs: ReadonlyArray<RailTab>;
  /** Toggle the left panel's persisted visibility. */
  toggleLeft(): void;
  /** Toggle the right panel; on show, also clears `soloRailHidden` in solo mode. */
  toggleRight(): void;
  /**
   * Replace one rail's tab order. If the proposed move would empty the OTHER
   * rail, the move is blocked and `false` is returned (block-toggle).
   * Returns `true` if the update was applied.
   */
  moveTabs(side: "left" | "right", newTabsForSide: ReadonlyArray<RailTab>): boolean;
}

export function createLayoutModel(
  settingsState: TandemSettingsState,
  modeState: LayoutModeStateLike,
): LayoutModel {
  const leftVisible = $derived(settingsState.settings.leftPanelVisible);
  const rightVisible = $derived(
    settingsState.settings.rightPanelVisible &&
      !(modeState.tandemMode === "solo" && settingsState.settings.soloRailHidden),
  );

  function toggleLeft(): void {
    settingsState.updateSettings({
      leftPanelVisible: !settingsState.settings.leftPanelVisible,
    });
  }

  function toggleRight(): void {
    if (rightVisible) {
      settingsState.updateSettings({ rightPanelVisible: false });
      return;
    }
    settingsState.updateSettings({
      rightPanelVisible: true,
      ...(modeState.tandemMode === "solo" ? { soloRailHidden: false } : {}),
    });
  }

  function moveTabs(side: "left" | "right", newTabsForSide: ReadonlyArray<RailTab>): boolean {
    const leftTabs = settingsState.settings.leftRailTabs;
    const rightTabs = settingsState.settings.rightRailTabs;
    const currentSide = side === "left" ? leftTabs : rightTabs;
    const otherTabs = side === "left" ? rightTabs : leftTabs;
    const next = [...newTabsForSide];

    const newlyAdded = next.filter((t) => !currentSide.includes(t));
    if (newlyAdded.length === 0) {
      settingsState.updateSettings(
        side === "left" ? { leftRailTabs: next } : { rightRailTabs: next },
      );
      return true;
    }

    const prunedOther = otherTabs.filter((t) => !newlyAdded.includes(t));
    if (prunedOther.length === 0) {
      console.warn(
        "[tandem] cross-rail tab move blocked — would leave the %s rail empty",
        side === "left" ? "right" : "left",
      );
      return false;
    }

    settingsState.updateSettings(
      side === "left"
        ? { leftRailTabs: next, rightRailTabs: prunedOther }
        : { rightRailTabs: next, leftRailTabs: prunedOther },
    );
    return true;
  }

  return {
    get leftVisible() {
      return leftVisible;
    },
    get rightVisible() {
      return rightVisible;
    },
    get leftTabs() {
      return settingsState.settings.leftRailTabs;
    },
    get rightTabs() {
      return settingsState.settings.rightRailTabs;
    },
    toggleLeft,
    toggleRight,
    moveTabs,
  };
}
