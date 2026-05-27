/**
 * Customizable keyboard shortcuts — pure binding model (ADR-041).
 *
 * The real key→action mapping lives in `matchShortcut()`
 * (`src/client/hooks/useAppShortcuts.ts`) as a hand-ordered if/else chain with
 * deliberately-preserved legacy quirks. Rather than rewrite that chain, this
 * module adds an *override layer*: a user-remapped chord is matched FIRST and
 * wins; the default chain still runs (with per-branch guards) for every
 * shortcut the user has NOT remapped, so non-remappers see zero behavior
 * change. ADR-029 declared the registry `shortcut` field display-only; that is
 * superseded in part here for the App-level discrete shortcuts below.
 *
 * Scope: only the App-level discrete (single-chord) shortcuts are remappable.
 * Text-formatting / Tiptap keymaps and the family/context shortcuts
 * (`Ctrl+1..9` tab picks, find scope/direction, accept/dismiss) stay fixed.
 *
 * `code` is the PHYSICAL key (`"KeyS"`, `"Digit1"`, `"BracketLeft"`,
 * `"ArrowLeft"`, `"Comma"`) — never `e.key` — mirroring the matcher's
 * layout-independence design (Dvorak / AZERTY / macOS Option-letter safe).
 */

export interface ShortcutChord {
  /** True if Ctrl (any platform) OR Meta/⌘ was held. The matcher treats them
   * interchangeably (`mod = e.ctrlKey || e.metaKey`), so we collapse them. */
  ctrlOrMeta: boolean;
  alt: boolean;
  shift: boolean;
  /** Physical key code, e.g. "KeyS", "Digit1", "ArrowLeft", "Comma". */
  code: string;
}

export const REMAPPABLE_SHORTCUT_IDS = [
  "save",
  "save-as",
  "settings",
  "settings-modal",
  "toggle-palette",
  "new-scratchpad",
  "close-tab",
  "open-file",
  "toggle-mode",
  "reopen-closed-tab",
  "comment-on-selection",
  "toggle-authorship",
  "toggle-left-panel",
  "toggle-right-panel",
  "annotation-next",
  "annotation-prev",
  "select-block",
] as const;

export type RemappableShortcutId = (typeof REMAPPABLE_SHORTCUT_IDS)[number];

const REMAPPABLE_ID_SET: ReadonlySet<string> = new Set(REMAPPABLE_SHORTCUT_IDS);

export function isRemappableShortcutId(id: string): id is RemappableShortcutId {
  return REMAPPABLE_ID_SET.has(id);
}

/** Human label per remappable id. Used by the editor list and conflict
 * messages. Kept local (not sourced from the registry) because two remappable
 * ids — `toggle-palette` and `comment-on-selection` — have no registry row. */
export const REMAPPABLE_LABELS: Record<RemappableShortcutId, string> = {
  save: "Save document",
  "save-as": "Save As…",
  settings: "Open settings",
  "settings-modal": "Open settings (new)",
  "toggle-palette": "Toggle command palette",
  "new-scratchpad": "New Scratchpad",
  "close-tab": "Close active tab",
  "open-file": "Open file…",
  "toggle-mode": "Toggle Solo / Tandem mode",
  "reopen-closed-tab": "Reopen closed tab",
  "comment-on-selection": "Comment on selection",
  "toggle-authorship": "Toggle authorship colors",
  "toggle-left-panel": "Toggle left panel",
  "toggle-right-panel": "Toggle right panel",
  "annotation-next": "Next annotation",
  "annotation-prev": "Previous annotation",
  "select-block": "Select containing block",
};

/**
 * Default chord for each remappable id, transcribed from the exact modifier
 * sets the matcher's default branches accept (see `useAppShortcuts.ts`).
 *
 * These are drift-tested: each chord, synthesized into a KeyboardEvent, must
 * round-trip back through `matchShortcut` (no overrides) to its own id. That
 * catches ordering quirks — e.g. `toggle-authorship` (Ctrl+Alt+A) is only
 * reachable because the `select-all` branch requires `!alt`, and the alt-only
 * block requires `!ctrlOrMeta`.
 */
