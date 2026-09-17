import { describe, expect, it } from "vitest";
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

describe("matchShortcut — layout-independent letter matching", () => {
  it("matches macOS Option+T (Ctrl+Alt+T) to reopen-closed-tab via e.code", () => {
    // macOS Option+letter produces alt chars like "†"/"µ"; matching on `e.key`
    // would miss because e.key === "†", not "t". The helper uses `e.code` to
    // stay layout-independent.
    expect(matchShortcut(evt({ code: "KeyT", key: "†", ctrlKey: true, altKey: true }))).toEqual({
      id: "reopen-closed-tab",
    });
  });

  it("matches macOS Alt+[ (annotation-prev) via e.code", () => {
    // macOS Alt+[ produces '"' (left double quote); matching on e.key === "["
    // would miss. The helper uses e.code === "BracketLeft".
    expect(matchShortcut(evt({ code: "BracketLeft", key: "“", altKey: true }))).toEqual({
      id: "annotation-prev",
    });
  });

  it("matches macOS Alt+] (annotation-next) via e.code", () => {
    expect(matchShortcut(evt({ code: "BracketRight", key: "‘", altKey: true }))).toEqual({
      id: "annotation-next",
    });
  });

  it("matches Dvorak Ctrl+W (close-tab) via e.code regardless of e.key", () => {
    // On Dvorak the physical W key produces "," — matching on e.key would miss
    // the shortcut. The helper uses e.code === "KeyW".
    expect(matchShortcut(evt({ code: "KeyW", key: ",", ctrlKey: true }))).toEqual({
      id: "close-tab",
    });
  });

  it("bare '†' with no modifiers does NOT trigger any shortcut (negative regression guard)", () => {
    // The macOS Alt+T character "†" without modifiers must NOT match any
    // shortcut — guards against an over-eager helper that branches on e.key.
    expect(matchShortcut(evt({ key: "†" }))).toBeNull();
  });
});

describe("matchShortcut — Ctrl+M vs Ctrl+Shift+M discrimination", () => {
  it("Ctrl+Shift+M → toggle-mode (Solo/Tandem)", () => {
    expect(matchShortcut(evt({ code: "KeyM", ctrlKey: true, shiftKey: true }))).toEqual({
      id: "toggle-mode",
    });
  });

  it("Ctrl+M alone does NOT match toggle-mode (must require Shift)", () => {
    expect(matchShortcut(evt({ code: "KeyM", ctrlKey: true }))).toBeNull();
  });

  it("Ctrl+Alt+M → comment-on-selection (not toggle-mode)", () => {
    expect(matchShortcut(evt({ code: "KeyM", ctrlKey: true, altKey: true }))).toEqual({
      id: "comment-on-selection",
    });
  });

  it("Ctrl+Alt+Shift+M → comment-on-selection (legacy: no shift gate)", () => {
    // The legacy outer-if `(ctrl||meta) && altKey && KeyM` did NOT gate on
    // shiftKey; preserve that so existing behavior is unchanged.
    expect(
      matchShortcut(evt({ code: "KeyM", ctrlKey: true, altKey: true, shiftKey: true })),
    ).toEqual({ id: "comment-on-selection" });
  });
});

describe("matchShortcut — context payloads", () => {
  it("Ctrl+F returns find with shift:false (doc scope)", () => {
    expect(matchShortcut(evt({ code: "KeyF", ctrlKey: true }))).toEqual({
      id: "find",
      context: { shift: false },
    });
  });

  it("Ctrl+Shift+F returns find with shift:true (tabs scope)", () => {
    expect(matchShortcut(evt({ code: "KeyF", ctrlKey: true, shiftKey: true }))).toEqual({
      id: "find",
      context: { shift: true },
    });
  });

  it("Ctrl+G returns find-nav with shift:false (next)", () => {
    expect(matchShortcut(evt({ code: "KeyG", ctrlKey: true }))).toEqual({
      id: "find-nav",
      context: { shift: false },
    });
  });

  it("Ctrl+Shift+G returns find-nav with shift:true (prev)", () => {
    expect(matchShortcut(evt({ code: "KeyG", ctrlKey: true, shiftKey: true }))).toEqual({
      id: "find-nav",
      context: { shift: true },
    });
  });

  it("Ctrl+Enter returns accept-or-dismiss with shift:false (accept)", () => {
    expect(matchShortcut(evt({ key: "Enter", ctrlKey: true }))).toEqual({
      id: "annotation-accept-or-dismiss",
      context: { shift: false },
    });
  });

  it("Ctrl+Shift+Enter returns accept-or-dismiss with shift:true (dismiss)", () => {
    expect(matchShortcut(evt({ key: "Enter", ctrlKey: true, shiftKey: true }))).toEqual({
      id: "annotation-accept-or-dismiss",
      context: { shift: true },
    });
  });

  it("Ctrl+1..9 returns pick-tab with tabIndex", () => {
    for (let i = 1; i <= 9; i++) {
      expect(matchShortcut(evt({ code: `Digit${i}`, ctrlKey: true }))).toEqual({
        id: "pick-tab",
        context: { tabIndex: i },
      });
    }
  });

  it("Ctrl+0 does NOT match pick-tab (only 1..9)", () => {
    expect(matchShortcut(evt({ code: "Digit0", ctrlKey: true }))).toBeNull();
  });
});

