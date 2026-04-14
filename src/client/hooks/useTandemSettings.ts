import { useCallback, useState } from "react";
import {
  AUTHORSHIP_TOGGLE_KEY,
  SELECTION_DWELL_DEFAULT_MS,
  SELECTION_DWELL_MAX_MS,
  SELECTION_DWELL_MIN_MS,
  TANDEM_SETTINGS_KEY,
} from "../../shared/constants";

export type LayoutMode = "tabbed" | "three-panel";
export type PrimaryTab = "chat" | "annotations";
export type PanelOrder = "chat-editor-annotations" | "annotations-editor-chat";
export type TextSize = "s" | "m" | "l";
export type ThemePreference = "light" | "dark" | "system";

export interface TandemSettings {
  layout: LayoutMode;
  primaryTab: PrimaryTab;
  panelOrder: PanelOrder;
  editorWidthPercent: number;
  selectionDwellMs: number;
  showAuthorship: boolean;
  reduceMotion: boolean;
  textSize: TextSize;
  theme: ThemePreference;
}

export const TEXT_SIZE_PX: Record<TextSize, number> = { s: 14, m: 16, l: 18 };

// OS-level reduced-motion preference — used as the default so users who have
// already opted in at the system level don't see any animations on first run.
function prefersReducedMotion(): boolean {
  try {
    if (typeof window === "undefined") return false;
    return window.matchMedia("(prefers-reduced-motion: reduce)").matches;
  } catch {
    return false;
  }
}

const DEFAULTS: TandemSettings = {
  layout: "three-panel",
  primaryTab: "chat",
  panelOrder: "chat-editor-annotations",
  editorWidthPercent: 50,
  selectionDwellMs: SELECTION_DWELL_DEFAULT_MS,
  showAuthorship: false,
  reduceMotion: false,
  textSize: "m",
  theme: "system",
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
  let saved: string | null;
  try {
    saved = localStorage.getItem(TANDEM_SETTINGS_KEY);
  } catch {
    // localStorage unavailable (incognito/storage-disabled) — fall through.
    saved = null;
  }
  if (saved) {
    try {
      const parsed = JSON.parse(saved);
      return {
        layout:
          parsed.layout === "three-panel" || parsed.layout === "tabbed"
            ? parsed.layout
            : DEFAULTS.layout,
        primaryTab: parsed.primaryTab === "annotations" ? "annotations" : "chat",
        panelOrder:
          parsed.panelOrder === "annotations-editor-chat"
            ? "annotations-editor-chat"
            : "chat-editor-annotations",
        editorWidthPercent: Math.max(
          50,
          Math.min(100, Number(parsed.editorWidthPercent) || DEFAULTS.editorWidthPercent),
        ),
        selectionDwellMs: Math.max(
          SELECTION_DWELL_MIN_MS,
          Math.min(
            SELECTION_DWELL_MAX_MS,
            Number(parsed.selectionDwellMs) || SELECTION_DWELL_DEFAULT_MS,
          ),
        ),
        showAuthorship: parsed.showAuthorship === true,
        reduceMotion:
          typeof parsed.reduceMotion === "boolean" ? parsed.reduceMotion : prefersReducedMotion(),
        textSize:
          parsed.textSize === "s" || parsed.textSize === "m" || parsed.textSize === "l"
            ? parsed.textSize
            : DEFAULTS.textSize,
        theme:
          parsed.theme === "light" || parsed.theme === "dark" || parsed.theme === "system"
            ? parsed.theme
            : DEFAULTS.theme,
      };
    } catch (err) {
      // Corrupt blob — log so "my prefs reset" reports are diagnosable instead
      // of silently clobbered on the next write.
      console.warn("[tandem] settings JSON is corrupt, resetting to defaults:", err);
    }
  }
  return { ...DEFAULTS, reduceMotion: prefersReducedMotion() };
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
        // Mirror authorship toggle to dedicated key for ProseMirror plugin init
        localStorage.setItem(AUTHORSHIP_TOGGLE_KEY, String(next.showAuthorship));
      } catch {
        // localStorage unavailable (incognito/storage-disabled)
      }
      return next;
    });
  }, []);

  return { settings, updateSettings };
}