export const DEFAULT_BINDINGS: Record<RemappableShortcutId, ShortcutChord> = {
  save: { ctrlOrMeta: true, alt: false, shift: false, code: "KeyS" },
  "save-as": { ctrlOrMeta: true, alt: false, shift: true, code: "KeyS" },
  settings: { ctrlOrMeta: true, alt: false, shift: false, code: "Comma" },
  "settings-modal": { ctrlOrMeta: true, alt: false, shift: true, code: "Comma" },
  "toggle-palette": { ctrlOrMeta: true, alt: false, shift: true, code: "KeyP" },
  "new-scratchpad": { ctrlOrMeta: true, alt: false, shift: false, code: "KeyN" },
  "close-tab": { ctrlOrMeta: true, alt: false, shift: false, code: "KeyW" },
  "open-file": { ctrlOrMeta: true, alt: false, shift: false, code: "KeyO" },
  "toggle-mode": { ctrlOrMeta: true, alt: false, shift: true, code: "KeyM" },
  "reopen-closed-tab": { ctrlOrMeta: true, alt: true, shift: false, code: "KeyT" },
  "comment-on-selection": { ctrlOrMeta: true, alt: true, shift: false, code: "KeyM" },
  "toggle-authorship": { ctrlOrMeta: true, alt: true, shift: false, code: "KeyA" },
  "toggle-left-panel": { ctrlOrMeta: false, alt: true, shift: true, code: "ArrowLeft" },
  "toggle-right-panel": { ctrlOrMeta: false, alt: true, shift: true, code: "ArrowRight" },
  "annotation-next": { ctrlOrMeta: false, alt: true, shift: false, code: "BracketRight" },
  "annotation-prev": { ctrlOrMeta: false, alt: true, shift: false, code: "BracketLeft" },
  "select-block": { ctrlOrMeta: false, alt: true, shift: false, code: "KeyL" },
};

/**
 * Chords a remap must NOT steal. Three sources:
 *  1. Fixed matcher branches (find, find-nav, accept/dismiss, pick-tab,
 *     select-all, Ctrl+/ help) — these can't be overridden, so blocking is
 *     the only protection.
 *  2. Separate window listeners that aren't in the matcher at all: tab-cycle
 *     (`useTabCycleKeyboard.svelte.ts`) and WebView zoom
 *     (`useWebViewZoom.svelte.ts`, Tauri-only). The zoom listener matches on
 *     `e.key`; we translate to `e.code`: Ctrl+0 → Digit0, zoom-in (`+`/`=`) →
 *     Equal, zoom-out (`-`/`_`) → Minus.
 *  3. Tiptap / editor keymaps (StarterKit + extension-link). These live inside
 *     the extensions' own `addKeyboardShortcuts()` internals with no
 *     machine-readable export, so this slice is a REVIEWED, version-pinned
 *     constant (`@tiptap/starter-kit` + `@tiptap/extension-link` in
 *     package.json). A Tiptap MAJOR bump requires re-auditing this list.
 *
 * Note: `Ctrl+Alt+M` is NOT reserved here — it is the default of the
 * remappable `comment-on-selection`, not a separate editor binding.
 */
