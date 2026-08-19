/**
 * The link mark's render-time contract, asserted through the PRODUCTION
 * `buildSchemaExtensions()` so it cannot drift from a hand-built extension.
 *
 * Three things live here:
 *
 * 1. `target="_blank"` is stripped from non-external links (#1343). The
 *    reported defect: clicking a link to a local `.md` opened it as a Tandem
 *    tab AND popped the system browser. `handleEditorClick` preventDefaults
 *    every non-fragment anchor and routes it through `openHref`, but WebView2
 *    treats a `_blank` anchor as a new-window request of its own, and no
 *    `on_new_window` handler is registered — so it reaches the OS regardless of
 *    preventDefault.
 *
 * 2. Bare relative hrefs with a subdirectory render live (#1377) — `href` AND
 *    the hover `title` from #996, which the blanked href also suppressed.
 *
 * 3. The render-time SCHEME GUARD itself: the configured `isAllowedUri` union,
 *    exercised through both rendering entry points, plus the `setLink` command
 *    surface and the `shouldAutoLink` autolink pin. These are the detectors for
 *    a `@tiptap/extension-link` upgrade that moves `defaultValidate` in either
 *    direction, and they deliberately read the CONFIGURED options off the real
 *    schema rather than re-deriving the union.
 */

import { Editor } from "@tiptap/core";
import { isAllowedUri as tiptapDefaultIsAllowedUri } from "@tiptap/extension-link";
import { afterEach, describe, expect, it } from "vitest";
import { buildSchemaExtensions } from "../../src/client/editor/editor-extensions";
import { isSafeExternalHref } from "../../src/client/editor/utils/url-safety";

let open: { editor: Editor; container: HTMLDivElement } | null = null;

function mountEditor(content: string): Editor {
  const container = document.createElement("div");
  document.body.appendChild(container);
  const editor = new Editor({
    element: container,
    extensions: buildSchemaExtensions(),
    content,
  });
  open = { editor, container };
  return editor;
}

/**
 * Render a link by applying the `link` MARK, not by parsing an `<a>`.
 *
 * This mirrors how links in a `.md` actually arrive: `mdast-ydoc.ts` builds the
 * mark directly from the mdast `link` node, so this is the entry point that
 * matters for a document loaded from disk. Since #1377 the `parseHTML` path
 * accepts the same set, so it is no longer a strictly narrower surface —
 * `renderLinkFromHtml` below covers it explicitly.
 */
function renderLink(href: string): HTMLAnchorElement | null {
  const editor = mountEditor("<p>link text</p>");
  const { state, view } = editor;
  const linkType = state.schema.marks.link;
  if (!linkType) throw new Error("the link mark is missing from the production schema");
  const from = 1;
  const to = state.doc.content.size - 1;
  view.dispatch(state.tr.addMark(from, to, linkType.create({ href })));

  return open?.container.querySelector("a") ?? null;
}

/**
 * Render a link by PARSING an `<a href=…>`, exercising Tiptap's `parseHTML`
 * getAttrs guard — a second surface the configured `isAllowedUri` governs and
 * the mark path structurally bypasses.
 */
function renderLinkFromHtml(href: string): { anchor: HTMLAnchorElement | null; html: string } {
  // Escape only what would break out of the attribute — the href itself must
  // reach the parser byte-for-byte, since the guard is what's under test.
  const escaped = href.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/"/g, "&quot;");
  const editor = mountEditor(`<p><a href="${escaped}">link text</a></p>`);
  return { anchor: open?.container.querySelector("a") ?? null, html: editor.getHTML() };
}

/** The `link` extension's CONFIGURED options, read off the production schema. */
function linkOptions(editor: Editor): Record<string, unknown> {
  const ext = editor.extensionManager.extensions.find((e) => e.name === "link");
  if (!ext) throw new Error("the link extension is missing from the production schema");
  return ext.options as Record<string, unknown>;
}

/**
 * Schemes that must never survive to a live `href`. `java\tscript:` is the
 * tab-obfuscated form — browsers strip TAB before parsing, so `new URL` really
 * does resolve it to a `javascript:` URL.
 */
const DISALLOWED_SCHEME_HREFS = [
  "javascript:alert(1)",
  "JavaScript:alert(1)",
  "data:text/html,<script>alert(1)</script>",
  "vbscript:msgbox",
  "file:///etc/passwd",
  "blob:https://example.com/uuid",
  "filesystem:http://example.com/temporary/x",
  "java\tscript:alert(1)",
  "java script:alert(1)",
  "\tjavascript:alert(1)",
];

