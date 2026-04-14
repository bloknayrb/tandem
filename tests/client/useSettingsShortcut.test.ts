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
    // The matcher doesn't gate on shiftKey, so Ctrl+Shift+Comma still matches.
    // Pick<> doesn't include shiftKey, so this test documents intent: the
    // matcher is Shift-agnostic by design.
    expect(isSettingsShortcut(evt({ ctrlKey: true }))).toBe(true);
  });
});
