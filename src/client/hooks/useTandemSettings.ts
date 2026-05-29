import {
  SELECTION_DWELL_DEFAULT_MS,
  SELECTION_DWELL_MAX_MS,
  SELECTION_DWELL_MIN_MS,
  TANDEM_SETTINGS_KEY,
} from "../../shared/constants";
import type { TandemMode } from "../../shared/types.js";
import type { ShortcutChord } from "../actions/keybindings.js";
import { parseCustomShortcuts } from "../actions/shortcut-conflicts.js";

export type EditorFont = "serif" | "sans" | "mono";
export type Density = "compact" | "cozy" | "spacious";
export type PrimaryTab = "chat" | "annotations";
export type PanelOrder = "chat-editor-annotations" | "annotations-editor-chat";
export type TextSize = "s" | "m" | "l";

/**
 * Reading-measure preset for the editor content track (Phase 3.5 Stage B).
 * Replaces the viewport-relative `editorWidthPercent` with a stable line
 * length: "narrow"/"comfortable"/"wide" map to ch widths (a measure that
 * holds the same number of characters per line regardless of rail state),
 * "full" keeps the old no-clamp behavior (content fills the available track).
 */
// Source of truth for the reading-measure union. Driving `EditorMeasure`,
// `EDITOR_MEASURE_CH`, and the runtime validator off one `as const` array means
// adding a fifth preset is a single edit — the type-checker propagates it
// through the `Record<EditorMeasure, …>` exhaustiveness on `EDITOR_MEASURE_CH`,
// and the `.includes()` validator below picks it up at runtime without a
// parallel `===` chain to forget. Mirrors `VALID_MODEL_PROVIDERS` (#659).
export const EDITOR_MEASURES = ["narrow", "comfortable", "wide", "full"] as const;
export type EditorMeasure = (typeof EDITOR_MEASURES)[number];

/** Preset → CSS length for the grid's `--editor-measure` custom property. */
export const EDITOR_MEASURE_CH: Readonly<Record<EditorMeasure, string>> = {
  narrow: "58ch",
  comfortable: "68ch",
  wide: "82ch",
  full: "100%",
};

function isEditorMeasure(value: unknown): value is EditorMeasure {
  return typeof value === "string" && (EDITOR_MEASURES as readonly string[]).includes(value);
}
export type ThemePreference = "light" | "dark" | "warm" | "system";
export type SidecarRetryStrategy = "exponential" | "constant-2s" | "manual";

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

export const VALID_MODEL_PROVIDERS: readonly ModelProvider[] = [
  "anthropic",
  "openai",
  "gemini",
  "local-ollama",
  "local-llamacpp",
];

/**
 * Models registry entry shape.
 *
 * **API keys never live in this object.** Cloud-provider keys are stored in
 * the OS keychain (`tandem-models` service) via `POST /api/models/secrets/:ref`;
 * only the opaque `apiKeyRef` is persisted to localStorage. Reading a key
 * requires a server-side resolve — there is no GET secrets endpoint.
 *
 * Legacy `apiKey` plaintext entries (schemaVersion ≤ 6) are detected by
 * `parseModels` and surfaced via the transient `_legacyApiKey` field so the
 * UI can prompt a one-shot migration to keychain. `_legacyApiKey` is never
 * written back — `mergeAndClampSettings` drops it on every persist.
 */
export interface ModelRegistryEntry {
  /** Stable identifier, generated via `crypto.randomUUID()`. */
  id: string;
  provider: ModelProvider;
  /** User-facing label. */
  displayName: string;
  /** Provider's own model identifier (e.g. "claude-opus-4-7", "gpt-4o", "llama3.1:70b"). */
  modelId: string;
  /**
   * Opaque keychain reference (base64url, ≤ 64 chars). Cloud providers only.
   * The actual secret lives in the OS keychain under service `tandem-models`.
   */
  apiKeyRef?: string;
  /** Local providers only (local-ollama/local-llamacpp). */
  endpoint?: string;
  enabled: boolean;
  params?: Record<string, number | string | boolean>;
  /**
   * **Transient, never persisted.** Set by `parseModels` when a legacy v6
   * blob carried a plaintext `apiKey`. The UI shows a one-shot migration
   * prompt that POSTs the key to the keychain and rewrites the entry with
   * `apiKeyRef`. Stripped by `mergeAndClampSettings` on every write so the
   * plaintext never round-trips back to disk.
   */
  _legacyApiKey?: string;
}

