import { describe, expect, it } from "vitest";
import {
  cleanNotificationText as clean,
  INVISIBLE_FORMAT_RANGES,
  sliceCodeUnitsSafe,
} from "../../src/client/notifications/notification-text";

/**
 * `cleanNotificationText` mirrors Rust's `clean()` in
 * `src-tauri/src/notifications.rs`. The first block mirrors every Rust
 * `clean_*` test one for one, under the same name, so a behaviour pinned on
 * one side is pinned on the other. The parity of the constants themselves is
 * `tests/docs/chat-notification-parity-claims.test.ts`.
 */
describe("cleanNotificationText mirrors the Rust clean_* tests", () => {
  it("clean_trims_and_keeps_short_text", () => {
    expect(clean("  Claude replied  ", 120)).toBe("Claude replied");
    expect(clean("", 120)).toBe("");
  });

  it("clean_flattens_control_characters", () => {
    expect(clean("one\ntwo\tthree\r", 120)).toBe("one two three");
  });

  it("clean_caps_with_an_ellipsis_at_exactly_max_chars", () => {
    const out = clean("a".repeat(500), 10);
    expect(Array.from(out)).toHaveLength(10);
    expect(out.endsWith("…")).toBe(true);
  });

  it("clean_never_splits_a_code_point", () => {
    const out = clean("é🙂".repeat(100), 7);
    expect(Array.from(out)).toHaveLength(7);
    expect(out.endsWith("…")).toBe(true);
    // No lone surrogate: every UTF-16 unit is part of a well-formed pair.
    expect(out).toBe("é🙂é🙂é🙂…");
  });

  it("clean_drops_bidi_and_zero_width_characters", () => {
    expect(clean("report\u202Edm.exe\u200B\u2066x\uFEFF", 120)).toBe("reportdm.exex");
  });

  it("clean_flattens_line_separators_and_drops_the_arabic_letter_mark", () => {
    expect(clean("a\u2028b\u2029c\u061Cd", 120)).toBe("a b cd");
  });

  it("clean_does_not_leave_a_space_before_the_ellipsis", () => {
    expect(clean("abcd efgh", 6)).toBe("abcd…");
  });
});

describe("cleanNotificationText beyond the Rust tests", () => {
  it("flattens the C1 controls and DEL, which is_control also covers", () => {
    expect(clean("a\u007Fb\u0085c\u009Fd\u0000e", 120)).toBe("a b c d e");
    // The upper edge of C0 flattens; the first printable character does not.
    expect(clean("a\u001Fb\u0020c", 120)).toBe("a b c");
    expect(clean("a\u001Eb", 120)).toBe("a b");
  });

  it("keeps characters just outside Cc", () => {
    expect(clean("a b", 120)).toBe("a b");
  });

  it("drops every code point in INVISIBLE_FORMAT_RANGES and keeps each neighbour", () => {
    const inRange = (cp: number) =>
      INVISIBLE_FORMAT_RANGES.some(([lo, hi]) => cp >= lo && cp <= hi);
    for (const [lo, hi] of INVISIBLE_FORMAT_RANGES) {
      for (let cp = lo; cp <= hi; cp++) {
        expect(clean(`a${String.fromCodePoint(cp)}b`, 120), cp.toString(16)).toBe("ab");
      }
      for (const cp of [lo - 1, hi + 1]) {
        if (inRange(cp) || cp === 0x2028 || cp === 0x2029) continue;
        const ch = String.fromCodePoint(cp);
        expect(clean(`a${ch}b`, 120), cp.toString(16)).toBe(`a${ch}b`);
      }
    }
  });

  it("drops invisible characters before measuring the cap", () => {
    expect(clean(`${"\u200B".repeat(50)}abc`, 3)).toBe("abc");
  });

  it("a zero or one cap leaves only the ellipsis (Rust's saturating_sub)", () => {
    expect(clean("abc", 1)).toBe("…");
    expect(clean("abc", 0)).toBe("…");
  });

  it("trims what the flattening exposes", () => {
    expect(clean("\n\u2028 hi \u200B\t", 120)).toBe("hi");
  });
});

describe("sliceCodeUnitsSafe", () => {
  it("returns short text unchanged", () => {
    expect(sliceCodeUnitsSafe("abc", 3)).toBe("abc");
    expect(sliceCodeUnitsSafe("", 3)).toBe("");
  });

  it("cuts at n code units", () => {
    expect(sliceCodeUnitsSafe("abcdef", 4)).toBe("abcd");
  });

  it("drops a high surrogate the cut would leave dangling", () => {
    // "a🙂b" is a, \uD83D, \uDE42, b: a cut at 2 splits the pair.
    expect(sliceCodeUnitsSafe("a🙂b", 2)).toBe("a");
    expect(sliceCodeUnitsSafe("a🙂b", 3)).toBe("a🙂");
  });
});