describe("matchShortcut — ctrl/meta letter shortcuts", () => {
  it("Ctrl+A → select-all", () => {
    expect(matchShortcut(evt({ code: "KeyA", ctrlKey: true }))).toEqual({ id: "select-all" });
  });

  it("Cmd+A (macOS) → select-all via metaKey", () => {
    expect(matchShortcut(evt({ code: "KeyA", metaKey: true }))).toEqual({ id: "select-all" });
  });

  it("Ctrl+S → save", () => {
    expect(matchShortcut(evt({ code: "KeyS", ctrlKey: true }))).toEqual({ id: "save" });
  });

  it("Ctrl+N → new-scratchpad", () => {
    expect(matchShortcut(evt({ code: "KeyN", ctrlKey: true }))).toEqual({
      id: "new-scratchpad",
    });
  });

  it("Ctrl+O → open-file", () => {
    expect(matchShortcut(evt({ code: "KeyO", ctrlKey: true }))).toEqual({ id: "open-file" });
  });

  it("Ctrl+Shift+P → toggle-palette", () => {
    expect(matchShortcut(evt({ code: "KeyP", ctrlKey: true, shiftKey: true }))).toEqual({
      id: "toggle-palette",
    });
  });

  it("Ctrl+P alone does NOT match toggle-palette (must require Shift)", () => {
    expect(matchShortcut(evt({ code: "KeyP", ctrlKey: true }))).toBeNull();
  });

  it("Ctrl+Alt+A → toggle-authorship", () => {
    expect(matchShortcut(evt({ code: "KeyA", ctrlKey: true, altKey: true }))).toEqual({
      id: "toggle-authorship",
    });
  });
});

describe("matchShortcut — settings shortcut (Ctrl+,)", () => {
  it("Ctrl+, → settings (the consolidated modal)", () => {
    expect(matchShortcut(evt({ code: "Comma", ctrlKey: true }))).toEqual({ id: "settings" });
  });

  it("Ctrl+Shift+, → unbound (the legacy settings-modal chord was removed)", () => {
    expect(matchShortcut(evt({ code: "Comma", ctrlKey: true, shiftKey: true }))).toBeNull();
  });
});

describe("matchShortcut — toggle-help", () => {
  it("bare '?' (no modifiers) → toggle-help", () => {
    expect(matchShortcut(evt({ key: "?" }))).toEqual({ id: "toggle-help" });
  });

  it("Ctrl+/ → toggle-help", () => {
    expect(matchShortcut(evt({ key: "/", ctrlKey: true }))).toEqual({ id: "toggle-help" });
  });

  it("Cmd+/ → toggle-help", () => {
    expect(matchShortcut(evt({ key: "/", metaKey: true }))).toEqual({ id: "toggle-help" });
  });

  it("Ctrl+Shift+/ (key '?' on US layouts) → toggle-help", () => {
    // Ctrl+Shift+/ produces e.key === "?" on US layouts; the top-of-function
    // `e.key === "?"` branch routes it to toggle-help regardless of modifiers.
    expect(matchShortcut(evt({ key: "?", ctrlKey: true, shiftKey: true }))).toEqual({
      id: "toggle-help",
    });
  });
});