/** Per-entry cap so a corrupt or hand-edited blob can't run the merge cost up. */
const MAX_MODELS = 50;

export interface TandemSettings {
  leftPanelVisible: boolean;
  rightPanelVisible: boolean;
  schemaVersion: number;
  primaryTab: PrimaryTab;
  panelOrder: PanelOrder;
  editorMeasure: EditorMeasure;
  selectionDwellMs: number;
  showAuthorship: boolean;
  reduceMotion: boolean;
  textSize: TextSize;
  theme: ThemePreference;
  accentHue: number;
  editorFont: EditorFont;
  /**
   * Per-format editor-font overrides (#811). Keyed by the normalized document
   * `format` string (`md` / `docx` / `html` / `txt` — see `detectFormat`),
   * NOT raw extensions. A present entry overrides the global `editorFont`;
   * absence falls through to the global setting (no seeded default). See
   * `resolveFont`.
   */
  fontByExtension: Partial<Record<string, EditorFont>>;
  density: Density;
  defaultMode: TandemMode;
  highContrast: boolean;
  annotationPatterns: boolean;
  selectionToolbar: boolean;
  // 1.11: when false, the persistent floating formatting bar is hidden. The
  // always-full selection popup mirrors every bar control, so formatting stays
  // reachable while hidden (and Ctrl+Z/Y still drive undo/redo). Default true.
  formattingBarVisible: boolean;
  soloRailHidden: boolean;
  degradedBannerDelayMs: number;
  // TODO(v0.11.0): wire to yjsSync reconnect strategy
  sidecarRetryStrategy: SidecarRetryStrategy;
  // TODO(v0.11.0): wire to offline annotation queuing
  holdAnnotationsWhileOffline: boolean;
  // #649: opt-in Word-style margin annotation view (PR 1 — minimum viable; collision resolution in PR 2; narrow-layout fallback in PR 3)
  marginView: boolean;
  // #596 → 1.13: per-annotation-type display toggles (split from the old single
  // showAnnotationDecorations). When false, suppresses that type's inline marks
  // in the editor; side-panel cards stay. Display-only — `showNotes:false` hides
  // the user's own note marks in their own view but never affects ADR-027.
  showComments: boolean;
  showHighlights: boolean;
  showNotes: boolean;
  // 1.13: transient master "mute all decorations" overlay (clean reading view).
  // Suppresses all decoration rendering without clobbering the per-type prefs,
  // so restoring returns exactly the prior set. Editing a per-type row auto-unmutes.
  decorationsMuted: boolean;
  // #659: AI provider registry. API keys live in the OS keychain
  // (`tandem-models` service) via `POST /api/models/secrets/:ref`; the
  // entries here only carry the opaque `apiKeyRef`.
  models: ModelRegistryEntry[];
  /**
   * Id of the default model entry (`null` when none set or when the
   * referenced entry was deleted). `mergeAndClampSettings` enforces
   * referential integrity — a stale id is silently coerced to `null`.
   */
  defaultModelId: string | null;
  /**
   * User-remapped keyboard shortcuts (ADR-041). Keyed by
   * `RemappableShortcutId`; the value is the chord that overrides that
   * action's default. `parseCustomShortcuts` re-validates on every load/merge,
   * dropping any entry that isn't a remappable id, isn't a well-formed chord,
   * isn't bindable, collides with a reserved chord (`RESERVED_CHORDS`) or a
   * fixed matcher branch (`claimedByFixedShortcut`), or duplicates a
   * higher-priority id's chord.
   */
  customShortcuts: Record<string, ShortcutChord>;
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
  schemaVersion: 13,
  primaryTab: "annotations",
  panelOrder: "chat-editor-annotations",
  editorMeasure: "comfortable",
  selectionDwellMs: SELECTION_DWELL_DEFAULT_MS,
  showAuthorship: true,
  reduceMotion: false,
  textSize: "m",
  theme: "system",
  accentHue: 275,
  editorFont: "sans",
  fontByExtension: {},
  density: "cozy",
  defaultMode: "tandem",
  highContrast: false,
  annotationPatterns: false,
  selectionToolbar: true,
  formattingBarVisible: true,
  soloRailHidden: true,
  degradedBannerDelayMs: 30000,
  sidecarRetryStrategy: "exponential",
  holdAnnotationsWhileOffline: true,
  marginView: false,
  showComments: true,
  showHighlights: true,
  showNotes: true,
  decorationsMuted: false,
  models: [],
  defaultModelId: null,
  customShortcuts: {},
};

