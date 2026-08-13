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
  ])("already accepted %j before #1377", (href) => {
    expect(tiptapDefaultIsAllowedUri(href, [])).toBeTruthy();
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
