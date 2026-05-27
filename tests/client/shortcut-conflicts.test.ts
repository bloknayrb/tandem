import { describe, expect, it } from "vitest";
import {
  chordsEqual,
  DEFAULT_BINDINGS,
  REMAPPABLE_SHORTCUT_IDS,
  RESERVED_CHORDS,
  type RemappableShortcutId,
  type ShortcutChord,
} from "../../src/client/actions/keybindings.js";
import {
  buildOverrides,
  claimedByFixedShortcut,
  findConflict,
  parseCustomShortcuts,
} from "../../src/client/actions/shortcut-conflicts.js";
import { type KeyboardEventLike, matchShortcut } from "../../src/client/hooks/useAppShortcuts.js";

const chord = (p: Partial<ShortcutChord> & { code: string }): ShortcutChord => ({
  ctrlOrMeta: false,
  alt: false,
  shift: false,
  ...p,
});

const empty = new Map<RemappableShortcutId, ShortcutChord>();

// ---------------------------------------------------------------------------
// claimedByFixedShortcut — derives fixed-branch conflicts from the matcher, as
// FAMILIES. This is the core fix for the override-loop steal hole: a user can
// no longer bind onto a modifier variant a loose fixed branch also claims.
// ---------------------------------------------------------------------------
describe("claimedByFixedShortcut", () => {
  it.each([
    // [description, chord, expected label]
    ["Ctrl+/ → help", chord({ ctrlOrMeta: true, code: "Slash" }), "Show keyboard shortcuts"],
    [
      "Ctrl+Shift+/ → help (outer e.key='?' branch, no modifier gate)",
      chord({ ctrlOrMeta: true, shift: true, code: "Slash" }),
      "Show keyboard shortcuts",
    ],
    [
      "Alt+Shift+/ → help (outer branch fires with no ctrl)",
      chord({ alt: true, shift: true, code: "Slash" }),
      "Show keyboard shortcuts",
    ],
    ["Ctrl+A → select-all", chord({ ctrlOrMeta: true, code: "KeyA" }), "Select all"],
    [
      "Ctrl+Alt+F → find (no alt gate)",
      chord({ ctrlOrMeta: true, alt: true, code: "KeyF" }),
      "Find / Replace",
    ],
    [
      "Ctrl+Alt+Shift+F → find-in-tabs",
      chord({ ctrlOrMeta: true, alt: true, shift: true, code: "KeyF" }),
      "Find in open tabs",
    ],
    ["Ctrl+Alt+G → find-next", chord({ ctrlOrMeta: true, alt: true, code: "KeyG" }), "Find next"],
    [
      "Ctrl+Alt+Shift+G → find-prev",
      chord({ ctrlOrMeta: true, alt: true, shift: true, code: "KeyG" }),
      "Find previous",
    ],
    [
      "Ctrl+Shift+3 → pick-tab (no shift gate)",
      chord({ ctrlOrMeta: true, shift: true, code: "Digit3" }),
      "Jump to tab 3",
    ],
    [
      "Ctrl+Alt+7 → pick-tab (no alt gate)",
      chord({ ctrlOrMeta: true, alt: true, code: "Digit7" }),
      "Jump to tab 7",
    ],
  ])("claims %s", (_desc, c, label) => {
    expect(claimedByFixedShortcut(c)).toBe(label);
  });

  it("returns null for a free chord", () => {
    expect(claimedByFixedShortcut(chord({ ctrlOrMeta: true, code: "KeyJ" }))).toBeNull();
  });

  it("returns null when a chord merely equals a remappable default (findConflict's job)", () => {
    expect(claimedByFixedShortcut(DEFAULT_BINDINGS.save)).toBeNull(); // Ctrl+S → save
    expect(claimedByFixedShortcut(DEFAULT_BINDINGS["toggle-authorship"])).toBeNull(); // Ctrl+Alt+A
  });

  it("no DEFAULT_BINDINGS chord is claimed as a fixed conflict (defaults stay storable)", () => {
    for (const id of REMAPPABLE_SHORTCUT_IDS) {
      expect(claimedByFixedShortcut(DEFAULT_BINDINGS[id])).toBeNull();
    }
  });
});