/** Max length of an opaque keychain ref (matches server-side `REF_MAX_LENGTH`). */
const MAX_KEY_REF_LENGTH = 64;
/** Plaintext `apiKey` cap kept only for the legacy-detection branch on read. */
const MAX_LEGACY_API_KEY_LENGTH = 512;

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
      e.id.length > 64 ||
      typeof e.provider !== "string" ||
      !VALID_MODEL_PROVIDERS.includes(e.provider as ModelProvider) ||
      typeof e.displayName !== "string" ||
      e.displayName.length > 256 ||
      typeof e.modelId !== "string" ||
      e.modelId.length === 0 ||
      e.modelId.length > 256 ||
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
    if (
      typeof e.apiKeyRef === "string" &&
      e.apiKeyRef.length > 0 &&
      e.apiKeyRef.length <= MAX_KEY_REF_LENGTH &&
      /^[A-Za-z0-9_-]+$/.test(e.apiKeyRef)
    ) {
      cleaned.apiKeyRef = e.apiKeyRef;
    } else if (typeof e.apiKey === "string" && e.apiKey.length <= MAX_LEGACY_API_KEY_LENGTH) {
      // Legacy plaintext key from a pre-v7 blob. Surface to the UI via the
      // transient `_legacyApiKey` so the user can complete a one-shot
      // migration to the keychain. Never written back — `mergeAndClampSettings`
      // strips the field on every persist.
      cleaned._legacyApiKey = e.apiKey;
    }
    if (typeof e.endpoint === "string" && e.endpoint.length <= 2048) cleaned.endpoint = e.endpoint;
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

const VALID_EDITOR_FONTS: readonly EditorFont[] = ["serif", "sans", "mono"];

/**
 * Strip a corrupt or hand-edited `fontByExtension` map down to entries whose
 * value is a valid {@link EditorFont}. Keys are arbitrary format strings
 * (`md` / `docx` / etc.); an unknown key is harmless since `resolveFont` only
 * ever looks up the active document's format. `__proto__`-style keys are
 * dropped via the explicit guard so a poked-at blob can't pollute the
 * resolved object's prototype.
 */
