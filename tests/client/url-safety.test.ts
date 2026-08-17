import { describe, expect, it } from "vitest";
import {
  isSafeExternalHref,
  isSchemelessPathHref,
  SAFE_EXTERNAL_PREFIXES,
  SAFE_IMAGE_PREFIXES,
  sanitizeHrefForPaste,
  sanitizeImageSrcForPaste,
} from "../../src/client/editor/utils/url-safety";

/**
 * Control / exotic-whitespace characters are built rather than written as
 * literals so the source file stays free of raw control bytes.
 */
const ch = (code: number) => String.fromCharCode(code);
const NUL = ch(0x00);
const US = ch(0x1f); // U+001F, inside the DOMPurify range
const MONGOLIAN_VOWEL_SEP = ch(0x180e);

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

  it("is unchanged for a backslash-bearing href", () => {
    // Pins the OTHER consumer of `hasSchemePrefix` against the drift this
    // file's header warns about: `isSchemelessPathHref` rejects backslash in
    // the CALLER, so an edit that moved backslash handling into the shared
    // helper would red two suites rather than one.
    expect(sanitizeHrefForPaste("a\\b.md")).toBe("a\\b.md");
  });
});

describe("isSchemelessPathHref", () => {
  it.each([
    "docs/spec.md",
    "a/b.md",
    "subdir/file.md#frag",
    "Docs/spec.md",
    "notes.md",
    "./other.md",
    "../up/file.md",
    "/abs/path.md",
    "#section",
    "docs?x=1",
    "my%20docs/spec.md",
    // Looks alarming, is not: the colon FOLLOWS a `/`, so WHATWG scheme
    // parsing cannot fire. Verified — it resolves to
    // `http://…/java/script:alert(1)`. Do not "fix" this row.
    "java/script:alert(1)",
  ])("accepts the scheme-less path reference %s", (href) => {
    expect(isSchemelessPathHref(href)).toBe(true);
  });

  it("accepts a bare domain-with-path", () => {
    // Accepted deliberately. This is the shape that reaches the linkify
    // markPasteRule, which cannot be narrowed by option — pasting the plain
    // text now creates `http://example.com/path`. Justified because bare
    // `example.com` already linkifies today; NOT reachable via autolink,
    // which `shouldAutoLink` pins to the vendored default.
    expect(isSchemelessPathHref("example.com/path")).toBe(true);
  });

  it("rejects protocol-relative hrefs", () => {
    // THIS is the assertion guarding the `//` carve-out. Nothing in
    // link-target-internal.test.ts can: Tiptap's `defaultValidate("//evil.com")`
    // is already true, so the union short-circuits and the predicate's verdict
    // is unobservable there.
    expect(isSchemelessPathHref("//example.com/x")).toBe(false);
  });

  it.each([
    "/\\evil.com/x.md",
    "\\/evil.com/x.md",
    "\\\\evil.com\\share\\x.md",
    "a/\\/evil.com/x.md",
    "a\\b.md",
  ])("rejects the backslash form %s", (href) => {
    // The first three resolve CROSS-HOST — `new URL(…)` gives
    // `http://evil.com/…` — despite looking path-like. The last is benign but
    // rejected anyway, because the predicate is fail-closed on backslash
    // rather than normalizing; the union keeps it live via `defaultValidate`.
    expect(isSchemelessPathHref(href)).toBe(false);
  });

  it.each([
    [`${NUL}//evil.com`, "NUL"],
    [`${US}//evil.com`, "U+001F"],
    [`${MONGOLIAN_VOWEL_SEP}//evil.com`, "U+180E"],
    ["\t//evil.com", "TAB"],
    [`${NUL}a/`, "NUL before a path"],
    [" a/", "leading space"],
  ])("rejects the control/exotic-whitespace form (%s)", (href) => {
    // JS `trim()` does NOT strip U+0000, U+001F or U+180E, while the WHATWG
    // parser and DOMPurify do — measured, `new URL("<NUL>//evil.com", …)` is
    // `http://evil.com/`. That mismatch is exactly why this predicate REJECTS
    // rather than trims.
    expect(isSchemelessPathHref(href)).toBe(false);
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
    expect(isSchemelessPathHref(href)).toBe(false);
  });

  it.each([":alert(1)", "", "   "])("rejects the degenerate input %j", (href) => {
    expect(isSchemelessPathHref(href)).toBe(false);
  });

  it("rejects null and undefined", () => {
    expect(isSchemelessPathHref(null)).toBe(false);
    expect(isSchemelessPathHref(undefined)).toBe(false);
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

  // **Every row here was accepted before #1420, and only the first was closed
  // by removing `//` from the allowlist.** The rest carry no colon, so
  // `hasSchemePrefix` returned false and the trailing scheme-less
  // pass-through handed them back as safe. Browsers map `\` to `/` inside a
  // URL, so each resolves cross-host.
  //
  // The table is the point: a fix that only drops `//` from
  // SAFE_IMAGE_PREFIXES passes row 1 and fails rows 2-5, while reading in a
  // diff as though it closed the class.
  it.each([
    ["protocol-relative", "//evil.com/x.png"],
    ["mixed separator, slash first", "/\\evil.com/x.png"],
    ["mixed separator, backslash first", "\\/evil.com/x.png"],
    ["double backslash", "\\\\evil.com\\x.png"],
    // Built with `ch()`, per this file's no-raw-control-bytes rule. NUL and
    // U+001F survive `trim()` (neither is JS whitespace), so they defeat the
    // `startsWith("//")` guard and leave URL_HOSTILE_CHARS as the only thing
    // that can reject them. A space-prefixed row would prove nothing --
    // `trim()` strips it before either guard runs.
    ["NUL prefix", `${NUL}//evil.com/x.png`],
    ["U+001F prefix", `${US}//evil.com/x.png`],
  ])("rejects a cross-host image src (%s)", (_label, hostile) => {
    expect(sanitizeImageSrcForPaste(hostile)).toBeNull();
  });

  it("still rejects protocol-relative now that it left the allowlist", () => {
    // Pinned separately from the table because it is the one row whose
    // rejection depends on the SAFE_IMAGE_PREFIXES edit rather than on the
    // two guards — re-adding "//" to that list must fail a test.
    expect(SAFE_IMAGE_PREFIXES).not.toContain("//");
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
