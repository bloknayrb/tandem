// @vitest-environment happy-dom

/**
 * #1824 item E — no regression test existed for the HTML-paste sanitizer.
 * `tests/client/plain-paste.test.ts` drives `buildPlainTextSlice` (the
 * *plain-text* paste builder) with a bare string against a 3-node toy
 * schema — it never parses HTML, so it proves nothing about sanitization.
 *
 * This drives the real surfaces instead, over the REAL editor schema
 * (`productionSchema()`, same extension list `Editor.svelte` builds):
 *
 * - `Image.configure({ allowBase64: true })` (editor-extensions.ts) means an
 *   image node exists in the schema, so an `onerror` attribute surviving
 *   parse would be a genuine, schema-level finding.
 * - `LinkWithHoverTitle`'s `isAllowedUri` (editor-extensions.ts:380-382) is
 *   documented (`:51`) as a RENDER-time blank (base `renderHTML` emits
 *   `href: ""` for a refused URI). MEASURED HERE, that is true of the
 *   `setLink` command surface, but the vendored `Link` mark's own
 *   `parseHTML().getAttrs` (`@tiptap/extension-link`) calls the SAME
 *   `isAllowedUri` and returns `false` when it fails — which makes the whole
 *   parse rule refuse to match, so a pasted `javascript:` href never becomes
 *   a link mark in the first place. That is a STRONGER guarantee (parse-time
 *   rejection) than the docblock's render-time framing describes for this
 *   surface, so this test pins the layer it actually measured rather than
 *   the one the docblock names — see the PR body.
 *
 * Assertions run against the parsed/serialized MODEL, never the markup
 * string — a string-level `not.toContain` would not distinguish "never
 * parsed" from "parsed but blanked at a later layer" and could pass by
 * accident against a differently-shaped HTML fragment.
 */

import { DOMParser as PMDOMParser } from "prosemirror-model";
import { describe, expect, it } from "vitest";
import { productionSchema } from "./editor-roundtrip-harness.js";

function parseHtml(html: string) {
  const schema = productionSchema();
  const holder = document.createElement("div");
  holder.innerHTML = html;
  const slice = PMDOMParser.fromSchema(schema).parseSlice(holder);
  return { schema, slice };
}

describe("HTML paste sanitizer over the real editor schema (#1824 item E)", () => {
  it("drops onerror off a pasted <img> at parse time (schema-level)", () => {
    const { slice } = parseHtml('<img src="x" onerror="alert(1)">');

    let imageNode: import("prosemirror-model").Node | null = null;
    slice.content.descendants((node) => {
      if (node.type.name === "image") imageNode = node;
    });
    expect(imageNode, "the image node must exist in the parsed slice").not.toBeNull();
    // `attrs` is the schema's own attribute set for the node — `onerror` was
    // never a declared image attribute, so a survival here would mean the
    // schema (or a rogue parseHTML rule) let it through as a real attribute.
    expect(
      Object.keys((imageNode as unknown as { attrs: Record<string, unknown> }).attrs),
    ).not.toContain("onerror");
  });

  it("never applies a link mark for a pasted javascript: href (parse-time rejection)", () => {
    const { slice } = parseHtml('<a href="javascript:alert(1)">click</a>');

    // MEASURED, not the docblock's framing: `Link.parseHTML().getAttrs` calls
    // the same `isAllowedUri` and returns `false` on failure, which makes the
    // whole parse rule refuse to match — no link mark is created at all, so
    // there is no href anywhere in the parsed model to later blank at render
    // time. The text content survives as plain text.
    let sawLinkMark = false;
    slice.content.descendants((node) => {
      if (node.marks.some((m) => m.type.name === "link")) sawLinkMark = true;
    });
    expect(sawLinkMark, "no link mark should exist for a javascript: href").toBe(false);
    expect(slice.content.textBetween(0, slice.content.size)).toContain("click");
  });
});
