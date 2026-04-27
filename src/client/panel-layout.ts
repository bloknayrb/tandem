import { PANEL_WIDTH_KEYS, type PanelSide } from "../shared/constants";

/**
 * Client-local UI state describing the current side-panel arrangement.
 *
 * Discriminated union: each variant carries only the width(s) it uses.
 * `right` is present in layouts with a right panel (tabbed, three-panel).
 * `left` is present in layouts with a left panel (three-panel, tabbed-left).
 *
 * Purely in-memory: widths still persist individually via `PANEL_WIDTH_KEYS`
 * in localStorage. Keeping this client-side (not in `src/shared/types.ts`)
 * avoids overlap with the parallel Annotation type refactor (#233).
 */
export type PanelLayout =
  | { kind: "tabbed"; right: number }
  | { kind: "three-panel"; left: number; right: number }
  | { kind: "tabbed-left"; left: number };

export const PANEL_MIN_WIDTH = 200;
export const PANEL_MAX_WIDTH = 600;
export const PANEL_DEFAULT_WIDTH = 300;

export function getRightWidth(layout: PanelLayout): number {
  return "right" in layout ? layout.right : PANEL_DEFAULT_WIDTH;
}

export function loadPanelWidth(side: PanelSide): number {
  const key = PANEL_WIDTH_KEYS[side];
  try {
    const saved = localStorage.getItem(key);
    if (saved) {
      const parsed = parseInt(saved, 10);
      if (Number.isFinite(parsed)) {
        return Math.max(PANEL_MIN_WIDTH, Math.min(PANEL_MAX_WIDTH, parsed));
      }
      // Non-finite saved value — fall through and warn so corrupt storage
      // is diagnosable instead of silently reverting to the default.
      console.warn(`[tandem] ignoring non-numeric panel width for ${key}: ${saved}`);
    }
  } catch (err) {
    console.warn(`[tandem] localStorage unavailable reading ${key}:`, err);
  }
  return PANEL_DEFAULT_WIDTH;
}