function parseFontByExtension(raw: unknown): Partial<Record<string, EditorFont>> {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return {};
  const out: Partial<Record<string, EditorFont>> = {};
  for (const [k, v] of Object.entries(raw as Record<string, unknown>)) {
    if (k === "__proto__" || k === "constructor" || k === "prototype") continue;
    if (typeof k !== "string" || k.length === 0 || k.length > 32) continue;
    if (typeof v === "string" && VALID_EDITOR_FONTS.includes(v as EditorFont)) {
      out[k] = v as EditorFont;
    }
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
 * v3→v4: left rail is locked to outline-only. Non-outline tabs in
 *   `leftRailTabs` move to `rightRailTabs` (append, dedupe) so the user's
 *   intent is preserved instead of silently discarded.
 * v4→v5: the cross-rail picker is gone. Both `leftRailTabs` and
 *   `rightRailTabs` are dropped from the schema. Left is locked to outline;
 *   right is hard-coded to Annotations + Chat in the UI.
 * v5→v6: drop `showIntegrationWizard` (the wizard now auto-opens based on
 *   server-side first-run detection; the "Reopen wizard" button in
 *   Settings → Claude Code replaces the toggle). Dismissal state lives in
 *   its own localStorage key `tandem:wizard-dismissed`, separate from
 *   `tandem:settings` (orthogonal lifecycle).
 * v6→v7: introduce `defaultModelId: null` and switch `ModelRegistryEntry`
 *   secret storage from plaintext `apiKey` → opaque `apiKeyRef` (OS
 *   keychain). The migration step itself is structural — it sets
 *   `defaultModelId` based on the first enabled entry and leaves any
 *   plaintext `apiKey` values in place so `parseModels` can surface them
 *   via the transient `_legacyApiKey` field for the in-UI migration prompt.
 *   This is the load-bearing #659 step.
 * v7→v8: introduce `showAnnotationDecorations: true` (#596). Default
 *   preserves prior visual behavior; users opt in to suppress inline
 *   annotation marks in the editor.
 * v8→v9 (1.13): split the single `showAnnotationDecorations` into per-type
 *   `showComments` / `showHighlights` / `showNotes` + a transient
 *   `decorationsMuted` master overlay. The old flag was a persistent "all
 *   marks off" preference, so it maps onto all three per-type flags by
 *   intent (mute stays off). This migration sets values (derives three
 *   fields from one) rather than being a pure version bump.
 * v9→v10 (1.11): introduce `formattingBarVisible: true`. Pure version bump —
 *   default preserves today's always-shown bar; normalizeKnownFields coerces.
 * v10→v11: introduce `customShortcuts: {}` (ADR-041, remappable keyboard
 *   shortcuts). Structural no-op like v7→v8 — `normalizeKnownFields` runs
 *   `parseCustomShortcuts` on whatever is present, dropping invalid /
 *   reserved-colliding entries.
 * v11→v12 (Phase 3.5 Stage B): replace the viewport-relative
 *   `editorWidthPercent` (40–100) with the `editorMeasure` reading-measure
 *   preset. `%` and `ch` aren't comparable units, so the mapping is
 *   intentionally coarse: a default-untouched blob (`editorWidthPercent ===
 *   100`, or the field absent entirely) → `"full"` (preserve today's
 *   full-width feel for the silent majority); any explicit non-100 width →
 *   `"comfortable"` (the new default, an accepted one-time approximate reset).
 *   `editorWidthPercent` is deleted on read and listed in REMOVED_FIELDS so it
 *   can't resurrect via forward-compat.
 * v12→v13: introduce `fontByExtension: {}` (#811, per-format editor font).
 *   Cross-branch fold-in — master shipped this as its own v9→v10 while the
 *   design-system umbrella independently used v10–v12; renumbered to v13 to keep
 *   the migration chain monotonic. Structural no-op — `normalizeKnownFields`
 *   runs `parseFontByExtension` on whatever is present, so the field's value is
 *   safe regardless of the version step. Empty default preserves fresh-install
 *   behavior: with no override, `resolveFont` falls back to the global
 *   `editorFont`.
 */
export const CURRENT_SCHEMA_VERSION = 13;

/**
 * Validate + clamp every known field on a parsed settings blob.
 *
 * Single source of clamp truth for `loadSettings`. Used by:
 *   1. The standard return path (post-migration, schemaVersion ≤ v3).
 *   2. The forward-compat read-only branch (schemaVersion > v3).
 *
 * Both call sites must produce identical normalization of known fields
 * — otherwise a forward-compat load could leak garbage values
 * (`accentHue: 9999`, `theme: "neon"`) into the running UI.
 *
 * v5 (Wave I): `leftRailTabs` and `rightRailTabs` no longer exist. The
 * `loadSettings` migration strips them on read; this helper does not
 * surface them.
 *
 * v6 (#477 PR 3c-ii-b): `showIntegrationWizard` no longer exists. The
 * `loadSettings` migration strips it on read; the field never reaches the
 * running UI.
 */
function normalizeKnownFields(parsed: Record<string, unknown>): TandemSettings {
  return {
    leftPanelVisible: parsed.leftPanelVisible === true,
    rightPanelVisible: parsed.rightPanelVisible !== false,
    schemaVersion: CURRENT_SCHEMA_VERSION,
    primaryTab: parsed.primaryTab === "annotations" ? "annotations" : "chat",
    panelOrder:
      parsed.panelOrder === "annotations-editor-chat"
        ? "annotations-editor-chat"
        : "chat-editor-annotations",
    editorMeasure: isEditorMeasure(parsed.editorMeasure)
      ? parsed.editorMeasure
      : DEFAULTS.editorMeasure,
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
      parsed.theme === "light" ||
      parsed.theme === "dark" ||
      parsed.theme === "warm" ||
      parsed.theme === "system"
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
    fontByExtension: parseFontByExtension(parsed.fontByExtension),
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
    formattingBarVisible:
      parsed.formattingBarVisible === false ? false : DEFAULTS.formattingBarVisible,
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
    marginView: parsed.marginView === true,
    showComments: parsed.showComments === false ? false : DEFAULTS.showComments,
    showHighlights: parsed.showHighlights === false ? false : DEFAULTS.showHighlights,
    showNotes: parsed.showNotes === false ? false : DEFAULTS.showNotes,
    decorationsMuted: parsed.decorationsMuted === true,
    models: parseModels(parsed.models),
    defaultModelId:
      typeof parsed.defaultModelId === "string" && parsed.defaultModelId.length > 0
        ? parsed.defaultModelId
        : null,
    // Validate against the CURRENT remappable + reserved sets so a stale
    // override that now collides with a newly-fixed shortcut is dropped here
    // rather than shadowing it via the matcher's override-first loop.
    // Returning it here also auto-adds `customShortcuts` to `knownKeys` for
    // the forward-compat passthrough.
    customShortcuts: parseCustomShortcuts(parsed.customShortcuts),
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
      // `=== N`, not `!== N+1`, so v1 data climbs v1→v2→v3→v4 in one load.
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
      if (parsed.schemaVersion === 3) {
        // v3→v4 (historical): left rail was locked to outline-only via a
        // migration that moved displaced tabs to the right rail. v5 strips
        // both fields entirely; this step is now a no-op intermediate.
        parsed = { ...parsed, schemaVersion: 4 };
      }
      if (parsed.schemaVersion === 4) {
        // v4→v5: drop both `leftRailTabs` and `rightRailTabs`. The cross-rail
        // picker is gone; the left rail is hard-coded to outline, the right
        // rail is hard-coded to Annotations + Chat. Field strip is unconditional
        // (intent isn't recoverable — both surfaces are now fixed).
        const next: Record<string, unknown> = { ...parsed, schemaVersion: 5 };
        delete next.leftRailTabs;
        delete next.rightRailTabs;
        parsed = next;
      }
      if (parsed.schemaVersion === 5) {
        // v5→v6: drop `showIntegrationWizard`. The wizard now auto-opens via
        // server-side first-run detection; dismissal lives in its own
        // `tandem:wizard-dismissed` key.
        const next: Record<string, unknown> = { ...parsed, schemaVersion: 6 };
        delete next.showIntegrationWizard;
        parsed = next;
      }
      if (parsed.schemaVersion === 6) {
        // v6→v7: introduce `defaultModelId`. Pre-select the first enabled
        // entry as the default so an existing user with one model doesn't
        // need to revisit Settings. Plaintext `apiKey` values pass through
        // here unchanged — `parseModels` rewrites them into the transient
        // `_legacyApiKey` field that drives the one-shot migration banner.
        const rawModels = Array.isArray(parsed.models)
          ? (parsed.models as Array<Record<string, unknown>>)
          : [];
        const firstEnabled = rawModels.find((m) => typeof m?.id === "string" && m.enabled === true);
        parsed = {
          ...parsed,
          schemaVersion: 7,
          defaultModelId:
            firstEnabled && typeof firstEnabled.id === "string" ? firstEnabled.id : null,
        };
      }
      if (parsed.schemaVersion === 7) {
        // v7→v8: introduce `showAnnotationDecorations: true`. Default
        // preserves prior visual behavior; normalizeKnownFields handles
        // the actual coercion on a blob that already carries the field.
        parsed = { ...parsed, schemaVersion: 8 };
      }
      if (parsed.schemaVersion === 8) {
        // v8→v9: split the single `showAnnotationDecorations` into per-type
        // flags. The old flag meant "all marks off" (a persistent preference,
        // not a transient mute), so map `false` onto all three per-type flags
        // by intent; mute starts off. Sets values because it derives three
        // fields from one — normalizeKnownFields can't infer the split.
        const allOff = parsed.showAnnotationDecorations === false;
        const next: Record<string, unknown> = {
          ...parsed,
          showComments: allOff ? false : true,
          showHighlights: allOff ? false : true,
          showNotes: allOff ? false : true,
          decorationsMuted: false,
          schemaVersion: 9,
        };
        delete next.showAnnotationDecorations;
        parsed = next;
      }
      if (parsed.schemaVersion === 9) {
        // v9→v10: introduce `formattingBarVisible`. Pure version bump — do NOT
        // set the field here (that would clobber an explicit `false`).
        // normalizeKnownFields defaults a missing field to true and preserves
        // an explicit false.
        parsed = { ...parsed, schemaVersion: 10 };
      }
      if (parsed.schemaVersion === 10) {
        // v10→v11: introduce `customShortcuts: {}` (ADR-041). Structural no-op;
        // normalizeKnownFields runs `parseCustomShortcuts` on whatever the
        // blob already carries.
        parsed = { ...parsed, schemaVersion: 11 };
      }
      if (parsed.schemaVersion === 11) {
        // v11→v12: replace `editorWidthPercent` with the `editorMeasure` preset.
        // Synthesize the preset from the legacy width, preserving full-width for
        // the default-untouched majority and approximately resetting customized
        // widths to the new Comfortable default (% and ch aren't comparable).
        const next: Record<string, unknown> = { ...parsed, schemaVersion: 12 };
        // Cross-branch guard (mirrors the v9 reconciliation below): if a parallel
        // branch already wrote `editorMeasure` at v11, keep it — only synthesize
        // from the legacy field when the new one is absent.
        if (next.editorMeasure === undefined) {
          // An absent legacy field means the width was never customized (the v11
          // default was 100), so it's treated the same as an explicit 100 → "full".
          // Only an explicit non-100 width is an intentional customization that
          // gets the approximate reset to the new Comfortable default.
          const pct = parsed.editorWidthPercent;
          next.editorMeasure = pct === undefined || pct === 100 ? "full" : "comfortable";
        }
        // Explicit delete so the legacy field doesn't round-trip until the next
        // write; REMOVED_FIELDS additionally blocks it on the forward-compat path.
        delete next.editorWidthPercent;
        parsed = next;
      }
      // Cross-branch reconciliation guard (value-keyed, not version-keyed).
      // Parallel branches diverged on schemaVersion numbering, so a blob can
      // reach a version past v9 while still carrying the legacy
      // `showAnnotationDecorations` flag WITHOUT the v8→v9 split having run on it
      // (a pure version-bump step advanced it past v9 first). Re-derive the split
      // here, keyed on the field's value so an explicit "all marks off"
      // preference isn't silently reset to all-on. Only the `=== false` case is
      // lossy: true/absent already map onto the all-on defaults. No-op for blobs
      // that already split (per-type fields present). (`showAnnotationDecorations`
      // is dropped regardless by normalizeKnownFields, which only emits known keys.)
      if (parsed.showAnnotationDecorations === false && parsed.showComments === undefined) {
        parsed = { ...parsed, showComments: false, showHighlights: false, showNotes: false };
      }
      if (parsed.schemaVersion === 12) {
        // v12→v13: introduce `fontByExtension: {}` (#811). Cross-branch fold-in —
        // master shipped this as v9→v10, but the design-system umbrella had
        // independently used v10–v12, so it's renumbered to v13 to keep the chain
        // monotonic. Structural no-op; normalizeKnownFields runs
        // `parseFontByExtension`. Empty default keeps fresh-install behavior
        // intact (resolution falls back to defaults).
        parsed = { ...parsed, schemaVersion: 13 };
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
        // Surface forward-compat downgrades on closed-enum fields. Other
        // unknown future FIELDS pass through verbatim below (the futureFields
        // loop), but a closed-enum VALUE like `editorMeasure: "extra-wide"`
        // (introduced in a hypothetical v13) gets silently coerced to the
        // default by `normalizeKnownFields`. Without this warn the user
        // bouncing back to the older client would see "comfortable" with no
        // signal — indistinguishable from "user changed their mind." `_readOnly`
        // still blocks the write-back so the future-client state isn't damaged.
        const originalEditorMeasure = parsed.editorMeasure;
        const normalized = normalizeKnownFields(parsed);
        if (
          typeof originalEditorMeasure === "string" &&
          originalEditorMeasure !== normalized.editorMeasure
        ) {
          console.warn(
            `[tandem] editorMeasure=${JSON.stringify(originalEditorMeasure)} from newer client is unknown to v${CURRENT_SCHEMA_VERSION}; displaying as ${JSON.stringify(normalized.editorMeasure)} (your setting is preserved on-disk).`,
          );
        }
        // Preserve unknown future fields verbatim so a user bouncing back
        // to the newer client doesn't perceive a regression. `knownKeys`
        // is runtime-derived from the helper output (NOT the type), so
        // any field the current code doesn't actively normalize passes
        // through unmodified — exactly the contract `_readOnly: true`
        // advertises. Known fields are sanitized via the helper so
        // garbage like `accentHue: 9999` doesn't leak into the running UI.
        const knownKeys = new Set(Object.keys(normalized));
        // Explicitly-removed schema fields. Without this set, fields that
        // were stripped by a migration step (e.g. v4→v5 dropped
        // leftRailTabs / rightRailTabs, v5→v6 dropped showIntegrationWizard)
        // would leak through as "future fields" on a v99 forward-compat
        // blob, silently pinning a contract the migration intends to retire
        // and inheriting stale state into any future schema that reuses the
        // names.
        // One-way ratchet: removing an entry from this set requires bumping
        // CURRENT_SCHEMA_VERSION such that no older client ever observes
        // the resurrected field name on a write-through round-trip.
        const REMOVED_FIELDS = new Set([
          "leftRailTabs",
          "rightRailTabs",
          "showIntegrationWizard",
          "showAnnotationDecorations",
          "editorWidthPercent",
        ]);
        const futureFields: Record<string, unknown> = {};
        for (const [k, v] of Object.entries(parsed)) {
          if (!knownKeys.has(k) && k !== "_readOnly" && !REMOVED_FIELDS.has(k)) {
            futureFields[k] = v;
          }
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
  const parsedModels = parseModels(merged.models);
  return {
    ...merged,
    // Re-run the shape filter so a partial/corrupt in-memory update can't
    // persist a junk or reserved-colliding override. Callers pass the WHOLE
    // map (shallow-merge), so this validates the full set on every write.
    customShortcuts: parseCustomShortcuts(merged.customShortcuts),
    // Re-validate per-format overrides so a partial update can't persist a
    // junk value (e.g. `{ md: "comic-sans" }`).
    fontByExtension: parseFontByExtension(merged.fontByExtension),
    selectionDwellMs: Math.max(
      SELECTION_DWELL_MIN_MS,
      Math.min(SELECTION_DWELL_MAX_MS, merged.selectionDwellMs),
    ),
    accentHue: Number.isFinite(merged.accentHue)
      ? Math.max(0, Math.min(360, merged.accentHue))
      : DEFAULTS.accentHue,
    // Closed enum: an `as EditorMeasure` cast at a call site or a JSON-imported
    // preset payload can land a bogus string here. Reuse the on-load validator
    // so the clamp-on-write contract holds for `editorMeasure` the same way it
    // already holds for `accentHue` / `selectionDwellMs` / `defaultModelId`.
    editorMeasure: isEditorMeasure(merged.editorMeasure)
      ? merged.editorMeasure
      : DEFAULTS.editorMeasure,
    degradedBannerDelayMs: Math.max(5000, Math.min(120000, merged.degradedBannerDelayMs)),
    // Re-run the shape filter on `models` so an unsafe partial update (e.g.
    // hand-rolled call site that pushes an object missing `enabled`) can't
    // corrupt the array between persisted reads. `parseModels` strips
    // `_legacyApiKey` / `apiKey` plaintext fields, so persisted blobs never
    // re-acquire the legacy shape post-migration.
    models: parsedModels,
    // `defaultModelId` referential integrity: a stale id (entry deleted in
    // the same update, hand-edited blob, etc.) is coerced to `null` so
    // downstream consumers don't have to defend.
    defaultModelId:
      typeof merged.defaultModelId === "string" &&
      parsedModels.some((m) => m.id === merged.defaultModelId)
        ? merged.defaultModelId
        : null,
  };
}

/**
 * Resolve the effective editor font for a document of the given normalized
 * `format` (`md` / `docx` / `html` / `txt` — see `detectFormat`).
 *
 * Resolution (post-#811 follow-up): two tiers only.
 *
 *   1. Per-format user override (`settings.fontByExtension[format]`)
 *   2. Global setting (`settings.editorFont`)
 *
 * The previous third tier — `DEFAULT_FONT_BY_EXTENSION[format]` — was
 * removed. Seeded defaults silently overrode the user's global pick
 * for un-customized formats: changing the global font in Settings did
 * nothing for `.docx` / `.html` / `.txt` until the user also clicked
 * through every per-format radio group. The new contract: the global
 * setting is the true default; per-format overrides exist only where
 * the user has explicitly chosen one.
 *
 * A `null`/`undefined` format (no active tab) skips straight to the
 * global setting so the root font is never undefined during a Y.Doc swap.
 */
export function resolveFont(
  settings: Pick<TandemSettings, "fontByExtension" | "editorFont">,
  format: string | null | undefined,
): EditorFont {
  if (format) {
    const override = settings.fontByExtension?.[format];
    if (override) return override;
  }
  return settings.editorFont;
}
