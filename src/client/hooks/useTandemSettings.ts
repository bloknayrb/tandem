import {
  SELECTION_DWELL_DEFAULT_MS,
  SELECTION_DWELL_MAX_MS,
  SELECTION_DWELL_MIN_MS,
  TANDEM_SETTINGS_KEY,
} from "../../shared/constants";
import type { TandemMode } from "../../shared/types.js";

export type EditorFont = "serif" | "sans" | "mono";
export type Density = "compact" | "cozy" | "spacious";
export type PrimaryTab = "chat" | "annotations";
export type PanelOrder = "chat-editor-annotations" | "annotations-editor-chat";
export type TextSize = "s" | "m" | "l";
export type ThemePreference = "light" | "dark" | "system";
export type SidecarRetryStrategy = "exponential" | "constant-2s" | "manual";
export type RailTab = "annotations" | "chat" | "outline";

export interface TandemSettings {
  leftPanelVisible: boolean;
  rightPanelVisible: boolean;
  schemaVersion: number;
  primaryTab: PrimaryTab;
  panelOrder: PanelOrder;
  editorWidthPercent: number;
  selectionDwellMs: number;
  showAuthorship: boolean;
  reduceMotion: boolean;
  textSize: TextSize;
  theme: ThemePreference;
  accentHue: number;
  editorFont: EditorFont;
  density: Density;
  defaultMode: TandemMode;
  highContrast: boolean;
  annotationPatterns: boolean;
  selectionToolbar: boolean;
  soloRailHidden: boolean;
  leftRailTabs: RailTab[];
  rightRailTabs: RailTab[];
  degradedBannerDelayMs: number;
  // TODO(v0.11.0): wire to yjsSync reconnect strategy
  sidecarRetryStrategy: SidecarRetryStrategy;
  // TODO(v0.11.0): wire to annotation queuing in useModeGate
  holdAnnotationsWhileOffline: boolean;
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
  leftPanelVisible: false,
  rightPanelVisible: true,
  schemaVersion: 2,
  primaryTab: "annotations",
  panelOrder: "chat-editor-annotations",
  editorWidthPercent: 100,
  selectionDwellMs: SELECTION_DWELL_DEFAULT_MS,
  showAuthorship: true,
  reduceMotion: false,
  textSize: "m",
  theme: "system",
  accentHue: 275,
  editorFont: "serif",
  density: "cozy",
  defaultMode: "tandem",
  highContrast: false,
  annotationPatterns: false,
  selectionToolbar: true,
  soloRailHidden: true,
  leftRailTabs: ["annotations", "outline"],
  rightRailTabs: ["annotations", "chat"],
  degradedBannerDelayMs: 30000,
  sidecarRetryStrategy: "exponential",
  holdAnnotationsWhileOffline: true,
};

const VALID_RAIL_TABS: RailTab[] = ["annotations", "chat", "outline"];

function parseRailTabs(raw: unknown, fallback: RailTab[]): RailTab[] {
  if (Array.isArray(raw)) {
    const filtered = raw.filter((t: unknown) =>
      VALID_RAIL_TABS.includes(t as RailTab),
    ) as RailTab[];
    return filtered.length > 0 ? filtered : fallback;
  }
  return fallback;
}

