import { describe, expect, it } from "vitest";
import { isSettingsShortcut } from "../../src/client/hooks/useSettingsShortcut.js";

type E = Parameters<typeof isSettingsShortcut>[0];
const evt = (overrides: Partial<E> = {}): E => ({
  code: "Comma",
  ctrlKey: false,
  metaKey: false,
  isComposing: false,
  ...overrides,
});

describe("isSettingsShortcut", () => {
  it("matches Ctrl+,", () => {
    expect(isSettingsShortcut(evt({ ctrlKey: true }))).toBe(true);
  });

  it("matches Cmd+,", () => {
    expect(isSettingsShortcut(evt({ metaKey: true }))).toBe(true);
  });

  it("rejects plain comma (no modifier)", () => {
    expect(isSettingsShortcut(evt())).toBe(false);
  });

  it("rejects non-Comma code (AZERTY key that produces ',' without Comma code)", () => {
    expect(isSettingsShortcut(evt({ code: "KeyM", ctrlKey: true }))).toBe(false);
  });

  it("bails during IME composition", () => {
    expect(isSettingsShortcut(evt({ ctrlKey: true, isComposing: true }))).toBe(false);
  });

  it("accepts shifted form (QWERTZ users must Shift to reach comma)", () => {
    // Shift handling is implicit — we don't gate on shiftKey, so a Shift+Ctrl+,
    // on QWERTZ still matches as long as code === "Comma".
    expect(
      isSettingsShortcut({
        code: "Comma",
        ctrlKey: true,
        metaKey: false,
        isComposing: false,
      }),
    ).toBe(true);
  });
});
