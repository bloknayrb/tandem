import { describe, expect, it } from "vitest";
import { FLAT_SEPARATOR, headingPrefix, headingPrefixLength } from "../../src/shared/offsets";

describe("headingPrefixLength", () => {
  it("returns 0 for null/undefined/0", () => {
    expect(headingPrefixLength(null)).toBe(0);
    expect(headingPrefixLength(undefined)).toBe(0);
    expect(headingPrefixLength(0)).toBe(0);
  });

  it("returns level + 1 for heading levels", () => {
    expect(headingPrefixLength(1)).toBe(2); // "# "
    expect(headingPrefixLength(2)).toBe(3); // "## "
    expect(headingPrefixLength(3)).toBe(4); // "### "
    expect(headingPrefixLength(4)).toBe(5); // "#### "
    expect(headingPrefixLength(6)).toBe(7); // "###### "
  });
});

describe("headingPrefix", () => {
  it("builds correct prefix strings", () => {
    expect(headingPrefix(1)).toBe("# ");
    expect(headingPrefix(2)).toBe("## ");
    expect(headingPrefix(3)).toBe("### ");
  });

  /**
   * #1752: the two functions must agree for EVERY input, because `flatDocLength`
   * is built from the length and `extractText` from the string, and their
   * difference now decides whether a bounds check accepts a range. These four
   * inputs are unreachable from today's Y.Doc writers, so nothing else can see
   * them: the equality check inside `validateRange` compares `extractText` to
   * itself.
   */
  it.each([
    ["level 0", 0],
    ["a negative level", -1],
    ["a fractional level", 1.5],
    ["NaN, as a non-numeric attribute reads", Number.NaN],
  ])("agrees with headingPrefixLength for %s", (_label, level) => {
    // `"#".repeat(-1)` used to THROW here, and level 0 used to produce `" "`
    // against a reported length of 0.
    expect(headingPrefix(level)).toHaveLength(headingPrefixLength(level));
  });
});

describe("FLAT_SEPARATOR", () => {
  it("is a newline", () => {
    expect(FLAT_SEPARATOR).toBe("\n");
  });
});
