/**
 * Layout model (ADR-037).
 *
 * Encapsulates the panel-visibility invariants previously spread across
 * `App.svelte`: derived visibility (with solo-mode suppression on the right)
 * and toggle handlers.
 *
 * Returned shape uses getters so consumers see reactivity through the
 * settings store underneath — same pattern as `useTandemSettings.svelte.ts`.
 *
 * Wave I removed the cross-rail tab picker. The left rail is hard-coded to
 * the outline; the right rail is hard-coded to Annotations + Chat. The
 * `leftTabs` / `rightTabs` getters and `moveTabs` action are gone.
 */

import type { TandemSettingsState } from "../hooks/useTandemSettings.svelte.js";

/** Sliver of the mode store the layout model needs. */
export interface LayoutModeStateLike {
  readonly tandemMode: "solo" | "tandem";
}

export interface LayoutModel {
  /** Effective visibility (`settings.leftPanelVisible`, no solo override on the left). */
  readonly leftVisible: boolean;
  /** Effective visibility — `settings.rightPanelVisible && !(solo && soloRailHidden)`. */
  readonly rightVisible: boolean;
  /** Toggle the left panel's persisted visibility. */
  toggleLeft(): void;
  /** Toggle the right panel; on show, also clears `soloRailHidden` in solo mode. */
  toggleRight(): void;
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

  return {
    get leftVisible() {
      return leftVisible;
    },
    get rightVisible() {
      return rightVisible;
    },
    toggleLeft,
    toggleRight,
  };
}