afterEach(() => {
  open?.editor.destroy();
  open?.container.remove();
  open = null;
});

describe("link target attribute", () => {
  it.each([
    ["./notes.md", "a sibling markdown file"],
    ["../docs/spec.md", "a parent-relative markdown file"],
    ["./subdir/file.txt", "an explicitly-relative nested path"],
    ["/abs/path.md", "a root-relative path"],
    ["notes.md", "a bare sibling file"],
    // #1377: bare paths carrying a `/`. Tiptap's default guard blanked these to
    // `href=""` before our renderHTML post-processing ran, so they rendered as
    // dead links. (`notes.md` above is NOT one of them — it has no separator,
    // `defaultValidate` always accepted it, and it is here as a control.)
    ["docs/spec.md", "a bare relative path with a subdirectory"],
    ["a/b.md", "a bare two-segment path"],
    ["subdir/file.md#frag", "a bare nested path with a fragment"],
    // The vendored regex carries the `i` flag, so its `[^a-z]` branch does not
    // rescue an uppercase initial — measured `defaultValidate` = false.
    ["Docs/spec.md", "a bare nested path with a capital initial"],
  ])("does not set target=_blank on %s (%s)", (href) => {
    const anchor = renderLink(href);
    expect(anchor, "no anchor rendered").toBeTruthy();
    expect(anchor?.getAttribute("href")).toBe(href);
    expect(anchor?.hasAttribute("target")).toBe(false);
  });

  it.each([
    "https://example.com/page",
    "http://example.com/page",
    "mailto:someone@example.com",
    // Pins `isSafeExternalHref`'s protocol-relative entry (`//` is in
    // SAFE_EXTERNAL_PREFIXES) — explicitly NOT the `isSchemelessPathHref` `//`
    // carve-out, which is unobservable here: `defaultValidate("//…")` is
    // already true, so the union short-circuits on its first half. That
    // carve-out's guard is the reject row in url-safety.test.ts.
    "//example.com/page",
  ])("keeps target=_blank on the external href %s", (href) => {
    // Deliberate, not incidental: the attribute is redundant while the click
    // intercept works, but if the intercept ever fails to run it degrades to
    // "opens a new tab" rather than navigating the editor frame away and
    // taking the session with it.
    const anchor = renderLink(href);
    expect(anchor?.getAttribute("target")).toBe("_blank");
  });

  it.each([
    "./notes.md",
    "docs/spec.md",
  ])("still carries rel and the hover title on the internal link %s", (href) => {
    // Positive control: proves the anchor really went through
    // LinkWithHoverTitle's post-processing rather than failing to render a
    // link at all, which would satisfy the absence-assertions above.
    //
    // `docs/spec.md` additionally pins the SECOND symptom of #1377 that the
    // issue body omits: with `href=""` the `attrs.href.length > 0` gate in
    // editor-extensions.ts also suppressed the tooltip, so a href-only fix
    // would pass every other assertion in this file.
    const anchor = renderLink(href);
    expect(anchor?.getAttribute("rel")).toBe("noopener noreferrer");
    expect(anchor?.getAttribute("title")).toBe(href);
  });
});

describe("the premise of #1377 (Tiptap's default guard)", () => {
  // The whole fix rests on `defaultValidate("docs/spec.md")` being FALSE. That
  // is genuinely surprising, and reading the vendored regex to confirm it gives
  // the WRONG answer — the pattern is assembled in a template literal, so the
  // hyphen escape you see is gone before `new RegExp` runs and `.-:` becomes a
  // range. So assert it against the real dependency instead of re-deriving it:
  // if a `@tiptap/extension-link` upgrade widens the default, this row flips
  // and the union above becomes dead weight worth deleting.
  it.each([
    "docs/spec.md",
    "a/b.md",
    "Docs/spec.md",
    "example.com/path",
  ])("rejects %j, which is why the union exists", (href) => {
    expect(tiptapDefaultIsAllowedUri(href, [])).toBeFalsy();
  });

  it.each([
    "notes.md",
    "https://example.com",
    "//example.com/x",
    "#frag",
    // Load-bearing, and asserted only in a comment until now: this is the
    // traversal `relative-link.ts` calls a PRE-EXISTING hole. It differs from
    // the `a/…` variant only in its leading segment, and that is exactly why it
    // survives — a leading `.` hits the guard's `[^a-z]` alternative, while a
    // leading letter dies in `[a-z0-9+.-]+` on the following `/`. If this row
    // ever flips, the "pre-existing" framing is wrong and the claim must move.
    "../../../../..///evil.com/share/x.md",
  ])("already accepted %j before #1377", (href) => {
    expect(tiptapDefaultIsAllowedUri(href, [])).toBeTruthy();
  });

  it("returns a match array, not a boolean — which is why `!!` is load-bearing", () => {
    // `shouldAutoLink` is typed boolean, so `editor-extensions.ts` coerces.
    // A reader who assumes this returns a boolean will "simplify" the `!!`
    // away; this makes that a red test rather than a silent type lie. It is
    // also why the rows above use toBeFalsy/toBeTruthy — `toBe(false)` fails.
    expect(tiptapDefaultIsAllowedUri("notes.md", [])).toBeInstanceOf(Array);
    expect(tiptapDefaultIsAllowedUri("docs/spec.md", [])).toBeNull();
  });
});

