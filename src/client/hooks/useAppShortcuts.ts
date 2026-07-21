/**
 * Pure keyboard-event-to-shortcut matcher for the App-level keydown handler.
 *
 * Extracted from `App.svelte` to make the cross-platform / layout-independent
 * matching logic testable in isolation. The dispatch table (the actual side
 * effects — editor focus, modal state, findState branches) stays in
 * `App.svelte` so the helper itself is pure and the run logic still owns the
 * reactive state.
 *
 * Layout-independence guarantees:
 *  - Letter shortcuts match on `e.code` ("KeyA"…), not `e.key`, so Dvorak /
 *    AZERTY users hit the right shortcut and macOS Option-letter chords don't
 *    miss because Option produces alt chars like "†"/"µ".
 *  - Digit shortcuts also match on `e.code` ("Digit1"…).
 *  - Bracket shortcuts match on `e.code` ("BracketLeft"/"BracketRight") so the
 *    macOS Alt-bracket chord (Alt+[ → '"', Alt+] → '"') doesn't miss.
 *  - Arrow / Enter / Comma / Slash / Question shortcuts that have no
 *    layout-variation use `e.key` (or the appropriate `e.code`).
 *
 * Context fields:
 *  - `shift` — whether Shift was held. Reused across find (scope: "doc" vs
 *    "tabs"), find-nav (find-next vs find-prev), and accept-or-dismiss
 *    (Ctrl+Enter accept vs dismiss), so the dispatch doesn't re-read the event.
 *  - `tabIndex` — 1-based digit so the dispatch can pick the right tab.
 *
 * The branches that depend on _other_ runtime state (outline visibility for
 * Ctrl+F, find query for Ctrl+G, selection / read-only / toolbar gate for
 * Ctrl+Alt+M) live in the dispatch table, not in the matcher.
 */

import {
  chordMatches,
  REMAPPABLE_SHORTCUT_IDS,
  type RemappableShortcutId,
  type ShortcutChord,
} from "../actions/keybindings.js";

export type ShortcutId =
  // bare "?" or Ctrl+/ — show keyboard shortcuts modal
  | "toggle-help"
  // ctrl/meta + letter
  | "select-all"
  | "save"
  | "save-as"
  | "settings"
  | "toggle-palette"
  | "new-scratchpad"
  | "close-tab"
  | "open-file"
  | "pick-tab"
  | "toggle-mode"
  | "reopen-closed-tab"
  | "new-tab-menu"
  | "find"
  | "find-nav"
  | "annotation-accept-or-dismiss"
  | "comment-on-selection"
  | "toggle-authorship"
  // alt-only (no ctrl/meta)
  | "toggle-left-panel"
  | "toggle-right-panel"
  | "annotation-next"
  | "annotation-prev"
  | "select-block";

/**
 * Context payload carried alongside `id`. Optional — only shortcuts that
 * branch on event state populate it.
 *
 * The matcher returns `undefined` context for shortcuts whose dispatch only
 * depends on external runtime state (outline visibility, find query, etc.).
 */
export interface ShortcutContext {
  /** 1-based tab index for `pick-tab` (Ctrl+1..9). */
  tabIndex?: number;
  /** True if Shift was held — used by `find` (doc vs tabs scope), `find-nav`
   * (next vs prev), and `annotation-accept-or-dismiss` (accept vs dismiss). */
  shift?: boolean;
}

export interface ShortcutMatch {
  id: ShortcutId;
  context?: ShortcutContext;
}

/**
 * Subset of `KeyboardEvent` we inspect — keeps the helper trivially testable
 * with plain object literals.
 */
export type KeyboardEventLike = Pick<
  KeyboardEvent,
  "key" | "code" | "ctrlKey" | "metaKey" | "altKey" | "shiftKey"
> & {
  isComposing?: boolean;
};

/**
 * Returns the matched shortcut id (and any event-derived context) for a
 * keydown event, or `null` if the event isn't one of the App-level shortcuts.
 *
 * Pure: reads only the event, never touches editor / DOM / app state. The
 * caller is responsible for `preventDefault()` and for any runtime-state
 * branches (outline visibility, find query, selection, etc.).
 *
 * Note: this helper does NOT apply input-field suppression
 * (`shouldIgnoreShortcut`) or the "?" `INPUT/TEXTAREA/contenteditable`
 * guard — those depend on `e.target`, which the dispatch table handles per
 * shortcut. Centralizing the suppression here would over-suppress
 * shortcuts that intentionally fire in form fields (Ctrl+S, Ctrl+F, etc.).
 */
