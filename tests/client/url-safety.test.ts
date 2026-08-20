import { describe, expect, it } from "vitest";
import {
  isRenderableLinkHref,
  isRenderableLinkScheme,
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

describe("isRenderableLinkHref (the render-time veto, #1420)", () => {
  // A UNIT PIN, not before/after proof: the observable render behaviour is
  // asserted in `link-target-internal.test.ts`, which derives its corpus from
  // `new URL()` rather than from this predicate. What lives here is the WHY —
  // the three rows a future "simplify" would get wrong.

  it.each([
    "/\\evil.com/x.md",
    "\\/evil.com/x.md",
    "\\\\evil.com\\share\\x.md",
    "\\\\fileserver\\docs\\spec.docx",
    "\\\\?\\C:\\x.md",
  ])("rejects the backslash-bearing authority %j", (href) => {
    expect(isRenderableLinkHref(href)).toBe(false);
  });

  it.each([
    " /\\evil.com/x.md",
    "  //evil.com/x.md",
    " \\\\evil.com\\share\\x.md",
    " https://evil.com/x.md",
  ])("rejects %j — leading whitespace, the anchored-check bypass", (href) => {
    // `rejectUnsafeWindowsPrefix` is anchored at index 0, so ONE leading space
    // walked past it while Tiptap's `defaultValidate` still returned true and
    // the browser still resolved the href to `http://evil.com/x.md`. Reachable
    // from file import, not just paste: remark keeps the space inside a
    // pointy-bracket destination and `mdast-ydoc.ts` writes `node.url` verbatim.
    expect(isRenderableLinkHref(href)).toBe(false);
  });

  it.each([
    NUL,
    US,
    ch(0x0b),
    "\t",
    "\n",
  ])("rejects a control character anywhere in the href", (control) => {
    expect(isRenderableLinkHref(`https://example.com/${control}x`)).toBe(false);
    expect(isRenderableLinkHref(`${control}//evil.com/x.md`)).toBe(false);
  });

  it("accepts an INTERIOR space — the reason URL_HOSTILE_CHARS is not reused here", () => {
    // `URL_HOSTILE_CHARS` contains U+0020. This veto applies to every href
    // including allowlisted external ones, so reusing that set would blank a
    // legitimate `[x](<a b.md>)` or an imported `.docx` hyperlink.
    expect(isRenderableLinkHref("https://example.com/a b.md")).toBe(true);
    expect(isRenderableLinkHref("my file.md")).toBe(true);
  });

  it("accepts `//` in its exact untrimmed spelling — a deliberate carve-out", () => {
    // `//` is a FOURTH cross-host spelling, kept live because it is in
    // SAFE_EXTERNAL_PREFIXES and `openHref` hands it to `window.open` like any
    // `https://` URL. The whitespace-prefixed variant is NOT the same thing:
    // `isSafeExternalHref` does not trim, so the click gate would treat it as a
    // relative path while the browser treats it as an external navigation.
    expect(isRenderableLinkHref("//example.com/x")).toBe(true);
    expect(isRenderableLinkHref(" //example.com/x")).toBe(false);
  });

  it.each([
    "docs/spec.md",
    "docs\\spec.md",
    "./spec.md",
    "../docs/spec.md",
    "/abs/spec.md",
    "notes.md",
    "#frag",
    "https://example.com",
    "HTTPS://example.com",
    "mailto:a@b.c",
    "ftp://example.com/x",
  ])("accepts the legitimate href %j", (href) => {
    // `docs\spec.md` is the row that catches "just reject every backslash":
    // Windows-authored markdown produces it and `relative-link.ts` resolves it.
    expect(isRenderableLinkHref(href)).toBe(true);
  });

  it("rejects null, undefined and empty", () => {
    expect(isRenderableLinkHref(null)).toBe(false);
    expect(isRenderableLinkHref(undefined)).toBe(false);
    expect(isRenderableLinkHref("")).toBe(false);
  });

  it.each([
    "http:/\\evil.com/x",
    "https:/evil.com/x",
    "https:/\\evil.com/x",
    "http:\\\\evil.com\\x",
    "HTTP:/\\evil.com/x",
    "ftp:/\\evil.com/x",
  ])("rejects %j — a scheme moves the authority past the anchored check", (href) => {
    // `rejectUnsafeWindowsPrefix` slices [0,8) and anchors, so it sees
    // `"http:\\e"` and passes. These resolve cross-host, and
    // `isSafeExternalHref` says false for every one — so `target="_blank"` is
    // stripped and the click gate treats them as document-relative paths.
    expect(isRenderableLinkHref(href)).toBe(false);
  });

  it("does not over-reach: a sanctioned external spelling stays live", () => {
    // `https:///evil.com/x` starts with `https://`, so `isSafeExternalHref`
    // accepts it and `openHref` opens it via `window.open` — an ordinary
    // external link, off-origin by design.
    expect(isRenderableLinkHref("https:///evil.com/x")).toBe(true);
    expect(isRenderableLinkHref("https://example.com/a b.md")).toBe(true);
  });

  it("judges schemes ONLY in the special-external family — the rest is #1537", () => {
    // Read this row carefully: it is NOT "schemes are handled elsewhere".
    // `javascript:` is the one scheme where Tiptap agrees, so demonstrating the
    // division of labour with it alone reads far more reassuring than the truth.
    expect(isRenderableLinkHref("javascript:alert(1)")).toBe(true);
    expect(isSchemelessPathHref("javascript:alert(1)")).toBe(false);

    // The truth: DOMPurify's fallback alternative matches a hyphen, so a
    // hyphenated scheme satisfies `defaultValidate`, the `||` short-circuits,
    // and this veto does not subtract it either — these render LIVE today, with
    // the href verbatim. `search-ms:` is an NTLM/WebDAV-share spelling reaching
    // the OS from a right-click "Open link in new tab", in a codebase whose
    // `rejectUnsafeWindowsPrefix` exists to prevent exactly that class.
    // Deliberately open, tracked as #1537: closing it means an allowlist
    // posture that would also stop rendering `tel:`/`sms:`/`xmpp:`/`ftps:`.
    for (const href of [
      "ms-msdt:/id",
      "ms-appinstaller:?source=x",
      "search-ms:crumb=location:\\\\evil.com\\share",
      "itms-services://?url=http://evil",
      "tel:+15551234",
    ]) {
      expect(isRenderableLinkHref(href), `${href} is NOT subtracted by this veto`).toBe(true);
    }

/**
 * DOCUMENTATION CORPUS for the render-time scheme allowlist (#1537).
 *
 * **The load-bearing pins are in `tests/client/link-scheme-allowlist.test.ts`,
 * not here.** This file is rewritten by the still-open #1545, whose own
 * predicate returns `true` for every row below and whose tests assert exactly
 * that — so a merge resolution taking that branch's side would silently delete
 * these. They are kept as the readable corpus beside the other href predicates;
 * the canary that must survive lives at a path with no merge base.
 */
describe("isRenderableLinkScheme (documentation corpus — see link-scheme-allowlist.test.ts)", () => {
  it.each([
    "ms-msdt:/id",
    "ms-appinstaller:?source=http://evil/x.msix",
    "search-ms:crumb=location:\\\\evil.com\\share",
    "view-source:http://evil",
    "itms-services://?url=http://evil",
    "tel:+15551234",
    "ftps://example.com/x",
  ])("refuses %j, which Tiptap's defaultValidate accepts", (href) => {
    expect(isRenderableLinkScheme(href)).toBe(false);
  });

  it.each(SAFE_EXTERNAL_PREFIXES)("keeps the allowlisted prefix %s", (prefix) => {
    expect(isRenderableLinkScheme(`${prefix}example.com/x`)).toBe(true);
  });

  it.each([
    "2024:plan.md",
    ".hidden:note.md",
    "12:30 notes.md",
    "user@host:x",
    "ms_msdt:x",
  ])("keeps %j — a colon is not a scheme, and these opened files", (href) => {
    // The rule cuts both ways. An earlier draft used `hasSchemePrefix` (a `:`
    // before the first `/`, `#` or `?`) as the scheme test, which called every
    // row here scheme-bearing and blanked it — while each in fact resolves as a
    // relative path under the real URL parser, and the ones naming a linkable
    // file reached `openServerPath`. Clause 2 is the WHATWG scheme grammar for
    // exactly this reason.
    expect(new URL(href, "http://localhost:5173/doc/a.md").protocol).toBe("http:");
    expect(isRenderableLinkScheme(href)).toBe(true);
  });

  it("does not judge schemeless hrefs — that is the other predicates' half", () => {
    // Contrast with `isSchemelessPathHref` directly above: that one rejects a
    // backslash form, this one has no opinion about it. The union needs both.
    expect(isRenderableLinkScheme("docs/spec.md")).toBe(true);
    expect(isRenderableLinkScheme("/\\evil.com/x.md")).toBe(true);
    expect(isSchemelessPathHref("/\\evil.com/x.md")).toBe(false);
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
