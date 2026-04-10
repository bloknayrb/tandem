import { describe, expect, it } from "vitest";

/**
 * Unit test for ToolbarButton title logic.
 * Extracted from the component's inline ternary to validate disabled-state
 * tooltip behavior without requiring a DOM environment (#197).
 */
function computeTitle(opts: {
  titleText: string;
  shortcut?: string;
  disabled?: boolean;
  disabledTitle?: string;
}): string {
  const { titleText, shortcut, disabled, disabledTitle } = opts;
  if (disabled && disabledTitle) return disabledTitle;
  if (shortcut) return `${titleText} (${shortcut})`;
  return titleText;
}

describe("ToolbarButton title computation", () => {
  it("shows disabledTitle when disabled and disabledTitle provided", () => {
    expect(
      computeTitle({
        titleText: "Comment",
        disabled: true,
        disabledTitle: "Select text first",
      }),
    ).toBe("Select text first");
  });

  it("shows normal title with shortcut when not disabled", () => {
    expect(
      computeTitle({
        titleText: "Ask Claude",
        shortcut: "Ctrl+Shift+A",
        disabled: false,
        disabledTitle: "Select text first",
      }),
    ).toBe("Ask Claude (Ctrl+Shift+A)");
  });

  it("shows normal title without shortcut when not disabled", () => {
    expect(
      computeTitle({
        titleText: "Comment",
        disabled: false,
      }),
    ).toBe("Comment");
  });

  it("falls back to shortcut title when disabled but no disabledTitle", () => {
    expect(
      computeTitle({
        titleText: "Ask Claude",
        shortcut: "Ctrl+Shift+A",
        disabled: true,
      }),
    ).toBe("Ask Claude (Ctrl+Shift+A)");
  });

  it("falls back to plain title when disabled but no disabledTitle or shortcut", () => {
    expect(
      computeTitle({
        titleText: "Flag",
        disabled: true,
      }),
    ).toBe("Flag");
  });
});