// ---------------------------------------------------------------------------
// RESERVED_CHORDS now holds ONLY non-matcher reservations (the matcher's fixed
// branches are covered live by claimedByFixedShortcut). Lock that composition.
// ---------------------------------------------------------------------------
describe("RESERVED_CHORDS composition", () => {
  const reservedHas = (c: ShortcutChord) => RESERVED_CHORDS.some((r) => chordsEqual(r.chord, c));

  it("no longer lists matcher-derived families (covered by the matcher)", () => {
    expect(reservedHas(chord({ ctrlOrMeta: true, code: "KeyA" }))).toBe(false); // select-all
    expect(reservedHas(chord({ ctrlOrMeta: true, code: "KeyF" }))).toBe(false); // find
    expect(reservedHas(chord({ ctrlOrMeta: true, code: "KeyG" }))).toBe(false); // find-nav
    expect(reservedHas(chord({ ctrlOrMeta: true, code: "Slash" }))).toBe(false); // help
    expect(reservedHas(chord({ ctrlOrMeta: true, code: "Digit1" }))).toBe(false); // pick-tab
  });

  it("keeps the non-matcher reservations (tab-cycle, zoom, Tiptap letters)", () => {
    expect(reservedHas(chord({ ctrlOrMeta: true, code: "Tab" }))).toBe(true);
    expect(reservedHas(chord({ ctrlOrMeta: true, code: "Equal" }))).toBe(true); // zoom in
    expect(reservedHas(chord({ ctrlOrMeta: true, code: "Minus" }))).toBe(true); // zoom out
    expect(reservedHas(chord({ ctrlOrMeta: true, code: "KeyB" }))).toBe(true); // Bold
  });

  it("reserves the shifted zoom variants (finding #3: Ctrl+Shift+= / Ctrl+Shift+-)", () => {
    expect(reservedHas(chord({ ctrlOrMeta: true, shift: true, code: "Equal" }))).toBe(true);
    expect(reservedHas(chord({ ctrlOrMeta: true, shift: true, code: "Minus" }))).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// findConflict — remappable bindings → fixed branches → reserved set.
// ---------------------------------------------------------------------------
describe("findConflict", () => {
  it("names the remappable owner of a default chord", () => {
    expect(findConflict(DEFAULT_BINDINGS.save, empty, "save-as")).toBe("Save document");
  });

  it("excludes the id being edited", () => {
    expect(findConflict(DEFAULT_BINDINGS.save, empty, "save")).toBeNull();
  });

  it("names a fixed-branch owner that the old reserved list missed (Ctrl+Shift+/)", () => {
    expect(
      findConflict(chord({ ctrlOrMeta: true, shift: true, code: "Slash" }), empty, "save"),
    ).toBe("Show keyboard shortcuts");
  });

  it("names a reserved-chord owner (tab-cycle, Tiptap)", () => {
    expect(findConflict(chord({ ctrlOrMeta: true, code: "Tab" }), empty, "save")).toBe(
      "Next document tab",
    );
    expect(findConflict(chord({ ctrlOrMeta: true, code: "KeyB" }), empty, "save")).toBe("Bold");
  });

  it("returns null for a free chord", () => {
    expect(findConflict(chord({ ctrlOrMeta: true, code: "KeyJ" }), empty, "save")).toBeNull();
  });

  it("checks effective (overridden) bindings, not just defaults", () => {
    const c = chord({ ctrlOrMeta: true, code: "KeyJ" });
    const overrides = new Map<RemappableShortcutId, ShortcutChord>([["close-tab", c]]);
    expect(findConflict(c, overrides, "save")).toBe("Close active tab");
  });
});

// ---------------------------------------------------------------------------
// parseCustomShortcuts / buildOverrides — load/merge-time validation.
// ---------------------------------------------------------------------------
describe("parseCustomShortcuts", () => {
  it("keeps a valid remappable entry", () => {
    const raw = { "new-scratchpad": chord({ ctrlOrMeta: true, code: "KeyJ" }) };
    expect(parseCustomShortcuts(raw)).toEqual(raw);
  });

  it("drops unknown ids and malformed chords", () => {
    const raw = {
      "not-a-real-id": chord({ ctrlOrMeta: true, code: "KeyJ" }),
      save: { ctrlOrMeta: true, code: "KeyJ" }, // missing alt/shift
    };
    expect(parseCustomShortcuts(raw)).toEqual({});
  });

  it("drops an override colliding with a reserved chord (Ctrl+B Bold)", () => {
    expect(parseCustomShortcuts({ save: chord({ ctrlOrMeta: true, code: "KeyB" }) })).toEqual({});
  });

  it("drops an override colliding with a fixed matcher family (Ctrl+Shift+/)", () => {
    expect(
      parseCustomShortcuts({ save: chord({ ctrlOrMeta: true, shift: true, code: "Slash" }) }),
    ).toEqual({});
  });

  it("drops a non-bindable chord with no primary modifier (plain Shift+A)", () => {
    // Would fire on every keystroke via the override loop (chordMatches reads
    // the raw event, never chordFromEvent) — must be dropped at load.
    expect(parseCustomShortcuts({ save: chord({ shift: true, code: "KeyA" }) })).toEqual({});
  });

  it("drops an UNBINDABLE code even with a modifier (Ctrl+Escape)", () => {
    expect(parseCustomShortcuts({ save: chord({ ctrlOrMeta: true, code: "Escape" }) })).toEqual({});
  });

  it("dedupes two ids on the same chord, keeping the matcher's override-loop winner", () => {
    const c = chord({ ctrlOrMeta: true, code: "KeyJ" });
    // `save` precedes `open-file` in REMAPPABLE_SHORTCUT_IDS, so it wins.
    const parsed = parseCustomShortcuts({ "open-file": c, save: c });
    expect(parsed).toEqual({ save: c });

    // ...and that kept id is exactly what the matcher fires for the chord when
    // both overrides are present (override loop iterates REMAPPABLE order).
    const bothOverrides = new Map<RemappableShortcutId, ShortcutChord>([
      ["open-file", c],
      ["save", c],
    ]);
    const e: KeyboardEventLike = {
      key: "j",
      code: "KeyJ",
      ctrlKey: true,
      metaKey: false,
      altKey: false,
      shiftKey: false,
      isComposing: false,
    };
    expect(matchShortcut(e, bothOverrides)).toEqual({ id: "save" });
  });

  it("buildOverrides yields a Map of the parsed entries", () => {
    const c = chord({ ctrlOrMeta: true, code: "KeyJ" });
    const map = buildOverrides({ "close-tab": c });
    expect(map.get("close-tab")).toEqual(c);
    expect(map.size).toBe(1);
  });
});
