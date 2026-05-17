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

export const THEME_NEXT: Record<ThemePreference, ThemePreference> = {
  system: "dark",
  dark: "light",
  light: "system",
};

// Action-oriented labels: matches THEME_NEXT cycle so screen readers and
// tooltips announce what clicking will do, not what the current theme is.
export const THEME_LABEL: Record<ThemePreference, string> = {
  light: "Switch to system theme",
  dark: "Switch to light theme",
  system: "Switch to dark theme",
};
export type SidecarRetryStrategy = "exponential" | "constant-2s" | "manual";
export type RailTab = "annotations" | "chat" | "outline";

/**
 * Provider tag for entries in the local Models registry (#659).
 *
 * The registry tracks AI providers Tandem can call OUT to (Anthropic API,
 * OpenAI API, local Ollama, etc.). It is orthogonal to the
 * `IntegrationConfig` schema in `src/server/integrations/schema.ts`, which
 * tracks MCP clients that connect IN to Tandem (Claude Code, Claude Desktop,
 * other MCP clients). The two concepts don't compete.
 */
export type ModelProvider = "anthropic" | "openai" | "gemini" | "local-ollama" | "local-llamacpp";

const VALID_MODEL_PROVIDERS: ModelProvider[] = [
  "anthropic",
  "openai",
  "gemini",
  "local-ollama",
  "local-llamacpp",
];

/**
 * Transitional inline shape for a Models registry entry. The `apiKey` lives
 * in localStorage plaintext today — `SettingsModelsTab.svelte` surfaces an
 * in-product disclosure banner stating this, and a future release will move
 * keys to the OS keychain (the `tokenSecretRef` pattern from
 * `IntegrationConfig` is the likely path).
 */
export interface ModelRegistryEntry {
  /** Stable identifier, generated via `crypto.randomUUID()`. */
  id: string;
  provider: ModelProvider;
  /** User-facing label. */
  displayName: string;
  /** Provider's own model identifier (e.g. "claude-opus-4-7", "gpt-4o", "llama3.1:70b"). */
  modelId: string;
  /** Cloud providers only (anthropic/openai/gemini). */
  apiKey?: string;
  /** Local providers only (local-ollama/local-llamacpp). */
  endpoint?: string;
  enabled: boolean;
  params?: Record<string, number | string | boolean>;
}

/** Per-entry cap so a corrupt or hand-edited blob can't run the merge cost up. */
const MAX_MODELS = 50;

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
  // #649: opt-in Word-style margin annotation view (PR 1 — minimum viable; collision resolution in PR 2; narrow-layout fallback in PR 3)
  marginView: boolean;
  // #477 PR 3c-i: opt-in integration setup wizard (preview). Hidden by default
  // until ≥2-week soak completes; enables the full-screen modal on next launch
  // when no integration is configured yet.
  showIntegrationWizard: boolean;
  // #659 Wave 2 PR 8a: local AI provider registry. Empty until the user adds
  // entries via Settings → Models (PR 8b ships the UI). API keys live in
  // plaintext localStorage today; a future release will move them to the OS
  // keychain (see SettingsModelsTab.svelte's in-product banner).
  models: ModelRegistryEntry[];
  /**
   * **DO NOT** set this from product code. Internal marker stamped by
   * `loadSettings` when the on-disk `schemaVersion` is newer than this
   * client knows how to migrate. `createTandemSettings` short-circuits
   * `updateSettings` on read-only settings so a downgraded client cannot
   * clobber a newer client's models / keys / future fields.
   */
  _readOnly?: boolean;
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
  schemaVersion: 3,
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
  marginView: false,
  showIntegrationWizard: false,
  models: [],
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
 * Strip a corrupt or hand-edited `models` array down to entries that match
 * the known shape, capping at `MAX_MODELS`. Unknown top-level fields on
 * each entry are dropped — keeping a controlled set of keys prevents a
 * downstream consumer from accidentally trusting an attacker-supplied
 * `__proto__` or whatever else might appear in a poked-at localStorage
 * blob.
 */