describe("render-time scheme guard (the configured isAllowedUri)", () => {
  it.each(DISALLOWED_SCHEME_HREFS)("blanks %j on the mark path", (href) => {
    const anchor = renderLink(href);
    expect(anchor, "no anchor rendered").toBeTruthy();
    expect(anchor?.getAttribute("href")).toBe("");
    expect(anchor?.hasAttribute("title")).toBe(false);
    expect(anchor?.hasAttribute("target")).toBe(false);
  });

  it.each(DISALLOWED_SCHEME_HREFS)("refuses %j on the parseHTML path", (href) => {
    const { anchor, html } = renderLinkFromHtml(href);
    // `getAttrs` returning false drops the mark, so the anchor may not render
    // at all — the correct assertion is the weaker "no anchor, or an anchor
    // with an empty href".
    expect(anchor === null || anchor.getAttribute("href") === "").toBe(true);
    for (const scheme of ["javascript:", "data:", "vbscript:", "file:", "blob:", "filesystem:"]) {
      expect(html.toLowerCase()).not.toContain(scheme);
    }
  });

  it("accepts a bare nested path on the parseHTML path (#1377)", () => {
    // Pasted HTML `<a href="docs/spec.md">` had the mark dropped outright —
    // the same bug wearing a different hat.
    const { anchor } = renderLinkFromHtml("docs/spec.md");
    expect(anchor?.getAttribute("href")).toBe("docs/spec.md");
  });
});

/**
 * The app's own origin, as the editor sees it. Any base URL works — what the
 * property below cares about is only whether an href resolves AWAY from it.
 */
const APP_BASE = "http://127.0.0.1:5173/docs/x.html";
const APP_ORIGIN = new URL(APP_BASE).origin;

/** Where a browser would actually go for this href. `"THROWS"` for unparseable. */
function resolvedOrigin(href: string): string {
  try {
    return new URL(href, APP_BASE).origin;
  } catch {
    return "THROWS";
  }
}

/**
 * Cross-host href spellings, generated as PREFIX × AUTHORITY rather than
 * hand-listed (#1420).
 *
 * A hand-written list of the spellings the implementation was written against
 * proves only self-consistency: the first cut of the render veto ran
 * `rejectUnsafeWindowsPrefix` — which is anchored at index 0 — against the raw
 * string, so a single leading SPACE walked past it while Tiptap's
 * `defaultValidate` still returned true, and a four-row list of the unprefixed
 * spellings went green with the bypass wide open. The cross product is what
 * catches a prefix nobody thought of.
 *
 * The delivery path is file IMPORT, not just paste: remark preserves the space
 * inside a pointy-bracket destination (`[x](< /\evil.com/x.md>)`) and
 * `mdast-ydoc.ts` writes `href: node.url` with no sanitization.
 */
const HOSTILE_PREFIXES = ["", " ", "  ", "\t", "\n", "\r", "\u0000", "\u000B", "\u001F"];
const HOSTILE_AUTHORITIES = [
  "//evil.com/x.md",
  "/\\evil.com/x.md",
  "\\/evil.com/x.md",
  "\\\\evil.com\\share\\x.md",
  // A Word hyperlink to a file share — the shape enterprise `.docx` files
  // actually contain, and Tandem's named NTLM-hash-leak vector.
  "\\\\fileserver\\docs\\spec.docx",
  "\\\\?\\C:\\x.md",
];