describe("matchShortcut — Alt-only shortcuts (layout panels + annotations + select-block)", () => {
  it("Alt+Shift+ArrowLeft → toggle-left-panel", () => {
    expect(matchShortcut(evt({ code: "ArrowLeft", altKey: true, shiftKey: true }))).toEqual({
      id: "toggle-left-panel",
    });
  });

  it("Alt+Shift+ArrowRight → toggle-right-panel", () => {
    expect(matchShortcut(evt({ code: "ArrowRight", altKey: true, shiftKey: true }))).toEqual({
      id: "toggle-right-panel",
    });
  });

  it("Alt+ArrowLeft (no Shift) does NOT match toggle-left-panel — preserves browser history nav", () => {
    expect(matchShortcut(evt({ code: "ArrowLeft", altKey: true }))).toBeNull();
  });

  it("Alt+L → select-block", () => {
    expect(matchShortcut(evt({ code: "KeyL", altKey: true }))).toEqual({ id: "select-block" });
  });

  it("Ctrl+Alt+L does NOT match select-block (it's Alt-only)", () => {
    expect(matchShortcut(evt({ code: "KeyL", altKey: true, ctrlKey: true }))).toBeNull();
  });

  it("Alt+Shift+[ does NOT match annotation-prev (alt branch requires !shift)", () => {
    // The alt-only branches gate on !e.shiftKey so Alt+Shift+arrow panel toggles
    // own that space; Alt+Shift+[ falls through to null.
    expect(matchShortcut(evt({ code: "BracketLeft", altKey: true, shiftKey: true }))).toBeNull();
  });

  it("Alt+Shift+] does NOT match annotation-next (alt branch requires !shift)", () => {
    expect(matchShortcut(evt({ code: "BracketRight", altKey: true, shiftKey: true }))).toBeNull();
  });

  it("Alt+Shift+L does NOT match select-block (alt branch requires !shift)", () => {
    expect(matchShortcut(evt({ code: "KeyL", altKey: true, shiftKey: true }))).toBeNull();
  });
});

describe("matchShortcut — IME composition guard", () => {
  it("returns null while composing, even for a valid shortcut", () => {
    expect(matchShortcut(evt({ code: "KeyS", ctrlKey: true, isComposing: true }))).toBeNull();
  });
});

describe("matchShortcut — AltGr must not fire app shortcuts (#1777 item 2)", () => {
  // Windows and Linux deliver AltGr as `ctrlKey && altKey`, so the ungated
  // legacy branches swallowed ordinary characters on pl/ro/cs/de layouts. Every
  // branch in the ctrl/meta block now carries `!e.altKey` EXCEPT the three
  // deliberate Ctrl+Alt chords, which are pinned as positives further down.
  it("Ctrl+Alt+S no longer matches save (AltGr+S → ś)", () => {
    expect(matchShortcut(evt({ code: "KeyS", ctrlKey: true, altKey: true }))).toBeNull();
  });
  it("Ctrl+Shift+S matches save-as (#827 scratchpad promotion)", () => {
    expect(matchShortcut(evt({ code: "KeyS", ctrlKey: true, shiftKey: true }))).toEqual({
      id: "save-as",
    });
  });
  it("Ctrl+Shift+J matches focus-chat", () => {
    expect(matchShortcut(evt({ code: "KeyJ", ctrlKey: true, shiftKey: true }))).toEqual({
      id: "focus-chat",
    });
  });
  it("Ctrl+Shift+E matches toggle-source-view", () => {
    expect(matchShortcut(evt({ code: "KeyE", ctrlKey: true, shiftKey: true }))).toEqual({
      id: "toggle-source-view",
    });
  });
  it("Ctrl+Alt+N no longer matches new-scratchpad (AltGr+N → ń)", () => {
    expect(matchShortcut(evt({ code: "KeyN", ctrlKey: true, altKey: true }))).toBeNull();
  });
  it("Ctrl+Alt+1 no longer matches pick-tab", () => {
    expect(matchShortcut(evt({ code: "Digit1", ctrlKey: true, altKey: true }))).toBeNull();
  });
  it("Ctrl+Alt+, no longer matches settings", () => {
    expect(matchShortcut(evt({ code: "Comma", key: ",", ctrlKey: true, altKey: true }))).toBeNull();
  });
  it("Ctrl+Alt+/ no longer matches toggle-help", () => {
    expect(matchShortcut(evt({ code: "Slash", key: "/", ctrlKey: true, altKey: true }))).toBeNull();
  });
  it("Ctrl+Alt+Shift+P no longer matches toggle-palette", () => {
    expect(
      matchShortcut(evt({ code: "KeyP", ctrlKey: true, altKey: true, shiftKey: true })),
    ).toBeNull();
  });
  it("Ctrl+Alt+O no longer matches open-file (AltGr+O → ó)", () => {
    expect(matchShortcut(evt({ code: "KeyO", ctrlKey: true, altKey: true }))).toBeNull();
  });
  it("Ctrl+Alt+F no longer matches find", () => {
    expect(matchShortcut(evt({ code: "KeyF", ctrlKey: true, altKey: true }))).toBeNull();
  });
  it("Ctrl+Alt+G no longer matches find-nav", () => {
    expect(matchShortcut(evt({ code: "KeyG", ctrlKey: true, altKey: true }))).toBeNull();
  });

  // Layout-realistic rows: what the AltGr chord actually produces on the
  // affected layouts, carried in `e.key` while `e.code` is the physical key.
  it("pl AltGr+S (ś) types instead of saving", () => {
    expect(matchShortcut(evt({ code: "KeyS", key: "ś", ctrlKey: true, altKey: true }))).toBeNull();
  });
  it("pl AltGr+N (ń) types instead of opening a scratchpad", () => {
    expect(matchShortcut(evt({ code: "KeyN", key: "ń", ctrlKey: true, altKey: true }))).toBeNull();
  });
  it("pl AltGr+O (ó) types instead of opening the file dialog", () => {
    expect(matchShortcut(evt({ code: "KeyO", key: "ó", ctrlKey: true, altKey: true }))).toBeNull();
  });
  it("de AltGr+7 ({) types instead of switching tabs", () => {
    expect(
      matchShortcut(evt({ code: "Digit7", key: "{", ctrlKey: true, altKey: true })),
    ).toBeNull();
  });
  it("Ctrl+Alt+Shift+T still matches reopen-closed-tab (legacy no-shift-gate)", () => {
    expect(
      matchShortcut(evt({ code: "KeyT", ctrlKey: true, altKey: true, shiftKey: true })),
    ).toEqual({ id: "reopen-closed-tab" });
  });
  it("Ctrl+T (no Alt) matches new-tab-menu", () => {
    expect(matchShortcut(evt({ code: "KeyT", ctrlKey: true }))).toEqual({ id: "new-tab-menu" });
  });
  it("Ctrl+Shift+T is inert (new-tab-menu requires !shift; reopen requires alt)", () => {
    expect(matchShortcut(evt({ code: "KeyT", ctrlKey: true, shiftKey: true }))).toBeNull();
  });
  it("Ctrl+Alt+Shift+A still matches toggle-authorship (legacy no-shift-gate)", () => {
    expect(
      matchShortcut(evt({ code: "KeyA", ctrlKey: true, altKey: true, shiftKey: true })),
    ).toEqual({ id: "toggle-authorship" });
  });
  it("Ctrl+Alt+Enter no longer matches accept", () => {
    expect(matchShortcut(evt({ key: "Enter", ctrlKey: true, altKey: true }))).toBeNull();
  });

  // The three deliberate Ctrl+Alt chords keep firing — these are what kill a
  // blanket `if (e.altKey) return` in the ctrl/meta block.
  it("Ctrl+Alt+T still matches reopen-closed-tab", () => {
    expect(matchShortcut(evt({ code: "KeyT", ctrlKey: true, altKey: true }))).toEqual({
      id: "reopen-closed-tab",
    });
  });
  it("Ctrl+Alt+M still matches comment-on-selection", () => {
    expect(matchShortcut(evt({ code: "KeyM", ctrlKey: true, altKey: true }))).toEqual({
      id: "comment-on-selection",
    });
  });
});

