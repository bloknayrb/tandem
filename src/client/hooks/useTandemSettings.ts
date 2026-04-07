import { useState, useCallback } from "react";
import {
  TANDEM_SETTINGS_KEY,
  SELECTION_DWELL_DEFAULT_MS,
  SELECTION_DWELL_MIN_MS,
  SELECTION_DWELL_MAX_MS,
} from "../../shared/constants";

export type LayoutMode = "tabbed" | "three-panel";
export type PrimaryTab = "chat" | "annotations";
export type PanelOrder = "chat-editor-annotations" | "annotations-editor-chat";

export interface TandemSettings {
  layout: LayoutMode;
  primaryTab: PrimaryTab;
  panelOrder: PanelOrder;
  selectionDwellMs: number;
  editorWidthPercent: number;
}

const DEFAULTS: TandemSettings = {
  layout: "tabbed",
  primaryTab: "chat",
  panelOrder: "chat-editor-annotations",
  selectionDwellMs: SELECTION_DWELL_DEFAULT_MS,
  editorWidthPercent: 100,
};

function loadSettings(): TandemSettings {
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
        selectionDwellMs: Math.max(
          SELECTION_DWELL_MIN_MS,
          Math.min(
            SELECTION_DWELL_MAX_MS,
            Number(parsed.selectionDwellMs) || SELECTION_DWELL_DEFAULT_MS,
          ),
        ),
        editorWidthPercent: Math.max(50, Math.min(100, Number(parsed.editorWidthPercent) || 100)),
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
      const next = { ...prev, ...partial };
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