export const RESERVED_CHORDS: ReadonlyArray<{ chord: ShortcutChord; label: string }> = [
  // ---- Fixed matcher branches ----
  { chord: { ctrlOrMeta: true, alt: false, shift: false, code: "KeyA" }, label: "Select all" },
  { chord: { ctrlOrMeta: true, alt: false, shift: false, code: "KeyF" }, label: "Find / Replace" },
  {
    chord: { ctrlOrMeta: true, alt: false, shift: true, code: "KeyF" },
    label: "Find in open tabs",
  },
  { chord: { ctrlOrMeta: true, alt: false, shift: false, code: "KeyG" }, label: "Find next" },
  { chord: { ctrlOrMeta: true, alt: false, shift: true, code: "KeyG" }, label: "Find previous" },
  {
    chord: { ctrlOrMeta: true, alt: false, shift: false, code: "Enter" },
    label: "Accept annotation",
  },
  {
    chord: { ctrlOrMeta: true, alt: false, shift: true, code: "Enter" },
    label: "Dismiss annotation",
  },
  {
    chord: { ctrlOrMeta: true, alt: false, shift: false, code: "Slash" },
    label: "Show keyboard shortcuts",
  },
  // pick-tab family: Ctrl+1..9
  ...Array.from({ length: 9 }, (_, i) => ({
    chord: { ctrlOrMeta: true, alt: false, shift: false, code: `Digit${i + 1}` },
    label: `Jump to tab ${i + 1}`,
  })),
  // ---- Separate window listeners ----
  {
    chord: { ctrlOrMeta: true, alt: false, shift: false, code: "Tab" },
    label: "Next document tab",
  },
  {
    chord: { ctrlOrMeta: true, alt: false, shift: true, code: "Tab" },
    label: "Previous document tab",
  },
  { chord: { ctrlOrMeta: true, alt: false, shift: false, code: "Digit0" }, label: "Reset zoom" },
  { chord: { ctrlOrMeta: true, alt: false, shift: false, code: "Equal" }, label: "Zoom in" },
  { chord: { ctrlOrMeta: true, alt: false, shift: false, code: "Minus" }, label: "Zoom out" },
  // ---- Tiptap / editor keymaps (reviewed, version-pinned) ----
  { chord: { ctrlOrMeta: true, alt: false, shift: false, code: "KeyB" }, label: "Bold" },
  { chord: { ctrlOrMeta: true, alt: false, shift: false, code: "KeyI" }, label: "Italic" },
  { chord: { ctrlOrMeta: true, alt: false, shift: false, code: "KeyE" }, label: "Inline code" },
  { chord: { ctrlOrMeta: true, alt: false, shift: true, code: "KeyX" }, label: "Strikethrough" },
  { chord: { ctrlOrMeta: true, alt: false, shift: false, code: "KeyZ" }, label: "Undo" },
  { chord: { ctrlOrMeta: true, alt: false, shift: false, code: "KeyY" }, label: "Redo" },
  { chord: { ctrlOrMeta: true, alt: false, shift: true, code: "KeyZ" }, label: "Redo" },
  { chord: { ctrlOrMeta: true, alt: false, shift: false, code: "KeyK" }, label: "Add link" },
  { chord: { ctrlOrMeta: true, alt: false, shift: true, code: "Digit7" }, label: "Ordered list" },
  { chord: { ctrlOrMeta: true, alt: false, shift: true, code: "Digit8" }, label: "Bullet list" },
  { chord: { ctrlOrMeta: true, alt: false, shift: true, code: "KeyB" }, label: "Blockquote" },
  ...Array.from({ length: 6 }, (_, i) => ({
    chord: { ctrlOrMeta: true, alt: true, shift: false, code: `Digit${i + 1}` },
    label: `Heading ${i + 1}`,
  })),
];

/** Crosswalk from registry action id → RemappableShortcutId for Help / catalog
 * reflection. Registry ids differ from matcher ids; the one spelling mismatch
 * is `annotation-previous` (registry) → `annotation-prev` (matcher).
 * `toggle-palette` and `comment-on-selection` have no registry row. */
export const REGISTRY_TO_SHORTCUT_ID: Record<string, RemappableShortcutId> = {
  save: "save",
  "save-as": "save-as",
  settings: "settings",
  "settings-modal": "settings-modal",
  "new-scratchpad": "new-scratchpad",
  "close-tab": "close-tab",
  "open-file": "open-file",
  "toggle-mode": "toggle-mode",
  "reopen-closed-tab": "reopen-closed-tab",
  "toggle-authorship": "toggle-authorship",
  "toggle-left-panel": "toggle-left-panel",
  "toggle-right-panel": "toggle-right-panel",
  "annotation-next": "annotation-next",
  "annotation-previous": "annotation-prev",
  "select-block": "select-block",
};