describe("matchShortcut — settings/select-all gating priorities", () => {
  it("Ctrl+A (no alt) → select-all (not toggle-authorship)", () => {
    expect(matchShortcut(evt({ code: "KeyA", ctrlKey: true }))).toEqual({ id: "select-all" });
  });
  it("Ctrl+Alt+A → toggle-authorship (gate routes around select-all)", () => {
    // select-all branch requires !altKey, so Ctrl+Alt+A skips it and hits
    // toggle-authorship later in the chain.
    expect(matchShortcut(evt({ code: "KeyA", ctrlKey: true, altKey: true }))).toEqual({
      id: "toggle-authorship",
    });
  });
  it("Ctrl+Shift+A does NOT match select-all (requires !shift)", () => {
    // Legacy explicitly gated select-all on `!altKey && !shiftKey`. Ctrl+Shift+A
    // produced no match in legacy and the matcher preserves that.
    expect(matchShortcut(evt({ code: "KeyA", ctrlKey: true, shiftKey: true }))).toBeNull();
  });
});

describe("matchShortcut — negative cases / no-match", () => {
  it("returns null for plain letter (no modifiers)", () => {
    expect(matchShortcut(evt({ code: "KeyA", key: "a" }))).toBeNull();
  });

  it("returns null for unrelated key", () => {
    expect(matchShortcut(evt({ code: "Escape", key: "Escape" }))).toBeNull();
  });

  it("returns null for Enter with no modifiers", () => {
    expect(matchShortcut(evt({ key: "Enter" }))).toBeNull();
  });

  it("Ctrl+Alt+W no longer matches close-tab (#1777 item 2)", () => {
    // The legacy `else if (e.code === "KeyW")` had no modifier gate, so AltGr+W
    // closed the active tab on layouts that produce a character there.
    expect(matchShortcut(evt({ code: "KeyW", ctrlKey: true, altKey: true }))).toBeNull();
  });
});