/**
 * Read and normalize settings from localStorage.
 *
 * Exported for unit testing. All numeric values are clamped to their valid
 * ranges on load so corrupted storage cannot wedge the app at an invalid
 * setting. Non-numeric or missing values fall back to the default via the
 * `Number(x) || DEFAULT` idiom (note: this treats `0` as falsy, which is
 * intentional — `0` is not a valid dwell or width anyway). `accentHue` is
 * the exception: hue 0 (red) is valid, so it uses an explicit `typeof`
 * range check instead.
 *
 * v1→v2 migration: `layout`/`panelHidden` → `leftPanelVisible`/`rightPanelVisible`.
 * v2 migration: `leftSlot.kind` → `leftRailTabs` (ordering preserved so the
 * previously-active tab stays first). Subsequent loads ignore the legacy key.
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
      let parsed = JSON.parse(saved) as Record<string, unknown>;
      // v1→v2 migration: derive per-side visibility from old layout+panelHidden.
      if (!parsed || typeof parsed !== "object" || parsed.schemaVersion !== 2) {
        const panelHidden = parsed.panelHidden === true;
        let leftPanelVisible = false;
        let rightPanelVisible = true;
        if (panelHidden) {
          leftPanelVisible = false;
          rightPanelVisible = false;
        } else if (parsed.layout === "three-panel") {
          leftPanelVisible = true;
          rightPanelVisible = true;
        } else if (parsed.layout === "tabbed-left") {
          leftPanelVisible = true;
          rightPanelVisible = false;
        }
        // "tabbed" or no recognizable layout → defaults (left hidden, right visible)
        parsed = { ...parsed, leftPanelVisible, rightPanelVisible, schemaVersion: 2 };
        delete parsed.layout;
        delete parsed.panelHidden;
      }
      // v2 in-place migration: leftSlot.kind → leftRailTabs ordering.
      // Preserve outline-first if the user had selected outline as their left panel.
      let leftRailTabsFallback = DEFAULTS.leftRailTabs;
      if (!Array.isArray(parsed.leftRailTabs)) {
        const ls = parsed.leftSlot as { kind?: unknown } | undefined;
        if (ls?.kind === "outline") {
          console.warn("[tandem] migrating legacy leftSlot.kind=outline → leftRailTabs");
          leftRailTabsFallback = ["outline", "annotations"];
        } else if (ls?.kind === "side") {
          console.warn("[tandem] migrating legacy leftSlot.kind=side → leftRailTabs");
        }
      }
      return {
        leftPanelVisible: parsed.leftPanelVisible === true,
        rightPanelVisible: parsed.rightPanelVisible !== false,
        schemaVersion: 2,
        primaryTab: parsed.primaryTab === "annotations" ? "annotations" : "chat",
        panelOrder:
          parsed.panelOrder === "annotations-editor-chat"
            ? "annotations-editor-chat"
            : "chat-editor-annotations",
        editorWidthPercent: Math.max(
          40,
          Math.min(100, Number(parsed.editorWidthPercent) || DEFAULTS.editorWidthPercent),
        ),
        selectionDwellMs: Math.max(
          SELECTION_DWELL_MIN_MS,
          Math.min(
            SELECTION_DWELL_MAX_MS,
            Number(parsed.selectionDwellMs) || SELECTION_DWELL_DEFAULT_MS,
          ),
        ),
        showAuthorship: parsed.showAuthorship === false ? false : DEFAULTS.showAuthorship,
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
        accentHue:
          typeof parsed.accentHue === "number" && parsed.accentHue >= 0 && parsed.accentHue <= 360
            ? parsed.accentHue
            : DEFAULTS.accentHue,
        editorFont:
          parsed.editorFont === "serif" ||
          parsed.editorFont === "sans" ||
          parsed.editorFont === "mono"
            ? parsed.editorFont
            : DEFAULTS.editorFont,
        density:
          parsed.density === "compact" || parsed.density === "cozy" || parsed.density === "spacious"
            ? parsed.density
            : DEFAULTS.density,
        defaultMode:
          parsed.defaultMode === "solo" || parsed.defaultMode === "tandem"
            ? parsed.defaultMode
            : DEFAULTS.defaultMode,
        highContrast: parsed.highContrast === true,
        annotationPatterns: parsed.annotationPatterns === true,
        selectionToolbar: parsed.selectionToolbar === false ? false : DEFAULTS.selectionToolbar,
        soloRailHidden: parsed.soloRailHidden === false ? false : DEFAULTS.soloRailHidden,
        degradedBannerDelayMs:
          typeof parsed.degradedBannerDelayMs === "number" &&
          parsed.degradedBannerDelayMs >= 5000 &&
          parsed.degradedBannerDelayMs <= 120000
            ? parsed.degradedBannerDelayMs
            : DEFAULTS.degradedBannerDelayMs,
        sidecarRetryStrategy:
          parsed.sidecarRetryStrategy === "exponential" ||
          parsed.sidecarRetryStrategy === "constant-2s" ||
          parsed.sidecarRetryStrategy === "manual"
            ? parsed.sidecarRetryStrategy
            : DEFAULTS.sidecarRetryStrategy,
        holdAnnotationsWhileOffline:
          typeof parsed.holdAnnotationsWhileOffline === "boolean"
            ? parsed.holdAnnotationsWhileOffline
            : DEFAULTS.holdAnnotationsWhileOffline,
        leftRailTabs: parseRailTabs(parsed.leftRailTabs, leftRailTabsFallback),
        rightRailTabs: parseRailTabs(parsed.rightRailTabs, DEFAULTS.rightRailTabs),
      };
    } catch (err) {
      // Corrupt blob — log so "my prefs reset" reports are diagnosable instead
      // of silently clobbered on the next write.
      console.warn("[tandem] settings JSON is corrupt, resetting to defaults:", err);
    }
  }
  return { ...DEFAULTS, reduceMotion: prefersReducedMotion() };
}

/**
 * Merge a partial update into the current settings and clamp numeric fields
 * to their valid ranges. Pure — no React, no storage — so the clamp-on-write
 * contract is directly testable.
 */
export function mergeAndClampSettings(
  prev: TandemSettings,
  partial: Partial<TandemSettings>,
): TandemSettings {
  const merged = { ...prev, ...partial };
  return {
    ...merged,
    editorWidthPercent: Math.max(40, Math.min(100, merged.editorWidthPercent)),
    selectionDwellMs: Math.max(
      SELECTION_DWELL_MIN_MS,
      Math.min(SELECTION_DWELL_MAX_MS, merged.selectionDwellMs),
    ),
    accentHue: Number.isFinite(merged.accentHue)
      ? Math.max(0, Math.min(360, merged.accentHue))
      : DEFAULTS.accentHue,
    degradedBannerDelayMs: Math.max(5000, Math.min(120000, merged.degradedBannerDelayMs)),
    leftRailTabs: merged.leftRailTabs.length > 0 ? merged.leftRailTabs : DEFAULTS.leftRailTabs,
    rightRailTabs: merged.rightRailTabs.length > 0 ? merged.rightRailTabs : DEFAULTS.rightRailTabs,
  };
}