const KEYBOARD_EVENT_MODIFIER_CODES = /^(Control|Shift|Alt|Meta|OS)/;

/** Codes we never let a user bind, even with a modifier: reserved navigation /
 * editing keys whose default behavior we must not shadow, plus dead keys. */
const UNBINDABLE_CODES: ReadonlySet<string> = new Set([
  "Tab",
  "Escape",
  "Enter",
  "NumpadEnter",
  "NumLock",
  "CapsLock",
  "ContextMenu",
  "Insert",
]);

export interface KeyboardEventLikeForChord {
  key: string;
  code: string;
  ctrlKey: boolean;
  metaKey: boolean;
  altKey: boolean;
  shiftKey: boolean;
}

/**
 * Derive a bindable chord from a keydown event, or `null` if the event is not
 * a valid capture. Rejects:
 *  - pure modifier presses (Ctrl/Shift/Alt/Meta alone);
 *  - bare or Shift-only single keys (requires Ctrl/Meta OR Alt, so the capture
 *    is an actual chord, not plain typing);
 *  - Numpad keys, dead keys, and reserved nav/edit keys (Tab/Escape/Enter/…).
 */
export function chordFromEvent(e: KeyboardEventLikeForChord): ShortcutChord | null {
  if (!e.code) return null;
  if (KEYBOARD_EVENT_MODIFIER_CODES.test(e.code)) return null;
  if (e.key === "Dead") return null;
  if (e.code.startsWith("Numpad")) return null;
  if (UNBINDABLE_CODES.has(e.code)) return null;
  const ctrlOrMeta = e.ctrlKey || e.metaKey;
  // Require a primary modifier so we never capture plain typing or Shift-only
  // single keys (which would fire during normal text entry).
  if (!ctrlOrMeta && !e.altKey) return null;
  return { ctrlOrMeta, alt: e.altKey, shift: e.shiftKey, code: e.code };
}

/** Strict equality on all four fields. MUST stay strict: the matcher's
 * override-first loop relies on two distinct chords never both matching one
 * event, which makes Map iteration order irrelevant to correctness. */
export function chordMatches(chord: ShortcutChord, e: KeyboardEventLikeForChord): boolean {
  return (
    chord.ctrlOrMeta === (e.ctrlKey || e.metaKey) &&
    chord.alt === e.altKey &&
    chord.shift === e.shiftKey &&
    chord.code === e.code
  );
}

export function chordsEqual(a: ShortcutChord, b: ShortcutChord): boolean {
  return (
    a.ctrlOrMeta === b.ctrlOrMeta && a.alt === b.alt && a.shift === b.shift && a.code === b.code
  );
}

/** Runtime shape guard for a value loaded from localStorage. */
export function isValidChord(x: unknown): x is ShortcutChord {
  if (!x || typeof x !== "object") return false;
  const c = x as Record<string, unknown>;
  return (
    typeof c.ctrlOrMeta === "boolean" &&
    typeof c.alt === "boolean" &&
    typeof c.shift === "boolean" &&
    typeof c.code === "string" &&
    c.code.length > 0 &&
    c.code.length <= 32
  );
}

function isMacPlatform(): boolean {
  try {
    if (typeof navigator === "undefined") return false;
    const plat =
      (navigator as Navigator & { userAgentData?: { platform?: string } }).userAgentData
        ?.platform ?? navigator.platform;
    return /Mac|iPhone|iPad|iPod/i.test(plat ?? "");
  } catch {
    return false;
  }
}

