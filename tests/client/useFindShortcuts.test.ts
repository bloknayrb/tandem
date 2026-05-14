import { describe, expect, it } from "vitest";
import { shouldDispatchFindNav } from "../../src/client/hooks/useFindShortcuts.js";

describe("shouldDispatchFindNav", () => {
  it("returns false for null", () => {
    expect(shouldDispatchFindNav(null)).toBe(false);
  });

  it("returns false for undefined", () => {
    expect(shouldDispatchFindNav(undefined)).toBe(false);
  });

  it("returns false for empty query", () => {
    expect(shouldDispatchFindNav({ query: "" })).toBe(false);
  });

  it("returns true for non-empty query", () => {
    expect(shouldDispatchFindNav({ query: "x" })).toBe(true);
  });
});
