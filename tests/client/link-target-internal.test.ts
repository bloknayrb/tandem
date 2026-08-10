/**
 * `target="_blank"` is stripped from non-external links (#1343).
 *
 * The reported defect: clicking a link to a local `.md` opened it as a Tandem
 * tab AND popped the system browser. `handleEditorClick` preventDefaults every
 * non-fragment anchor and routes it through `openHref`, but WebView2 treats a
 * `_blank` anchor as a new-window request of its own, and no `on_new_window`
 * handler is registered — so it reaches the OS regardless of preventDefault.
 *
 * Renders through the production `buildSchemaExtensions()`, so this asserts on
 * the markup the real editor emits rather than on a hand-built extension.
 */

import { Editor } from "@tiptap/core";
import { afterEach, describe, expect, it } from "vitest";
import { buildSchemaExtensions } from "../../src/client/editor/editor-extensions";

let open: { editor: Editor; container: HTMLDivElement } | null = null;

/**
 * Render a link by applying the `link` MARK, not by parsing an `<a>`.
 *
 * This mirrors how links in a `.md` actually arrive: `mdast-ydoc.ts` builds the
 * mark directly from the mdast `link` node. Going through `content: "<a …>"`
 * instead would route via Tiptap's `parseHTML`, whose `isAllowedUri` drops a
 * bare relative href like `subdir/file.txt` outright — so that path renders no
 * anchor at all and an absence-assertion on `target` would pass vacuously.
 * `renderHTML`, which is what this file tests, runs either way.
 */
function renderLink(href: string): HTMLAnchorElement | null {
  const container = document.createElement("div");
  document.body.appendChild(container);
  const editor = new Editor({
    element: container,
    extensions: buildSchemaExtensions(),
    content: "<p>link text</p>",
  });
  open = { editor, container };

  const { state, view } = editor;
  const linkType = state.schema.marks.link;
  if (!linkType) throw new Error("the link mark is missing from the production schema");
  const from = 1;
  const to = state.doc.content.size - 1;
  view.dispatch(state.tr.addMark(from, to, linkType.create({ href })));

  return container.querySelector("a");
}

afterEach(() => {
  open?.editor.destroy();
  open?.container.remove();
  open = null;
});

describe("link target attribute", () => {
  // NOTE: a bare relative href with a subdirectory (`subdir/file.md`) is
  // absent from this list on purpose — Tiptap's own `isAllowedUri` blanks it
  // to `href=""` before our `renderHTML` post-processing runs, so it renders
  // as a dead link and an assertion here would be about that bug, not this
  // one. Filed separately; `./sub/file.md` and `/sub/file.md` are unaffected.
  it.each([
    ["./notes.md", "a sibling markdown file"],
    ["../docs/spec.md", "a parent-relative markdown file"],
    ["./subdir/file.txt", "an explicitly-relative nested path"],
    ["/abs/path.md", "a root-relative path"],
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
  ])("keeps target=_blank on the external href %s", (href) => {
    // Deliberate, not incidental: the attribute is redundant while the click
    // intercept works, but if the intercept ever fails to run it degrades to
    // "opens a new tab" rather than navigating the editor frame away and
    // taking the session with it.
    const anchor = renderLink(href);
    expect(anchor?.getAttribute("target")).toBe("_blank");
  });

  it("still carries rel and the hover title on an internal link", () => {
    // Positive control on the same sample: proves the anchor really went
    // through LinkWithHoverTitle's post-processing rather than failing to
    // render a link at all, which would satisfy the absence-assertions above.
    const anchor = renderLink("./notes.md");
    expect(anchor?.getAttribute("rel")).toBe("noopener noreferrer");
    expect(anchor?.getAttribute("title")).toBe("./notes.md");
  });
});