/**
 * The corpus is FILTERED BY THE PROPERTY, not by hand: a generated spelling
 * qualifies only if a browser really resolves it off-origin AND the click gate
 * does not sanction it as an external link. That drops the bare `//evil.com/…`
 * row (sanctioned — see the carve-out test below) without a hand-maintained
 * exception list, and it keeps the corpus honest if `new URL` semantics move.
 * `CORPUS_MUST_CONTAIN` below pins it against silently filtering itself empty.
 */
const CROSS_HOST_CANDIDATES: string[] = HOSTILE_PREFIXES.flatMap((prefix) =>
  HOSTILE_AUTHORITIES.map((authority) => prefix + authority),
)
  .concat([
    // Leading whitespace in front of an otherwise-allowlisted external URL.
    // `isSafeExternalHref` does not trim, so the click gate treats this as a
    // relative path while the browser treats it as an external navigation.
    " https://evil.com/x.md",
    "\thttps://evil.com/x.md",
    // A SCHEME moves the authority past index 0, where
    // `rejectUnsafeWindowsPrefix` is anchored — it slices [0,8) and sees
    // `"http:\\e"`, which passes. Special schemes are parsed
    // authority-leniently, so all of these resolve cross-host while
    // `isSafeExternalHref` (a literal `"http://"` test) says false — which
    // strips `target="_blank"` and makes an escaped middle click navigate the
    // EDITOR FRAME rather than open a second tab.
    "http:/\\evil.com/x",
    "https:/evil.com/x",
    "https:/\\evil.com/x",
    "http:\\\\evil.com\\x",
    "http:\\/evil.com/x",
    "HTTP:/\\evil.com/x",
    "ftp:/\\evil.com/x",
  ])
  .filter((href) => resolvedOrigin(href) !== APP_ORIGIN && !isSafeExternalHref(href));

/**
 * Spellings the corpus must still contain. Without this, a filter that stopped
 * matching would empty the corpus and `it.each` would report zero failures —
 * the classic green-because-it-ran-nothing outcome. The second row is the one
 * the first cut of the veto missed: `rejectUnsafeWindowsPrefix` is anchored at
 * index 0, so one leading space walked past it.
 */
const CORPUS_MUST_CONTAIN = [
  "/\\evil.com/x.md",
  " /\\evil.com/x.md",
  "  //evil.com/x.md",
  "\u0000//evil.com/x.md",
  " \\\\evil.com\\share\\x.md",
  "\\\\fileserver\\docs\\spec.docx",
  " https://evil.com/x.md",
  "http:/\\evil.com/x",
  "https:/evil.com/x",
];

/**
 * Hrefs that must KEEP rendering live. These are the rows that catch an
 * over-broad narrowing — reusing `URL_HOSTILE_CHARS` (which contains U+0020)
 * blanks the `a b.md` rows, and "reject any backslash" blanks `docs\spec.md`,
 * which Windows-authored markdown produces and `relative-link.ts` resolves
 * correctly.
 */
const MUST_STAY_LIVE = [
  "docs/spec.md",
  "docs\\spec.md",
  "./spec.md",
  "../docs/spec.md",
  "/abs/spec.md",
  "notes.md",
  "docs/spec.md?x=1",
  "//example.com/x",
  "https://example.com",
  "HTTPS://example.com",
  "https://example.com/a b.md",
  "mailto:a@b.c",
  "ftp://example.com/x",
  // `isSafeExternalHref` accepts this (it starts with `https://`), so `openHref`
  // opens it via `window.open` with `_blank` and `noopener` intact — an ordinary
  // declared external link, not a render/click disagreement. It resolves to
  // `https://evil.com/x`, and that is the SANCTIONED behaviour for an external
  // href; the clause must not over-reach into it.
  "https:///evil.com/x",
];

