import { PANEL_WIDTH_KEYS, type PanelSide } from "../shared/constants";

export const PANEL_MIN_WIDTH = 200;
export const PANEL_MAX_WIDTH = 600;
export const PANEL_DEFAULT_WIDTH = 300;

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
