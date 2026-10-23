import { describe, expect, it } from "vitest";
import { selectionFingerprint } from "../../src/shared/selection-fingerprint";

describe("selectionFingerprint (#1997)", () => {
  it("is deterministic", () => {
    expect(selectionFingerprint("three")).toBe(selectionFingerprint("three"));
  });

  it("differs for equal-length different strings", () => {
    expect(selectionFingerprint("world")).not.toBe(selectionFingerprint("ld wi"));
  });

  it("differs for a prefix and the whole", () => {
    expect(selectionFingerprint("wor")).not.toBe(selectionFingerprint("world"));
  });

  it("hashes UTF-16 code units, so an astral character counts as two", () => {
    expect(selectionFingerprint("a\u{1F600}b")).toMatch(/^4:[0-9a-z]+$/);
    expect(selectionFingerprint("a\u{1F600}b")).not.toBe(selectionFingerprint("a\u{1F601}b"));
  });
});