describe("render-time cross-host veto (#1420)", () => {
  it.each(CORPUS_MUST_CONTAIN)("the generated corpus still contains %j", (href) => {
    expect(CROSS_HOST_CANDIDATES).toContain(href);
  });

  // THE INVARIANT, stated as an observable property rather than as a list:
  // nothing that resolves off the app's origin may render as a live link,
  // unless it is one of the external forms the click gate itself would hand to
  // `window.open`. Derived from `new URL()` + `isSafeExternalHref`, neither of
  // which is the code under test.
  it.each(CROSS_HOST_CANDIDATES)("%j resolves off-origin, so it must not render live", (href) => {
    const anchor = renderLink(href);
    expect(anchor, "no anchor rendered").toBeTruthy();
    expect(anchor?.getAttribute("href")).toBe("");
    expect(anchor?.hasAttribute("title")).toBe(false);
    expect(anchor?.hasAttribute("target")).toBe(false);
  });

  it.each(CROSS_HOST_CANDIDATES)("%j is refused on the parseHTML path too", (href) => {
    const { anchor } = renderLinkFromHtml(href);
    expect(anchor === null || anchor.getAttribute("href") === "").toBe(true);
  });

  it.each(MUST_STAY_LIVE)("%j still renders live", (href) => {
    const anchor = renderLink(href);
    expect(anchor?.getAttribute("href")).toBe(href);
  });

  it("the `//` carve-out is deliberate: it is a FOURTH cross-host spelling", () => {
    // Stated explicitly because the veto's safety argument ("it blanks exactly
    // the prefixes `resolveRelativeLink` refuses") is true only because this
    // one was carved out. It stays live because `openHref` routes it to
    // `window.open` as a declared external link, exactly like `https://`.
    expect(resolvedOrigin("//example.com/x")).not.toBe(APP_ORIGIN);
    expect(isSafeExternalHref("//example.com/x")).toBe(true);
    expect(renderLink("//example.com/x")?.getAttribute("href")).toBe("//example.com/x");
  });

  it("blanks a same-origin NBSP-prefixed authority too (over-rejection is deliberate)", () => {
    // U+00A0 is not stripped by the URL parser, so this resolves SAME-origin and
    // is not part of the cross-host corpus. The veto blanks it anyway, because
    // `trimStart` treats it as leading whitespace. Monotonic toward rejection,
    // and no legitimate href begins with a non-breaking space — pinned so the
    // over-rejection is a decision on the record rather than an accident.
    const href = "\u00A0//evil.com/x.md";
    expect(resolvedOrigin(href)).toBe(APP_ORIGIN);
    expect(renderLink(href)?.getAttribute("href")).toBe("");
  });

  it("does NOT cover bidi overrides — tooltip spoofing is tracked residue, not fixed", () => {
    // U+202E sits outside both char sets. Navigation is safe (it resolves
    // same-origin, percent-encoded), but `LinkWithHoverTitle` mirrors the raw
    // href into `title`, so the tooltip can read as a different host. Pinned so
    // the residue in docs/security.md stays honest rather than drifting.
    const href = "\u202E//evil.com/x.md";
    expect(resolvedOrigin(href)).toBe(APP_ORIGIN);
    expect(renderLink(href)?.getAttribute("href")).toBe(href);
  });
});

describe("command surface (setLink / the Link editor + context menu)", () => {
  // `applyLink` (toolbar/handlers.ts) calls `chain.setLink({href})` from the
  // LinkEditor and the context menu. `tests/client/handlers.test.ts` cannot
  // cover this: it drives a stub editor whose `setLink` is a bare spy.
  it("applies a bare nested path (silently no-opped before #1377)", () => {
    const editor = mountEditor("<p>link text</p>");
    editor.commands.selectAll();
    expect(editor.commands.setLink({ href: "docs/spec.md" })).toBe(true);
  });

  it("refuses a javascript: href", () => {
    const editor = mountEditor("<p>link text</p>");
    editor.commands.selectAll();
    expect(editor.commands.setLink({ href: "javascript:alert(1)" })).toBe(false);
  });
});

describe("autolink pin (shouldAutoLink)", () => {
  // The autolink plugin filters on the RAW TYPED TEXT, not the resolved href,
  // so widening `isAllowedUri` alone would turn on domain-with-path
  // autolinking — writing markdown link syntax into the user's file on a
  // keystroke. `shouldAutoLink` restores the vendored default exactly. Nothing
  // else in any suite would notice this regression.
  it("holds autolink at today's behaviour", () => {
    const editor = mountEditor("<p>x</p>");
    const shouldAutoLink = linkOptions(editor).shouldAutoLink;
    expect(typeof shouldAutoLink).toBe("function");
    const fn = shouldAutoLink as (url: string) => boolean;
    expect(fn("example.com/path")).toBe(false);
    expect(fn("notes.md")).toBe(true);
  });

  it("leaves `protocols` unconfigured, which is what makes the pin's `[]` correct", () => {
    // `shouldAutoLink` passes a literal `[]` for the `protocols` argument
    // because an option literal cannot reach `this.options`. That is only
    // faithful while no custom protocol is configured — this converts the
    // comment saying so into a detector.
    const editor = mountEditor("<p>x</p>");
    expect(linkOptions(editor).protocols).toEqual([]);
  });
});
