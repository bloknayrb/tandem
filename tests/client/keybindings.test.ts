import { describe, expect, it } from "vitest";
import {
  chordFromEvent,
  DEFAULT_BINDINGS,
  formatChord,
  REMAPPABLE_SHORTCUT_IDS,
  type RemappableShortcutId,
  type ShortcutChord,
} from "../../src/client/actions/keybindings.js";
import { type KeyboardEventLike, matchShortcut } from "../../src/client/hooks/useAppShortcuts.js";

const evt = (overrides: Partial<KeyboardEventLike> = {}): KeyboardEventLike => ({
  key: "",
  code: "",
  ctrlKey: false,
  metaKey: false,
  altKey: false,
  shiftKey: false,
  isComposing: false,
  ...overrides,
});

const eventForChord = (chord: ShortcutChord): KeyboardEventLike =>
  evt({
    code: chord.code,
    ctrlKey: chord.ctrlOrMeta,
    altKey: chord.alt,
    shiftKey: chord.shift,
  });

const overridesOf = (
  entries: Array<[RemappableShortcutId, ShortcutChord]>,
): ReadonlyMap<RemappableShortcutId, ShortcutChord> => new Map(entries);

// ---------------------------------------------------------------------------
// Drift guards — the linchpin. Every default chord must round-trip through the
// matcher's hand-ordered chain to its own id. Catches ordering quirks
// (toggle-authorship after select-all, the alt-only block, the Comma pair).
// ---------------------------------------------------------------------------
describe("DEFAULT_BINDINGS drift guard", () => {
  for (const id of REMAPPABLE_SHORTCUT_IDS) {
    it(`default chord for "${id}" round-trips through matchShortcut (no overrides)`, () => {
      expect(matchShortcut(eventForChord(DEFAULT_BINDINGS[id]))).toEqual({ id });
    });
  }
});

// Note: fixed-branch conflict coverage and reserved-set composition are tested
// in `shortcut-conflicts.test.ts` (the matcher is the completeness oracle now).

// ---------------------------------------------------------------------------
// Override-aware matcher behavior.
// ---------------------------------------------------------------------------
describe("matchShortcut — override layer", () => {
  it("a remapped combo wins and returns the remapped id", () => {
    const chord: ShortcutChord = { ctrlOrMeta: true, alt: false, shift: false, code: "KeyJ" };
    const overrides = overridesOf([["new-scratchpad", chord]]);
    expect(matchShortcut(eventForChord(chord), overrides)).toEqual({ id: "new-scratchpad" });
  });

  it("the overridden default's canonical combo goes inert", () => {
    const chord: ShortcutChord = { ctrlOrMeta: true, alt: false, shift: false, code: "KeyJ" };
    const overrides = overridesOf([["new-scratchpad", chord]]);
    // Ctrl+N no longer maps to anything (no other KeyN branch exists).
    expect(matchShortcut(evt({ code: "KeyN", ctrlKey: true }), overrides)).toBeNull();
  });

  it("a shifted sibling still falls through (remap save-as ⇒ Ctrl+Shift+S triggers save)", () => {
    const chord: ShortcutChord = { ctrlOrMeta: true, alt: false, shift: false, code: "KeyJ" };
    const overrides = overridesOf([["save-as", chord]]);
    expect(matchShortcut(evt({ code: "KeyS", ctrlKey: true, shiftKey: true }), overrides)).toEqual({
      id: "save",
    });
  });

  it("Comma-pair asymmetry: remapping settings-modal leaves Ctrl+Shift+, inert (not settings)", () => {
    const chord: ShortcutChord = { ctrlOrMeta: true, alt: false, shift: false, code: "KeyJ" };
    const overrides = overridesOf([["settings-modal", chord]]);
    // settings branch requires !shift, so the shifted Comma does NOT fall to it.
    expect(
      matchShortcut(evt({ code: "Comma", ctrlKey: true, shiftKey: true }), overrides),
    ).toBeNull();
  });

  it("unrelated defaults are unaffected by an override", () => {
    const chord: ShortcutChord = { ctrlOrMeta: true, alt: false, shift: false, code: "KeyJ" };
    const overrides = overridesOf([["new-scratchpad", chord]]);
    expect(matchShortcut(evt({ code: "KeyS", ctrlKey: true }), overrides)).toEqual({ id: "save" });
  });

  it("empty overrides is byte-identical to no overrides", () => {
    const e = evt({ code: "KeyW", ctrlKey: true });
    expect(matchShortcut(e, new Map())).toEqual(matchShortcut(e));
  });
});

// ---------------------------------------------------------------------------
// chordFromEvent capture rules.
// ---------------------------------------------------------------------------
describe("chordFromEvent", () => {
  it("rejects pure-modifier presses", () => {
    expect(chordFromEvent(evt({ code: "ShiftLeft", key: "Shift", shiftKey: true }))).toBeNull();
    expect(chordFromEvent(evt({ code: "ControlLeft", key: "Control", ctrlKey: true }))).toBeNull();
  });

  it("rejects bare / Shift-only single keys (requires Ctrl/Meta or Alt)", () => {
    expect(chordFromEvent(evt({ code: "KeyA", key: "a" }))).toBeNull();
    expect(chordFromEvent(evt({ code: "KeyA", key: "A", shiftKey: true }))).toBeNull();
  });

  it("rejects Numpad keys, dead keys, and reserved nav/edit keys", () => {
    expect(chordFromEvent(evt({ code: "Numpad1", key: "1", ctrlKey: true }))).toBeNull();
    expect(chordFromEvent(evt({ code: "KeyU", key: "Dead", altKey: true }))).toBeNull();
    expect(chordFromEvent(evt({ code: "Tab", key: "Tab", ctrlKey: true }))).toBeNull();
    expect(chordFromEvent(evt({ code: "Escape", key: "Escape", ctrlKey: true }))).toBeNull();
    expect(chordFromEvent(evt({ code: "Enter", key: "Enter", ctrlKey: true }))).toBeNull();
  });

  it("accepts a valid chord and collapses ctrl/meta", () => {
    expect(chordFromEvent(evt({ code: "KeyJ", key: "j", ctrlKey: true }))).toEqual({
      ctrlOrMeta: true,
      alt: false,
      shift: false,
      code: "KeyJ",
    });
    expect(chordFromEvent(evt({ code: "KeyJ", key: "j", metaKey: true, shiftKey: true }))).toEqual({
      ctrlOrMeta: true,
      alt: false,
      shift: true,
      code: "KeyJ",
    });
  });
});

// Note: findConflict, parseCustomShortcuts, and buildOverrides moved to
// `shortcut-conflicts.test.ts` along with their implementation.

describe("formatChord", () => {
  it("formats a Ctrl+Shift chord on a non-mac platform", () => {
    // jsdom navigator.platform is "" → treated as non-mac.
    expect(formatChord({ ctrlOrMeta: true, alt: false, shift: true, code: "KeyS" })).toBe(
      "Ctrl+Shift+S",
    );
  });
});
