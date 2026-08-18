import { describe, expect, it } from "vitest";
import {
  hasSchemePrefix,
  SAFE_IMAGE_PREFIXES,
  sanitizeImageSrc,
  URL_HOSTILE_CHARS,
} from "../../src/shared/image-src-safety.js";

/**
 * Control / exotic-whitespace characters are built rather than written as
 * literals so the source file stays free of raw control bytes (mirrors
 * tests/client/url-safety.test.ts's convention).
 */
const ch = (code: number) => String.fromCharCode(code);
const NUL = ch(0x00);

describe("sanitizeImageSrc", () => {
  it("accepts allowlisted external prefixes", () => {
    expect(sanitizeImageSrc("https://example.com/x.png")).toBe("https://example.com/x.png");
    expect(sanitizeImageSrc("http://example.com/x.png")).toBe("http://example.com/x.png");
    expect(sanitizeImageSrc("ftp://example.com/x.png")).toBe("ftp://example.com/x.png");
  });

  it("accepts relative and root-relative paths", () => {
    expect(sanitizeImageSrc("./img.png")).toBe("./img.png");
    expect(sanitizeImageSrc("../img.png")).toBe("../img.png");
    expect(sanitizeImageSrc("/img.png")).toBe("/img.png");
    expect(sanitizeImageSrc("img.png")).toBe("img.png");
  });

  it("accepts an allowlisted data: raster URI", () => {
    const uri = "data:image/png;base64,iVBORw0KGgo=";
    expect(sanitizeImageSrc(uri)).toBe(uri);
  });

  it("rejects data:image/svg+xml", () => {
    expect(sanitizeImageSrc("data:image/svg+xml;base64,PHN2Zz4=")).toBeNull();
  });

  it("rejects javascript: and other unknown schemes", () => {
    expect(sanitizeImageSrc("javascript:alert(1)")).toBeNull();
    expect(sanitizeImageSrc("file:///etc/passwd")).toBeNull();
    expect(sanitizeImageSrc("vbscript:msgbox(1)")).toBeNull();
  });

  // Same cross-host bypass class url-safety.test.ts pins for the paste-time
  // alias — verified here directly against the shared implementation so
  // regressions here (used by both paste AND file-import) are caught before
  // either caller.
  it.each([
    ["protocol-relative", "//evil.com/x.png"],
    ["mixed separator, slash first", "/\\evil.com/x.png"],
    ["mixed separator, backslash first", "\\/evil.com/x.png"],
    ["double backslash", "\\\\evil.com\\x.png"],
    ["NUL prefix", `${NUL}//evil.com/x.png`],
  ])("rejects a cross-host image src (%s)", (_label, hostile) => {
    expect(sanitizeImageSrc(hostile)).toBeNull();
  });

  it("returns null for empty/null/undefined input", () => {
    expect(sanitizeImageSrc("")).toBeNull();
    expect(sanitizeImageSrc("   ")).toBeNull();
    expect(sanitizeImageSrc(null)).toBeNull();
    expect(sanitizeImageSrc(undefined)).toBeNull();
  });
});

describe("SAFE_IMAGE_PREFIXES", () => {
  it("does not include protocol-relative //", () => {
    expect(SAFE_IMAGE_PREFIXES).not.toContain("//");
  });
});

describe("hasSchemePrefix / URL_HOSTILE_CHARS", () => {
  it("hasSchemePrefix treats a colon before any path separator as a scheme", () => {
    expect(hasSchemePrefix("https://example.com")).toBe(true);
    expect(hasSchemePrefix("./a:b.png")).toBe(false);
    expect(hasSchemePrefix("relative/path.png")).toBe(false);
  });

  it("URL_HOSTILE_CHARS matches a bare backslash anywhere in the string", () => {
    expect(URL_HOSTILE_CHARS.test("a\\b")).toBe(true);
    expect(URL_HOSTILE_CHARS.test("a/b")).toBe(false);
  });
});
