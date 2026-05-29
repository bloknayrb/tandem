import { describe, expect, it } from "vitest";
import {
  isSafeExternalHref,
  SAFE_EXTERNAL_PREFIXES,
  sanitizeHrefForPaste,
} from "../../src/client/editor/utils/url-safety";

describe("SAFE_EXTERNAL_PREFIXES", () => {
  it("matches the documented allowlist exactly", () => {
    expect([...SAFE_EXTERNAL_PREFIXES]).toEqual(["http://", "https://", "mailto:", "ftp://", "//"]);
  });
});

describe("isSafeExternalHref", () => {
  it.each(SAFE_EXTERNAL_PREFIXES)("accepts %s prefix", (prefix) => {
    expect(isSafeExternalHref(`${prefix}example.com`)).toBe(true);
  });

  it("is case-insensitive (CommonMark allows uppercase schemes)", () => {
    expect(isSafeExternalHref("HTTPS://example.com")).toBe(true);
    expect(isSafeExternalHref("MailTo:foo@bar.com")).toBe(true);
  });

  it.each([
    "javascript:alert(1)",
    "JavaScript:alert(1)",
    "data:text/html,x",
    "vbscript:msgbox",
    "file:///etc/passwd",
    "blob:https://example.com/uuid",
    "filesystem:http://example.com/temporary/x",
    "view-source:https://example.com",
  ])("rejects unsafe scheme %s", (href) => {
    expect(isSafeExternalHref(href)).toBe(false);
  });

  it("rejects relative paths (caller must handle these separately)", () => {
    expect(isSafeExternalHref("./other.md")).toBe(false);
    expect(isSafeExternalHref("#section")).toBe(false);
    expect(isSafeExternalHref("/abs/path")).toBe(false);
  });
});

describe("sanitizeHrefForPaste", () => {
  it("returns null for null/undefined/empty", () => {
    expect(sanitizeHrefForPaste(null)).toBeNull();
    expect(sanitizeHrefForPaste(undefined)).toBeNull();
    expect(sanitizeHrefForPaste("")).toBeNull();
    expect(sanitizeHrefForPaste("   ")).toBeNull();
  });

  it("accepts every allowlisted external prefix", () => {
    expect(sanitizeHrefForPaste("https://example.com")).toBe("https://example.com");
    expect(sanitizeHrefForPaste("mailto:foo@bar.com")).toBe("mailto:foo@bar.com");
    expect(sanitizeHrefForPaste("ftp://example.com")).toBe("ftp://example.com");
    expect(sanitizeHrefForPaste("//example.com/x")).toBe("//example.com/x");
  });

  it("accepts in-page fragments", () => {
    expect(sanitizeHrefForPaste("#section")).toBe("#section");
  });

  it("accepts relative paths (no scheme prefix)", () => {
    expect(sanitizeHrefForPaste("./other.md")).toBe("./other.md");
    expect(sanitizeHrefForPaste("../up/file.md")).toBe("../up/file.md");
    expect(sanitizeHrefForPaste("subdir/file.md")).toBe("subdir/file.md");
    expect(sanitizeHrefForPaste("/abs/path.md")).toBe("/abs/path.md");
  });

  it("trims whitespace before evaluation", () => {
    expect(sanitizeHrefForPaste("  https://example.com  ")).toBe("https://example.com");
    // Leading whitespace doesn't sneak a bad scheme past the allowlist.
    expect(sanitizeHrefForPaste("   javascript:alert(1)")).toBeNull();
  });

  it.each([
    "javascript:alert(1)",
    "JavaScript:alert(1)",
    "data:text/html,x",
    "vbscript:msgbox",
    "file:///etc/passwd",
    "blob:https://example.com/uuid",
    "filesystem:http://example.com/temporary/x",
    "view-source:https://example.com",
  ])("rejects unsafe scheme: %s", (href) => {
    expect(sanitizeHrefForPaste(href)).toBeNull();
  });

  it("accepts a path with a colon AFTER the first / (not a scheme)", () => {
    // e.g. a query string or filename with a colon — not a URL scheme.
    expect(sanitizeHrefForPaste("/path/to/file?x:1")).toBe("/path/to/file?x:1");
    expect(sanitizeHrefForPaste("/dir#anchor:with:colons")).toBe("/dir#anchor:with:colons");
  });

  it("rejects a bare leading colon", () => {
    expect(sanitizeHrefForPaste(":alert(1)")).toBeNull();
  });
});
