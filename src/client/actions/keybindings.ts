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
  "new-tab-menu",
] as const;

export type RemappableShortcutId = (typeof REMAPPABLE_SHORTCUT_IDS)[number];

const REMAPPABLE_ID_SET: ReadonlySet<string> = new Set(REMAPPABLE_SHORTCUT_IDS);

export function isRemappableShortcutId(id: string): id is RemappableShortcutId {
  return REMAPPABLE_ID_SET.has(id);
}

/** Human label per remappable id. Used by the editor list and conflict
 * messages. Kept local (not sourced from the registry) because three remappable
 * ids — `toggle-palette`, `comment-on-selection`, and `new-tab-menu` — have no
 * registry row. */
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
  "new-tab-menu": "New tab menu",
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
  "new-tab-menu": { ctrlOrMeta: true, alt: false, shift: false, code: "KeyT" },
};

/**
 * Chords a remap must NOT steal that the App keydown matcher does NOT itself
 * claim. Fixed *matcher* branches (find, find-nav, accept/dismiss, pick-tab,
 * select-all, help) are no longer listed here — `claimedByFixedShortcut`
 * (`shortcut-conflicts.ts`) derives those live from `matchShortcut`, as
 * *families* (so every modifier variant a loose branch claims is covered, not
 * just the canonical tuple). This list is only the reservations that live
 * OUTSIDE the matcher:
 *  1. Separate window listeners: tab-cycle (`useTabCycleKeyboard.svelte.ts`)
 *     and WebView zoom (`useWebViewZoom.svelte.ts`, Tauri-only). The zoom
 *     listener matches on `e.key`; we translate to `e.code`: Ctrl+0 → Digit0,
 *     zoom-in (`+`/`=`, incl. `Ctrl+Shift+=`) → Equal, zoom-out (`-`/`_`,
 *     incl. `Ctrl+Shift+-`) → Minus.
 *  2. Tiptap / editor keymaps (StarterKit + extension-link). These live inside
 *     the extensions' own `addKeyboardShortcuts()` internals with no
 *     machine-readable export, so this slice is a REVIEWED, version-pinned
 *     constant (`@tiptap/starter-kit` + `@tiptap/extension-link` in
 *     package.json). A Tiptap MAJOR bump requires re-auditing this list. The
 *     Tiptap heading (`Ctrl+Alt+1..6`) and list (`Ctrl+Shift+7/8`) chords are
 *     omitted because the matcher's pick-tab family already claims every
 *     `Ctrl+Digit1..9`, so `claimedByFixedShortcut` covers them. (`Ctrl+Digit0`
 *     is NOT pick-tab — it is reserved separately below as Reset zoom.)
 *
 * Note: `Ctrl+Alt+M` is NOT reserved here — it is the default of the
 * remappable `comment-on-selection`, not a separate editor binding.
 */
export const RESERVED_CHORDS: ReadonlyArray<{ chord: ShortcutChord; label: string }> = [
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
  { chord: { ctrlOrMeta: true, alt: false, shift: true, code: "Equal" }, label: "Zoom in" },
  { chord: { ctrlOrMeta: true, alt: false, shift: false, code: "Minus" }, label: "Zoom out" },
  { chord: { ctrlOrMeta: true, alt: false, shift: true, code: "Minus" }, label: "Zoom out" },
  // ---- Tiptap / editor keymaps (reviewed, version-pinned) ----
  { chord: { ctrlOrMeta: true, alt: false, shift: false, code: "KeyB" }, label: "Bold" },
  { chord: { ctrlOrMeta: true, alt: false, shift: false, code: "KeyI" }, label: "Italic" },
  { chord: { ctrlOrMeta: true, alt: false, shift: false, code: "KeyE" }, label: "Inline code" },
  { chord: { ctrlOrMeta: true, alt: false, shift: true, code: "KeyX" }, label: "Strikethrough" },
  { chord: { ctrlOrMeta: true, alt: false, shift: false, code: "KeyZ" }, label: "Undo" },
  { chord: { ctrlOrMeta: true, alt: false, shift: false, code: "KeyY" }, label: "Redo" },
  { chord: { ctrlOrMeta: true, alt: false, shift: true, code: "KeyZ" }, label: "Redo" },
  { chord: { ctrlOrMeta: true, alt: false, shift: false, code: "KeyK" }, label: "Add link" },
  { chord: { ctrlOrMeta: true, alt: false, shift: true, code: "KeyB" }, label: "Blockquote" },
];

/** Crosswalk from registry action id → RemappableShortcutId for Help / catalog
 * reflection. Registry ids differ from matcher ids; the one spelling mismatch
 * is `annotation-previous` (registry) → `annotation-prev` (matcher).
 * `toggle-palette`, `comment-on-selection`, and `new-tab-menu` have no registry row. */
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
 * Whether a chord is one a user is allowed to bind, independent of where it
 * came from. Shared by `chordFromEvent` (UI recording) and
 * `parseCustomShortcuts` (load/merge) so a hand-edited or imported settings
 * blob can't smuggle in a chord the recording UI would have rejected. Rejects:
 *  - pure modifier codes (Ctrl/Shift/Alt/Meta alone);
 *  - Numpad keys and reserved nav/edit keys (Tab/Escape/Enter/…);
 *  - chords without a primary modifier (Ctrl/Meta OR Alt) — a bare or
 *    Shift-only single key would fire during normal text entry.
 */
export function isBindableChord(c: ShortcutChord): boolean {
  if (KEYBOARD_EVENT_MODIFIER_CODES.test(c.code)) return false;
  if (c.code.startsWith("Numpad")) return false;
  if (UNBINDABLE_CODES.has(c.code)) return false;
  return c.ctrlOrMeta || c.alt;
}

/**
 * Derive a bindable chord from a keydown event, or `null` if the event is not
 * a valid capture (see `isBindableChord` for the rules; dead keys are also
 * rejected here since they only manifest at event time).
 */
export function chordFromEvent(e: KeyboardEventLikeForChord): ShortcutChord | null {
  if (!e.code) return null;
  if (e.key === "Dead") return null;
  const chord: ShortcutChord = {
    ctrlOrMeta: e.ctrlKey || e.metaKey,
    alt: e.altKey,
    shift: e.shiftKey,
    code: e.code,
  };
  return isBindableChord(chord) ? chord : null;
}

/** Strict equality on all four fields. At-most-one-override-per-event needs
 * BOTH halves: strict equality here (so one event can't loosely match two
 * different chords) AND the `parseCustomShortcuts` dedupe (so the override map
 * never holds two ids on one chord). Neither alone suffices; keep both. */
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

export function isMacPlatform(): boolean {
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
 * `findConflict`, `parseCustomShortcuts`, and `buildOverrides` moved to
 * `shortcut-conflicts.ts` (ADR-041) — they consult the matcher
 * (`matchShortcut`) to derive fixed-branch conflicts as the single source of
 * truth, which would create a circular import if they stayed here (this module
 * is a leaf that `useAppShortcuts.ts` imports from). Pure model/format helpers
 * stay here.
 */

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
