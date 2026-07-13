import { describe, expect, it } from "vitest";
import {
  isSafeExternalHref,
  SAFE_EXTERNAL_PREFIXES,
  SAFE_IMAGE_PREFIXES,
  sanitizeHrefForPaste,
  sanitizeImageSrcForPaste,
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

describe("sanitizeImageSrcForPaste", () => {
  it("returns null for null/undefined/empty", () => {
    expect(sanitizeImageSrcForPaste(null)).toBeNull();
    expect(sanitizeImageSrcForPaste(undefined)).toBeNull();
    expect(sanitizeImageSrcForPaste("")).toBeNull();
    expect(sanitizeImageSrcForPaste("   ")).toBeNull();
  });

  it.each(SAFE_IMAGE_PREFIXES)("accepts %s prefix", (prefix) => {
    expect(sanitizeImageSrcForPaste(`${prefix}example.com/x.png`)).toBe(
      `${prefix}example.com/x.png`,
    );
  });

  it("rejects mailto: (valid link target, never a valid image source)", () => {
    expect(sanitizeImageSrcForPaste("mailto:foo@bar.com")).toBeNull();
  });

  it("accepts in-page fragments and relative/root-relative paths", () => {
    expect(sanitizeImageSrcForPaste("#section")).toBe("#section");
    expect(sanitizeImageSrcForPaste("./img.png")).toBe("./img.png");
    expect(sanitizeImageSrcForPaste("../img.png")).toBe("../img.png");
    expect(sanitizeImageSrcForPaste("/abs/img.png")).toBe("/abs/img.png");
  });

  it("accepts allowlisted base64 data: image subtypes", () => {
    for (const subtype of ["png", "jpeg", "jpg", "gif", "webp"]) {
      const src = `data:image/${subtype};base64,AAAA`;
      expect(sanitizeImageSrcForPaste(src)).toBe(src);
    }
  });

  it("rejects data:image/svg+xml even when base64-encoded", () => {
    expect(sanitizeImageSrcForPaste("data:image/svg+xml;base64,PHN2Zz48L3N2Zz4=")).toBeNull();
    expect(sanitizeImageSrcForPaste("data:image/svg+xml,<svg/>")).toBeNull();
  });

  it("rejects non-base64 data: image URIs even for allowlisted subtypes", () => {
    // Only the exact `;base64,` encoding is allowlisted — a raw/URL-encoded
    // data: URI for the same subtype is still rejected.
    expect(sanitizeImageSrcForPaste("data:image/png,rawbytes")).toBeNull();
  });

  it("accepts an allowlisted data: image URI right at the size cap", () => {
    const prefix = "data:image/png;base64,";
    const src = prefix + "A".repeat(7_000_000 - prefix.length);
    expect(sanitizeImageSrcForPaste(src)).toBe(src);
  });

  it("rejects an allowlisted data: image URI over the size cap", () => {
    const src = `data:image/png;base64,${"A".repeat(7_000_001)}`;
    expect(sanitizeImageSrcForPaste(src)).toBeNull();
  });

  it("rejects other unsafe schemes", () => {
    expect(sanitizeImageSrcForPaste("javascript:alert(1)")).toBeNull();
    expect(sanitizeImageSrcForPaste("vbscript:msgbox")).toBeNull();
    expect(sanitizeImageSrcForPaste("file:///etc/passwd")).toBeNull();
  });

  it("trims whitespace before evaluation", () => {
    expect(sanitizeImageSrcForPaste("  https://example.com/x.png  ")).toBe(
      "https://example.com/x.png",
    );
  });
});
