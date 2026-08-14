/**
 * Pasted-HTML whitespace normalization (#1448).
 *
 * These exist because the paragraph node declares `whitespace: "pre"`, and that
 * setting silently defeats the paste-level `preserveWhitespace: false` once
 * ProseMirror's parser enters a `<p>` (`prosemirror-model` `wsOptionsFor`, which
 * falls through to `type.whitespace == "pre"` when the parse rule names no
 * preference). Without the normalizer, pretty-printed markup — most web pages,
 * many Word and Google Docs exports — imports its own source indentation as
 * document content.
 *
 * The parser-level assertion at the bottom is the one that matters: it proves
 * the normalizer actually changes what ProseMirror builds, rather than just
 * producing tidier HTML on the way in.
 */

import { DOMParser as PMDOMParser } from "prosemirror-model";
import { describe, expect, it } from "vitest";
import { normalizePastedHtmlWhitespace } from "../../src/client/editor/utils/paste-whitespace.js";
import { productionSchema } from "./editor-roundtrip-harness.js";

describe("normalizePastedHtmlWhitespace", () => {
  it("collapses the indentation of pretty-printed markup", () => {
    const out = normalizePastedHtmlWhitespace("<p>\n  Some text\n  more text\n</p>");
    expect(out).toBe("<p>Some text more text</p>");
  });

  it("leaves a ProseMirror-internal paste completely alone", () => {
    // An internal copy carries whitespace the user actually has in their
    // document — soft wraps they wrote. Collapsing it would lose them.
    const internal = '<div data-pm-slice="1 1 []"><p>first line\nsecond line</p></div>';
    expect(normalizePastedHtmlWhitespace(internal)).toBe(internal);
  });

  it("preserves whitespace inside pre and code", () => {
    const out = normalizePastedHtmlWhitespace("<pre><code>if (x) {\n    y();\n}</code></pre>");
    expect(out).toContain("if (x) {\n    y();\n}");
  });

  it("preserves a pre block nested inside a normalized document", () => {
    const out = normalizePastedHtmlWhitespace(
      "<div>\n  <p>\n  text\n  </p>\n  <pre>a\n  b</pre>\n</div>",
    );
    expect(out).toContain("<p>text</p>");
    expect(out).toContain("a\n  b");
  });

  it("trims at the block boundary, not at an inline wrapper's boundary", () => {
    const out = normalizePastedHtmlWhitespace("<p>\n  <em>emphasized</em> tail\n</p>");
    expect(out).toBe("<p><em>emphasized</em> tail</p>");
  });

  it("keeps a single space between inline siblings", () => {
    const out = normalizePastedHtmlWhitespace("<p><em>one</em>\n<strong>two</strong></p>");
    expect(out).toBe("<p><em>one</em> <strong>two</strong></p>");
  });

  it("returns unparseable input unchanged rather than rewriting it", () => {
    // A clipboard payload we cannot make sense of is one we must not touch.
    expect(normalizePastedHtmlWhitespace("")).toBe("");
  });
});

describe("the normalizer changes what ProseMirror actually builds", () => {
  const PRETTY = "<p>\n  Some text\n  more text\n</p>";

  const parseAsClipboardWould = (html: string) => {
    const holder = document.createElement("div");
    // Mirrors parseFromClipboard for ordinary external HTML: the base flag is
    // false, and the whole point is that the base flag is not enough.
    holder.innerHTML = html;
    return PMDOMParser.fromSchema(productionSchema()).parse(holder, {
      preserveWhitespace: false,
    });
  };

  it("without it, the paragraph imports literal newlines and indentation", () => {
    expect(parseAsClipboardWould(PRETTY).textContent).toBe("\n  Some text\n  more text\n");
  });

  it("with it, the paragraph imports what the browser would have rendered", () => {
    expect(parseAsClipboardWould(normalizePastedHtmlWhitespace(PRETTY)).textContent).toBe(
      "Some text more text",
    );
  });
});
