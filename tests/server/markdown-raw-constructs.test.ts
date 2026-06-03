/**
 * Raw-construct passthrough mapping + coordinate-safety (#981 / ADR-042).
 *
 * Footnotes, reference-style links/definitions, inline HTML, and nested inline
 * images are stored as verbatim markdown source (inline `rawMarkdown` mark or
 * `markdownRaw` paragraph) and re-emitted as mdast `html` nodes on save.
 *
 * The load-bearing CRDT invariant: storing raw source as real TEXT/marks (never
 * embeds) keeps flat text offsets — the annotation coordinate system — aligned.
 * The strongest assertion is that `extractText()` is byte-identical before and
 * after a round-trip, which makes EVERY annotation `from`/`to` offset stable.
 */

import { afterEach, describe, expect, it } from "vitest";
import * as Y from "yjs";
import { loadMarkdown, saveMarkdown } from "../../src/server/file-io/markdown.js";
import { extractText } from "../../src/server/mcp/document-model.js";

const docs: Y.Doc[] = [];
afterEach(() => {
  for (const d of docs.splice(0)) d.destroy();
});

function load(input: string): Y.Doc {
  const d = new Y.Doc();
  loadMarkdown(d, input);
  docs.push(d);
  return d;
}

/** Flat text + on-disk output for `input`, and the flat text after one more open. */
function roundTripFlat(input: string): { flat1: string; flat2: string; out: string } {
  const d1 = load(input);
  const flat1 = extractText(d1);
  const out = saveMarkdown(d1);
  const d2 = load(out);
  const flat2 = extractText(d2);
  return { flat1, flat2, out };
}

/** Top-level fragment children with the markdownRaw attribute set. */
function rawBlockCount(doc: Y.Doc): number {
  const frag = doc.getXmlFragment("default");
  let n = 0;
  for (let i = 0; i < frag.length; i++) {
    const el = frag.get(i);
    if (el instanceof Y.XmlElement && el.getAttribute("markdownRaw")) n++;
  }
  return n;
}

describe("raw-construct forward/reverse mapping", () => {
  it("footnote definition becomes a markdownRaw paragraph and re-emits verbatim", () => {
    const doc = load("ref[^1] here.\n\n[^1]: the body\n");
    // One raw block (the definition). The reference is an inline raw run, not a block.
    expect(rawBlockCount(doc)).toBe(1);
    const out = saveMarkdown(doc);
    expect(out).toContain("ref[^1] here.");
    expect(out).toContain("[^1]: the body");
  });

  it("reference definition becomes a markdownRaw paragraph", () => {
    const doc = load("See [x][ref].\n\n[ref]: https://e.com\n");
    expect(rawBlockCount(doc)).toBe(1);
    expect(saveMarkdown(doc)).toContain("[ref]: https://e.com");
  });

  it("two consecutive footnote refs are not merged", () => {
    expect(roundTripFlat("a[^1][^2] b.\n\n[^1]: x\n\n[^2]: y\n").out).toContain("a[^1][^2] b.");
  });

  it("inline HTML is preserved per-node with prose between tags as real text", () => {
    const { out } = roundTripFlat("A <span>word</span> here.\n");
    expect(out).toContain("A <span>word</span> here.");
  });

  // Regression (crdt review): an image nested INSIDE a mark must stay wrapped in
  // that mark on save, so it never becomes a bare paragraph-child image that the
  // #153 splitter would promote to a block image on reload (collapsing the inline
  // run's flat length and desyncing offsets). Must be flat-stable AND idempotent.
  it("inline image nested in a mark stays inline and idempotent", () => {
    for (const input of [
      "A **bold ![alt](http://e.com/i.png) end** here.\n",
      "A *italic ![alt](http://e.com/i.png) end* here.\n",
      "A [see ![alt](http://e.com/i.png) link](http://x.com) here.\n",
    ]) {
      const { flat1, flat2, out } = roundTripFlat(input);
      expect(flat2).toBe(flat1);
      expect(out).toContain("![alt](http://e.com/i.png)");
      // Second round-trip is a no-op (no late block-promotion on reload).
      expect(saveMarkdown(load(out))).toBe(out);
    }
  });
});

describe("coordinate safety — flat text is stable across round-trip", () => {
  // If extractText() is byte-identical before/after, every annotation offset is
  // preserved. Run it for each placement the raw run can take.
  for (const [name, input] of [
    ["inline footnote ref in a paragraph", "Intro ref[^1] tail.\n\n[^1]: body\n"],
    ["inline raw inside a list item", "- item with ref[^1] inside\n\n[^1]: body\n"],
    ["inline raw inside a table cell", "| H |\n| - |\n| c[^1] |\n\n[^1]: body\n"],
    ["block raw between paragraphs", "Before.\n\n[^1]: def body\n\nAfter ref[^1].\n"],
    ["inline HTML around prose", "Lead <em>x</em> trail.\n"],
  ] as const) {
    it(name, () => {
      const { flat1, flat2 } = roundTripFlat(input);
      expect(flat2).toBe(flat1);
    });
  }

  it("slice(from,to) around an inline raw run is byte-stable", () => {
    const input = "Intro ref[^1] tail.\n\n[^1]: body\n";
    const { flat1, flat2 } = roundTripFlat(input);
    const from = flat1.indexOf("ref");
    const to = flat1.indexOf("tail") + "tail".length;
    expect(from).toBeGreaterThanOrEqual(0);
    // The slice spans across the raw `[^1]` run; it must be identical post-round-trip.
    expect(flat2.slice(from, to)).toBe(flat1.slice(from, to));
    expect(flat1.slice(from, to)).toContain("[^1]");
  });

  it("trailing paragraph offset is past the block-raw content + separators", () => {
    const doc = load("Top.\n\n[^1]: a raw footnote def\n\nTrailing ANCHOR.\n");
    const flat = extractText(doc);
    const rawIdx = flat.indexOf("[^1]: a raw footnote def");
    const anchorIdx = flat.indexOf("ANCHOR");
    expect(rawIdx).toBeGreaterThan(-1);
    expect(anchorIdx).toBeGreaterThan(rawIdx);
    // Exactly one inter-block separator after the raw block — no DOUBLED newline,
    // which would mean a stray trailing "\n" leaked inside the block's XmlText
    // (the `.trimEnd()` in serializeMdastBlock prevents this).
    expect(flat).not.toContain("raw footnote def\n\n");
  });
});