/**
 * Typed guard for the in-place fall-through guards below. Using this (rather
 * than a bare `overrides?.has(...)`) keeps each guard's id literal checked
 * against `RemappableShortcutId` — a typo is a compile error, not a silent
 * no-op that would leave a remapped default still firing.
 */
function isOverridden(
  id: RemappableShortcutId,
  overrides: ReadonlyMap<RemappableShortcutId, ShortcutChord> | undefined,
): boolean {
  return overrides ? overrides.has(id) : false;
}

export function matchShortcut(
  e: KeyboardEventLike,
  overrides?: ReadonlyMap<RemappableShortcutId, ShortcutChord>,
): ShortcutMatch | null {
  // IME composition: never dispatch a shortcut mid-composition.
  if (e.isComposing) return null;

  // Override layer wins first. The persisted override map is deduped by chord
  // at load (`parseCustomShortcuts` keeps the entry earliest in
  // `REMAPPABLE_SHORTCUT_IDS` order), so no two ids can share a chord — which
  // is the real hazard, not "two distinct chords matching one event". With
  // duplicates impossible, this loop's order is deterministic and fires the
  // same id that the load-time dedupe kept. A remapped combo short-circuits the
  // entire legacy chain below.
  if (overrides && overrides.size > 0) {
    for (const id of REMAPPABLE_SHORTCUT_IDS) {
      const chord = overrides.get(id);
      if (chord && chordMatches(chord, e)) return { id };
    }
  }

  const mod = e.ctrlKey || e.metaKey;

  // "?" → toggle help. Legacy outermost handler had NO modifier gate; preserve
  // that so Ctrl+Shift+/ (which produces e.key === "?" on US layouts) still
  // routes to help. The Option+t-produces-"†" negative regression guard works
  // because e.key === "†" doesn't match "?" — the matcher reads e.key, not a
  // character-class.
  if (e.key === "?") {
    return { id: "toggle-help" };
  }

  // ---- ctrl/meta block ----------------------------------------------------
  // Faithful to the legacy else-if chain ordering. Most legacy branches did NOT
  // gate on altKey or shiftKey — only KeyA (select-all), the explicit Shift+M
  // (toggle-mode), and Shift+P (toggle-palette) had explicit modifier gates.
  // Preserving the no-gate semantics keeps shortcuts like Ctrl+Alt+S → save
  // unchanged from the original (intentional or not), so the existing E2E
  // suite still passes.
  if (mod) {
    // Ctrl+, → Settings (the single consolidated modal). Rejects shift so the
    // shifted form is left unbound. Legacy `isSettingsShortcut`: rejects shift.
    if (!e.shiftKey && e.code === "Comma") {
      if (!isOverridden("settings", overrides)) return { id: "settings" };
    }

    // Ctrl+/ → toggle help. (Layout-stable; appears in the legacy chain after
    // the Comma branches, before KeyW/KeyO etc.)
    if (e.key === "/") {
      return { id: "toggle-help" };
    }

    // Ctrl+A (no Shift / Alt) → select-all. Legacy explicitly gated on
    // `!altKey && !shiftKey`; keep both gates so Ctrl+Alt+A still routes to
    // toggle-authorship and Ctrl+Shift+A doesn't accidentally claim select-all.
    if (!e.altKey && !e.shiftKey && e.code === "KeyA") {
      return { id: "select-all" };
    }

    // Ctrl+Shift+S → Save As… (scratchpad promotion). Checked before plain
    // Ctrl+S so the shift-bearing combo wins. `!altKey` so Ctrl+Shift+Alt+S
    // falls through to the ungated save branch (legacy behavior).
    if (e.shiftKey && !e.altKey && e.code === "KeyS") {
      if (!isOverridden("save-as", overrides)) return { id: "save-as" };
    }

    // Ctrl+S → save. Legacy: no modifier gate.
    if (e.code === "KeyS") {
      if (!isOverridden("save", overrides)) return { id: "save" };
    }

    // Ctrl+Shift+P → toggle palette. Legacy: `shiftKey && KeyP`, no alt gate.
    if (e.shiftKey && e.code === "KeyP") {
      if (!isOverridden("toggle-palette", overrides)) return { id: "toggle-palette" };
    }

    // Ctrl+N → new scratchpad. Legacy: no modifier gate.
    if (e.code === "KeyN") {
      if (!isOverridden("new-scratchpad", overrides)) return { id: "new-scratchpad" };
    }

    // Ctrl+W → close active tab. Legacy: no modifier gate.
    if (e.code === "KeyW") {
      if (!isOverridden("close-tab", overrides)) return { id: "close-tab" };
    }

    // Ctrl+O → open file dialog. Legacy: no modifier gate.
    if (e.code === "KeyO") {
      if (!isOverridden("open-file", overrides)) return { id: "open-file" };
    }

    // Ctrl+Digit[1-9] → pick tab. Legacy: no modifier gate.
    if (/^Digit[1-9]$/.test(e.code)) {
      return {
        id: "pick-tab",
        context: { tabIndex: Number(e.code.slice(5)) },
      };
    }

    // Ctrl+Shift+M (no Alt) → toggle Solo / Tandem. Explicit shift+!alt gate.
    if (e.shiftKey && !e.altKey && e.code === "KeyM") {
      if (!isOverridden("toggle-mode", overrides)) return { id: "toggle-mode" };
    }

    // Ctrl+Alt+T → reopen closed tab. Legacy: `altKey && KeyT`, no shift gate.
    if (e.altKey && e.code === "KeyT") {
      if (!isOverridden("reopen-closed-tab", overrides)) return { id: "reopen-closed-tab" };
    }

    // Ctrl+T → open the new-tab menu. Gated `!altKey` so Ctrl+Alt+T still routes
    // to reopen-closed-tab above (the two are mutually exclusive on altKey, so
    // relative order is immaterial); `!shiftKey` matches the default chord
    // exactly and leaves Ctrl+Shift+T inert.
    if (!e.altKey && !e.shiftKey && e.code === "KeyT") {
      if (!isOverridden("new-tab-menu", overrides)) return { id: "new-tab-menu" };
    }

    // Ctrl+F / Ctrl+Shift+F → find. Legacy outer if: no alt gate.
    if (e.code === "KeyF") {
      return { id: "find", context: { shift: e.shiftKey } };
    }

    // Ctrl+G / Ctrl+Shift+G → find-nav. Legacy: no alt gate.
    if (e.code === "KeyG") {
      return { id: "find-nav", context: { shift: e.shiftKey } };
    }

    // Ctrl+Enter / Ctrl+Shift+Enter → accept / dismiss. Legacy: no alt gate.
    // `e.key === "Enter"` is layout-stable so we don't need e.code here.
    if (e.key === "Enter") {
      return {
        id: "annotation-accept-or-dismiss",
        context: { shift: e.shiftKey },
      };
    }

    // Ctrl+Alt+M → comment-on-selection. Legacy outer if: `altKey && KeyM`,
    // no shift gate (so Ctrl+Alt+Shift+M also fires; matches legacy).
    if (e.altKey && e.code === "KeyM") {
      if (!isOverridden("comment-on-selection", overrides)) return { id: "comment-on-selection" };
    }

    // Ctrl+Alt+A → toggle-authorship. Legacy: `altKey && KeyA`, no shift gate.
    // Comes AFTER select-all (which requires !alt), so Ctrl+Alt+A correctly
    // routes here rather than to select-all.
    if (e.altKey && e.code === "KeyA") {
      if (!isOverridden("toggle-authorship", overrides)) return { id: "toggle-authorship" };
    }
  }

  // ---- alt-only block (no ctrl / meta) -----------------------------------
  if (e.altKey && !e.ctrlKey && !e.metaKey) {
    // Alt+Shift+ArrowLeft / Alt+Shift+ArrowRight → toggle left/right panel.
    // Plain Alt+Arrow stays available for browser history navigation.
    if (e.shiftKey) {
      if (e.code === "ArrowLeft" && !isOverridden("toggle-left-panel", overrides))
        return { id: "toggle-left-panel" };
      if (e.code === "ArrowRight" && !isOverridden("toggle-right-panel", overrides))
        return { id: "toggle-right-panel" };
    }

    // Alt+] / Alt+[ → next / previous annotation. No Shift.
    if (!e.shiftKey) {
      if (e.code === "BracketRight" && !isOverridden("annotation-next", overrides))
        return { id: "annotation-next" };
      if (e.code === "BracketLeft" && !isOverridden("annotation-prev", overrides))
        return { id: "annotation-prev" };
    }

    // Alt+L → select containing block.
    if (!e.shiftKey && e.code === "KeyL" && !isOverridden("select-block", overrides))
      return { id: "select-block" };
  }

  return null;
}
