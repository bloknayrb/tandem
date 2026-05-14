import { describe, expect, it } from "vitest";
import {
  pickTabByDigit,
  shouldIgnoreShortcut,
} from "../../src/client/hooks/useTabKeyboardShortcuts.js";

const tabs = [{ id: "a" }, { id: "b" }, { id: "c" }];

describe("pickTabByDigit", () => {
  it("returns nth tab id for a valid digit", () => {
    expect(pickTabByDigit(tabs, 1)).toBe("a");
    expect(pickTabByDigit(tabs, 2)).toBe("b");
    expect(pickTabByDigit(tabs, 3)).toBe("c");
  });

  it("clamps to the last tab when digit exceeds tabs.length", () => {
    expect(pickTabByDigit([{ id: "a" }, { id: "b" }], 9)).toBe("b");
    expect(pickTabByDigit(tabs, 4)).toBe("c");
  });

  it("returns the only tab for digit 1 when one tab is open", () => {
    expect(pickTabByDigit([{ id: "only" }], 1)).toBe("only");
  });

  it("returns null with zero tabs", () => {
    expect(pickTabByDigit([], 1)).toBeNull();
  });

  it("returns null for out-of-range digits", () => {
    expect(pickTabByDigit(tabs, 0)).toBeNull();
    expect(pickTabByDigit(tabs, 10)).toBeNull();
    expect(pickTabByDigit(tabs, -1)).toBeNull();
  });
});

describe("shouldIgnoreShortcut", () => {
  const evt = (
    target: HTMLElement | null,
    isComposing = false,
  ): Pick<KeyboardEvent, "target" | "isComposing"> => ({
    target: target as unknown as EventTarget,
    isComposing,
  });

  it("returns true for INPUT focus", () => {
    expect(shouldIgnoreShortcut(evt(document.createElement("input")))).toBe(true);
  });

  it("returns true for TEXTAREA focus", () => {
    expect(shouldIgnoreShortcut(evt(document.createElement("textarea")))).toBe(true);
  });

  it("returns true during IME composition (even on non-form target)", () => {
    expect(shouldIgnoreShortcut(evt(document.createElement("div"), true))).toBe(true);
  });

  it("returns false for a plain div", () => {
    expect(shouldIgnoreShortcut(evt(document.createElement("div")))).toBe(false);
  });

  it("returns false for a button", () => {
    expect(shouldIgnoreShortcut(evt(document.createElement("button")))).toBe(false);
  });

  it("returns false for a contenteditable element (ProseMirror)", () => {
    const el = document.createElement("div");
    el.setAttribute("contenteditable", "true");
    expect(shouldIgnoreShortcut(evt(el))).toBe(false);
  });

  it("returns false when target is null", () => {
    expect(shouldIgnoreShortcut(evt(null))).toBe(false);
  });
});