/** Map a physical `code` to a readable key label. */
function codeLabel(code: string): string {
  if (code.startsWith("Key")) return code.slice(3);
  if (code.startsWith("Digit")) return code.slice(5);
  const named: Record<string, string> = {
    Comma: ",",
    Period: ".",
    Slash: "/",
    Backslash: "\\",
    Semicolon: ";",
    Quote: "'",
    BracketLeft: "[",
    BracketRight: "]",
    Backquote: "`",
    Minus: "-",
    Equal: "=",
    Space: "Space",
    Tab: "Tab",
    Enter: "Enter",
    ArrowLeft: "←",
    ArrowRight: "→",
    ArrowUp: "↑",
    ArrowDown: "↓",
  };
  return named[code] ?? code;
}

/** Human-readable label for a chord (e.g. "Ctrl+Shift+S" or "⌘⇧S" on macOS). */
export function formatChord(chord: ShortcutChord): string {
  const mac = isMacPlatform();
  const parts: string[] = [];
  if (chord.ctrlOrMeta) parts.push(mac ? "⌘" : "Ctrl");
  if (chord.alt) parts.push(mac ? "⌥" : "Alt");
  if (chord.shift) parts.push(mac ? "⇧" : "Shift");
  parts.push(codeLabel(chord.code));
  return mac ? parts.join("") : parts.join("+");
}

/** Effective chord for an id given the current overrides. */
export function effectiveChord(
  id: RemappableShortcutId,
  overrides: ReadonlyMap<RemappableShortcutId, ShortcutChord>,
): ShortcutChord {
  return overrides.get(id) ?? DEFAULT_BINDINGS[id];
}

/**
 * Find what currently owns `chord`, or `null` if free. Checks every
 * remappable id's *effective* binding (override ?? default) except `excludeId`,
 * then the reserved set. Returns the owner's human label.
 */
export function findConflict(
  chord: ShortcutChord,
  overrides: ReadonlyMap<RemappableShortcutId, ShortcutChord>,
  excludeId: RemappableShortcutId,
): string | null {
  for (const id of REMAPPABLE_SHORTCUT_IDS) {
    if (id === excludeId) continue;
    if (chordsEqual(effectiveChord(id, overrides), chord)) return REMAPPABLE_LABELS[id];
  }
  for (const reserved of RESERVED_CHORDS) {
    if (chordsEqual(reserved.chord, chord)) return reserved.label;
  }
  return null;
}

/**
 * Validate a persisted `customShortcuts` blob, dropping any entry whose key
 * isn't a remappable id, whose value isn't a well-formed chord, or that now
 * collides with a reserved chord. The reserved-collision drop closes the
 * stale-override gap: if a future version grows the reserved set, an override
 * stored under the old version that now shadows a new fixed shortcut is
 * dropped at load instead of silently winning via the override-first loop.
 */
export function parseCustomShortcuts(raw: unknown): Record<string, ShortcutChord> {
  const out: Record<string, ShortcutChord> = {};
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return out;
  for (const [key, value] of Object.entries(raw as Record<string, unknown>)) {
    if (!isRemappableShortcutId(key)) continue;
    if (!isValidChord(value)) continue;
    if (RESERVED_CHORDS.some((r) => chordsEqual(r.chord, value))) continue;
    out[key] = value;
  }
  return out;
}

/**
 * Build the runtime override map from the persisted `customShortcuts` record.
 * Returns a fresh Map each call (cheap — ≤17 entries).
 */
export function buildOverrides(
  customShortcuts: Record<string, unknown> | undefined,
): ReadonlyMap<RemappableShortcutId, ShortcutChord> {
  const out = new Map<RemappableShortcutId, ShortcutChord>();
  const parsed = parseCustomShortcuts(customShortcuts);
  for (const [key, value] of Object.entries(parsed)) {
    out.set(key as RemappableShortcutId, value);
  }
  return out;
}

/** Effective formatted label per remappable id, for Help / catalog reflection. */
export function effectiveBindingLabels(
  overrides: ReadonlyMap<RemappableShortcutId, ShortcutChord>,
): Map<RemappableShortcutId, string> {
  const out = new Map<RemappableShortcutId, string>();
  for (const id of REMAPPABLE_SHORTCUT_IDS) {
    out.set(id, formatChord(effectiveChord(id, overrides)));
  }
  return out;
}
