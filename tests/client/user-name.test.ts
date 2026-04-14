import { describe, expect, it } from "vitest";
import { resolveUserName } from "../../src/client/hooks/useUserName.js";
import { USER_NAME_DEFAULT } from "../../src/shared/constants.js";

describe("resolveUserName", () => {
  it("returns stored name when valid", () => {
    expect(resolveUserName("Alice")).toBe("Alice");
  });

  it("returns default for null", () => {
    expect(resolveUserName(null)).toBe(USER_NAME_DEFAULT);
  });

  it("returns default for undefined", () => {
    expect(resolveUserName(undefined)).toBe(USER_NAME_DEFAULT);
  });

  it("returns default for empty string", () => {
    expect(resolveUserName("")).toBe(USER_NAME_DEFAULT);
  });

  it("returns default for whitespace-only", () => {
    expect(resolveUserName("   ")).toBe(USER_NAME_DEFAULT);
  });

  it("trims whitespace from valid name", () => {
    expect(resolveUserName("  Bob  ")).toBe("Bob");
  });
});