function parseModels(raw: unknown): ModelRegistryEntry[] {
  if (!Array.isArray(raw)) return [];
  const out: ModelRegistryEntry[] = [];
  for (const entry of raw) {
    if (out.length >= MAX_MODELS) break;
    if (!entry || typeof entry !== "object") continue;
    const e = entry as Record<string, unknown>;
    if (
      typeof e.id !== "string" ||
      e.id.length === 0 ||
      typeof e.provider !== "string" ||
      !VALID_MODEL_PROVIDERS.includes(e.provider as ModelProvider) ||
      typeof e.displayName !== "string" ||
      typeof e.modelId !== "string" ||
      typeof e.enabled !== "boolean"
    ) {
      continue;
    }
    const cleaned: ModelRegistryEntry = {
      id: e.id,
      provider: e.provider as ModelProvider,
      displayName: e.displayName,
      modelId: e.modelId,
      enabled: e.enabled,
    };
    if (typeof e.apiKey === "string") cleaned.apiKey = e.apiKey;
    if (typeof e.endpoint === "string") cleaned.endpoint = e.endpoint;
    if (e.params && typeof e.params === "object" && !Array.isArray(e.params)) {
      const params: Record<string, number | string | boolean> = {};
      for (const [k, v] of Object.entries(e.params)) {
        if (typeof v === "number" || typeof v === "string" || typeof v === "boolean") {
          params[k] = v;
        }
      }
      cleaned.params = params;
    }
    out.push(cleaned);
  }
  return out;
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
 * Migrations chain forward through every known version. Each `if` runs at
 * most once per load; the chain finishes at `CURRENT_SCHEMA_VERSION`. An
 * on-disk version greater than what this client knows is loaded
 * defensively as `_readOnly: true` — `updateSettings` skips writes on
 * read-only settings so a downgraded client can't clobber a newer client's
 * data (most notably the Models registry's plaintext API keys; see
 * `SettingsModelsTab.svelte`).
 *
 * v1→v2: `layout`/`panelHidden` → `leftPanelVisible`/`rightPanelVisible`.
 * v2→v3: introduce `models: []`. No legacy shape to migrate from.
 *
 * In addition to the version chain, this loader runs an in-place
 * `leftSlot.kind` → `leftRailTabs` fallback that has been in place since
 * before the schema was versioned.
 */
const CURRENT_SCHEMA_VERSION = 3;

/**
 * Validate + clamp every known field on a parsed settings blob.
 *
 * Single source of clamp truth for `loadSettings`. Used by:
 *   1. The standard return path (post-migration, schemaVersion ≤ v3).
 *   2. The forward-compat read-only branch (schemaVersion > v3).
 *
 * Both call sites must produce identical normalization of known fields
 * — otherwise a forward-compat load could leak garbage values
 * (`editorWidthPercent: -999`, `theme: "neon"`) into the running UI.
 *
 * Owns the `leftSlot.kind → leftRailTabs` derivation so both paths
 * preserve outline-first ordering when the user had it selected.
 */
function normalizeKnownFields(parsed: Record<string, unknown>): TandemSettings {
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
    schemaVersion: CURRENT_SCHEMA_VERSION,
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
      parsed.editorFont === "serif" || parsed.editorFont === "sans" || parsed.editorFont === "mono"
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
    marginView: parsed.marginView === true,
    showIntegrationWizard: parsed.showIntegrationWizard === true,
    models: parseModels(parsed.models),
  };
}

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
      // Guard: JSON.parse("null") returns null (valid JSON but not a settings object).
      if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
        parsed = { leftPanelVisible: false, rightPanelVisible: true, schemaVersion: 1 };
      }
      // Migration chain — fall-through per step. Each step's guard is
      // `=== N`, not `!== N+1`, so v1 data climbs v1→v2→v3 in one load.
      const startingVersion = typeof parsed.schemaVersion === "number" ? parsed.schemaVersion : 1;
      if (startingVersion === 1) {
        // v1→v2: derive per-side visibility from old layout+panelHidden.
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
      if (parsed.schemaVersion === 2) {
        // v2→v3: introduce empty models registry. No legacy shape to read.
        parsed = { ...parsed, models: [], schemaVersion: 3 };
      }
      // Forward-compat: an on-disk version newer than what we can migrate
      // is loaded defensively and never written back. `_readOnly: true`
      // is the contract `createTandemSettings.updateSettings` checks.
      // The H2 security implication: a stale client on a newer-than-v3
      // settings blob would otherwise strip unknown future fields
      // (Models, integration metadata, etc.) on its first save.
      if (
        typeof parsed.schemaVersion === "number" &&
        parsed.schemaVersion > CURRENT_SCHEMA_VERSION
      ) {
        console.warn(
          `[tandem] settings schemaVersion=${parsed.schemaVersion} is newer than v${CURRENT_SCHEMA_VERSION}; loading defensively without writing.`,
        );
        const normalized = normalizeKnownFields(parsed);
        // Preserve unknown future fields verbatim so a user bouncing back
        // to the newer client doesn't perceive a regression. `knownKeys`
        // is runtime-derived from the helper output (NOT the type), so
        // any field the current code doesn't actively normalize passes
        // through unmodified — exactly the contract `_readOnly: true`
        // advertises. Known fields are sanitized via the helper so
        // garbage like `editorWidthPercent: -999` doesn't leak into the
        // running UI.
        const knownKeys = new Set(Object.keys(normalized));
        const futureFields: Record<string, unknown> = {};
        for (const [k, v] of Object.entries(parsed)) {
          if (!knownKeys.has(k) && k !== "_readOnly") futureFields[k] = v;
        }
        return { ...normalized, ...futureFields, _readOnly: true };
      }
      return normalizeKnownFields(parsed);
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
    // Re-run the shape filter on `models` so an unsafe partial update (e.g.
    // hand-rolled call site that pushes an object missing `enabled`) can't
    // corrupt the array between persisted reads.
    models: parseModels(merged.models),
  };
}
