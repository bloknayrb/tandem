import { useCallback, useState } from "react";
import {
  SELECTION_DWELL_DEFAULT_MS,
  SELECTION_DWELL_MAX_MS,
  SELECTION_DWELL_MIN_MS,
  TANDEM_SETTINGS_KEY,
} from "../../shared/constants";

export type LayoutMode = "tabbed" | "three-panel";
export type PrimaryTab = "chat" | "annotations";
export type PanelOrder = "chat-editor-annotations" | "annotations-editor-chat";

export interface TandemSettings {
  layout: LayoutMode;
  primaryTab: PrimaryTab;
  panelOrder: PanelOrder;
  editorWidthPercent: number;
  selectionDwellMs: number;
}

const DEFAULTS: TandemSettings = {
  layout: "tabbed",
  primaryTab: "chat",
  panelOrder: "chat-editor-annotations",
  editorWidthPercent: 100,
  selectionDwellMs: SELECTION_DWELL_DEFAULT_MS,
};

/**
 * Read and normalize settings from localStorage.
 *
 * Exported for unit testing. All numeric values are clamped to their valid
 * ranges on load so corrupted storage cannot wedge the app at an invalid
 * setting. Non-numeric or missing values fall back to the default via the
 * `Number(x) || DEFAULT` idiom (note: this treats `0` as falsy, which is
 * intentional — `0` is not a valid dwell or width anyway).
 */
export function loadSettings(): TandemSettings {
  try {
    const saved = localStorage.getItem(TANDEM_SETTINGS_KEY);
    if (saved) {
      const parsed = JSON.parse(saved);
      return {
        layout: parsed.layout === "three-panel" ? "three-panel" : "tabbed",
        primaryTab: parsed.primaryTab === "annotations" ? "annotations" : "chat",
        panelOrder:
          parsed.panelOrder === "annotations-editor-chat"
            ? "annotations-editor-chat"
            : "chat-editor-annotations",
        editorWidthPercent: Math.max(50, Math.min(100, Number(parsed.editorWidthPercent) || 100)),
        selectionDwellMs: Math.max(
          SELECTION_DWELL_MIN_MS,
          Math.min(
            SELECTION_DWELL_MAX_MS,
            Number(parsed.selectionDwellMs) || SELECTION_DWELL_DEFAULT_MS,
          ),
        ),
      };
    }
  } catch {
    // localStorage unavailable (incognito/storage-disabled)
  }
  return DEFAULTS;
}

export function useTandemSettings() {
  const [settings, setSettingsState] = useState<TandemSettings>(loadSettings);

  const updateSettings = useCallback((partial: Partial<TandemSettings>) => {
    setSettingsState((prev) => {
      const merged = { ...prev, ...partial };
      // Clamp numeric values on write (same rules as loadSettings)
      const next: TandemSettings = {
        ...merged,
        editorWidthPercent: Math.max(50, Math.min(100, merged.editorWidthPercent)),
        selectionDwellMs: Math.max(
          SELECTION_DWELL_MIN_MS,
          Math.min(SELECTION_DWELL_MAX_MS, merged.selectionDwellMs),
        ),
      };
      try {
        localStorage.setItem(TANDEM_SETTINGS_KEY, JSON.stringify(next));
      } catch {
        // localStorage unavailable (incognito/storage-disabled)
      }
      return next;
    });
  }, []);

  return { settings, updateSettings };
}
